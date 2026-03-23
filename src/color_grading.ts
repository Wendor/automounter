import { execFile, spawn } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import { formatLutPath, safeDelete } from "./utils";
import { EVAL_RES, CHROMA_WEIGHT, CURVE_SAMPLES } from "./constants";

const execFileAsync = promisify(execFile);
const FFMPEG = ffmpegInstaller.path;
const FFPROBE = ffprobeInstaller.path;

// Разрешение кадра для анализа импортируется из constants.ts
const IMAGE_EXTS = /\.(jpe?g|png|webp|tiff?)$/i;
const hwaccelArgs: string[] =
  process.platform === "darwin" ? ["-hwaccel", "videotoolbox"] : [];

// ─── Публичные типы ───────────────────────────────────────────────────────────

interface ChannelStats {
  mean: number;
  std: number;
}

/**
 * Цветовой профиль референса — среднее и стандартное отклонение по RGB.
 * Используется для Reinhard color transfer: линейного выравнивания тона.
 */
export interface ColorProfile {
  rStats: ChannelStats;
  gStats: ChannelStats;
  bStats: ChannelStats;
  pixelCount: number;
}

/**
 * Промежуточный результат анализа одного сегмента — сырые LUT-таблицы.
 * Хранится до сглаживания, чтобы можно было блендить с соседями.
 */
export interface SegmentLUTs {
  r: Uint8Array; // [256] — таблица замены красного канала
  g: Uint8Array; // [256] — зелёного
  b: Uint8Array; // [256] — синего
}

// ─── Работа с пикселями ───────────────────────────────────────────────────────

function extractRgbBuffer(imagePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: string[] = [];
    const proc = spawn(FFMPEG, [
      "-i",
      imagePath,
      "-vf",
      `scale=${EVAL_RES}:${EVAL_RES}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-frames:v",
      "1",
      "pipe:1",
    ]);
    proc.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    proc.on("close", () => {
      const buf = Buffer.concat(stdout);
      if (buf.length === 0) {
        const errMsg =
          stderr.join("").split("\n").filter(Boolean).at(-1) ?? "unknown";
        reject(
          new Error(
            `Empty rawvideo for ${path.basename(imagePath)}: ${errMsg}`,
          ),
        );
      } else {
        resolve(buf);
      }
    });
    proc.on("error", reject);
  });
}

// ─── Статистический анализ (Reinhard color transfer) ─────────────────────────

function computeStats(buffers: Buffer[], offset: number): ChannelStats {
  let sum = 0, sumSq = 0, count = 0;
  for (const buf of buffers) {
    for (let i = offset; i < buf.length; i += 3) {
      const v = buf[i]!;
      sum += v;
      sumSq += v * v;
      count++;
    }
  }
  if (count === 0) return { mean: 128, std: 50 };
  const mean = sum / count;
  const std = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
  return { mean, std };
}

function buildStats(buffers: Buffer[]): ColorProfile {
  let totalPixels = 0;
  for (const buf of buffers) totalPixels += Math.floor(buf.length / 3);
  return {
    rStats: computeStats(buffers, 0),
    gStats: computeStats(buffers, 1),
    bStats: computeStats(buffers, 2),
    pixelCount: totalPixels,
  };
}

/**
 * Reinhard linear LUT: сдвигает mean и масштабирует std источника
 * под референс. Шкала ограничена [0.4..2.5] для полноценного контраста.
 */
function buildReinhardLUT(srcStats: ChannelStats, refStats: ChannelStats): Uint8Array {
  const lut = new Uint8Array(256);
  const scale = srcStats.std > 2
    ? Math.max(0.4, Math.min(2.5, refStats.std / srcStats.std))
    : 1.0;
  for (let v = 0; v < 256; v++) {
    lut[v] = Math.max(0, Math.min(255, Math.round(
      (v - srcStats.mean) * scale + refStats.mean
    )));
  }
  return lut;
}

// Точки семплирования кривой для curves-фильтра FFmpeg импортируются из constants.ts

function lutToCurvePoints(lut: Uint8Array): string {
  return CURVE_SAMPLES.map(
    (v) => `${(v / 255).toFixed(4)}/${(lut[v]! / 255).toFixed(4)}`,
  ).join(" ");
}

// Доля per-channel коррекции vs luma-only импортируется из constants.ts (CHROMA_WEIGHT).

/**
 * Строит SegmentLUTs методом Reinhard color transfer.
 *
 * Алгоритм:
 * 1. Per-channel Reinhard LUT: сдвигает mean, масштабирует std.
 *    Линейный — не создаёт "ядовитых" артефактов CDF-матчинга.
 * 2. Яркостная LUT = перцептивно взвешенное среднее (BT.601).
 *    Нейтрали (серые) остаются серыми.
 * 3. Финал = (1-CHROMA_WEIGHT) luma + CHROMA_WEIGHT per-channel.
 */
function buildSegmentLUTs(srcBufs: Buffer[], refProfile: ColorProfile): SegmentLUTs {
  const src = buildStats(srcBufs);
  const rLUT = buildReinhardLUT(src.rStats, refProfile.rStats);
  const gLUT = buildReinhardLUT(src.gStats, refProfile.gStats);
  const bLUT = buildReinhardLUT(src.bStats, refProfile.bStats);

  // Яркостная LUT: перцептивные веса ITU-R BT.601
  const lumaLUT = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    lumaLUT[i] = Math.round(0.299 * rLUT[i]! + 0.587 * gLUT[i]! + 0.114 * bLUT[i]!);
  }

  // Смешиваем яркостную и per-channel LUT
  const blend = (chLUT: Uint8Array): Uint8Array => {
    const out = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      out[i] = Math.round(
        (1 - CHROMA_WEIGHT) * lumaLUT[i]! + CHROMA_WEIGHT * chLUT[i]!,
      );
    }
    return out;
  };

  return { r: blend(rLUT), g: blend(gLUT), b: blend(bLUT) };
}

/**
 * Конвертирует SegmentLUTs в строку FFmpeg-фильтра `curves`.
 * Вызывается после сглаживания.
 */
export function lutsToFilter(luts: SegmentLUTs): string {
  return `curves=r='${lutToCurvePoints(luts.r)}':g='${lutToCurvePoints(luts.g)}':b='${lutToCurvePoints(luts.b)}'`;
}

/**
 * Сглаживает LUT-таблицы между соседними сегментами, чтобы цветокор
 * не скакал резко на стыках клипов.
 *
 * Каждый сегмент получает взвешенное среднее своей LUT и LUT соседей:
 *   weights = [0.2, 0.6, 0.2] для сегментов [i-1, i, i+1]
 *
 * Null-сегменты (анализ не удался) пропускаются — их вес перераспределяется
 * на оставшихся соседей.
 */
export function smoothLUTs(luts: (SegmentLUTs | null)[]): (SegmentLUTs | null)[] {
  const n = luts.length;
  return luts.map((cur, i) => {
    if (!cur) return null;

    // Гауссово окно радиуса 2: [i-2=0.1, i-1=0.2, i=0.4, i+1=0.2, i+2=0.1]
    const entries: { lut: SegmentLUTs; w: number }[] = [{ lut: cur, w: 0.4 }];
    if (i > 0 && luts[i - 1]) entries.push({ lut: luts[i - 1]!, w: 0.2 });
    if (i < n - 1 && luts[i + 1]) entries.push({ lut: luts[i + 1]!, w: 0.2 });
    if (i > 1 && luts[i - 2]) entries.push({ lut: luts[i - 2]!, w: 0.1 });
    if (i < n - 2 && luts[i + 2]) entries.push({ lut: luts[i + 2]!, w: 0.1 });

    // Нормализуем веса (на случай отсутствующих соседей)
    const totalW = entries.reduce((s, e) => s + e.w, 0);

    const blendChannel = (ch: keyof SegmentLUTs): Uint8Array => {
      const out = new Uint8Array(256);
      for (let v = 0; v < 256; v++) {
        let sum = 0;
        for (const { lut, w } of entries) sum += (w / totalW) * lut[ch][v]!;
        out[v] = Math.round(sum);
      }
      return out;
    };

    return { r: blendChannel("r"), g: blendChannel("g"), b: blendChannel("b") };
  });
}

// ─── Видео и файловые утилиты ────────────────────────────────────────────────

async function getVideoDuration(videoPath: string): Promise<number> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    videoPath,
  ]);
  const d = parseFloat(stdout.trim());
  if (isNaN(d)) throw new Error(`Cannot determine duration: ${videoPath}`);
  return d;
}

async function extractVideoFrame(
  videoPath: string,
  timeSec: number,
  outputPath: string,
): Promise<void> {
  await execFileAsync(FFMPEG, [
    ...hwaccelArgs,
    "-ss",
    String(timeSec),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    "-y",
    outputPath,
  ]);
}


async function applyLutToFrame(
  inputPath: string,
  outputPath: string,
  lutPath: string,
): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-i",
    inputPath,
    "-vf",
    `lut3d='${formatLutPath(lutPath)}'`,
    "-y",
    outputPath,
  ]);
}

// ─── Публичный API ────────────────────────────────────────────────────────────

export async function downloadYouTubeVideo(
  url: string,
  outputPath: string,
): Promise<void> {
  try {
    await execFileAsync("yt-dlp", ["--version"]);
  } catch {
    throw new Error("yt-dlp не установлен. Запустите: brew install yt-dlp");
  }
  await execFileAsync(
    "yt-dlp",
    [
      "-f",
      "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]",
      "--merge-output-format",
      "mp4",
      "-o",
      outputPath,
      "--no-playlist",
      url,
    ],
    { timeout: 5 * 60 * 1000 },
  );
}

/**
 * Строит цветовой профиль (CDF по 3 каналам) из референса.
 * refPath — папка с изображениями ИЛИ путь к видеофайлу.
 *
 * Ключевое отличие от старого подхода: пиксели НЕ усредняются —
 * все пиксели объединяются для точного распределения.
 */
export async function buildColorProfile(
  refPath: string,
  tempDir: string,
  log: (msg: string) => void = console.log,
): Promise<ColorProfile | null> {
  const id = Date.now().toString(36);
  const tempFiles: string[] = [];

  try {
    const isDir =
      fs.existsSync(refPath) && fs.statSync(refPath).isDirectory();

    let imagePaths: string[];

    if (isDir) {
      const images = fs
        .readdirSync(refPath)
        .filter((f) => IMAGE_EXTS.test(f))
        .map((f) => path.join(refPath, f));
      if (images.length === 0)
        throw new Error(`Нет изображений в папке: ${refPath}`);
      log(`Loading ${images.length} reference image(s)...`);
      imagePaths = images;
    } else {
      // Видеофайл — извлекаем 5 кадров равномерно
      const duration = await getVideoDuration(refPath);
      const fractions = [0.1, 0.25, 0.5, 0.75, 0.9];
      log(`Extracting ${fractions.length} frames from reference video...`);
      imagePaths = await Promise.all(
        fractions.map(async (frac, i) => {
          const p = path.join(tempDir, `cr_ref_${id}_${i}.jpg`);
          tempFiles.push(p);
          await extractVideoFrame(refPath, duration * frac, p);
          return p;
        }),
      );
    }

    const bufs = await Promise.all(
      imagePaths.map((p) => extractRgbBuffer(p).catch(() => null)),
    );
    const valid = bufs.filter(Boolean) as Buffer[];
    if (valid.length === 0)
      throw new Error("Не удалось прочитать ни один референсный кадр");

    const profile = buildStats(valid);
    log(
      `Reference profile built from ${valid.length} image(s) (${profile.pixelCount.toLocaleString()} px)`,
    );
    return profile;
  } catch (err) {
    log(
      `buildColorProfile failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    for (const fp of tempFiles) {
      safeDelete(fp);
    }
  }
}

/**
 * Анализирует цвет сегмента и возвращает строку FFmpeg-фильтра `curves`
 * для точного согласования с референсным профилем.
 *
 * Сэмплируем 3 кадра из сегмента (начало, середина, конец) — это даёт
 * репрезентативный срез, особенно важно при смешанных сценах.
 *
 * Гистограммное согласование аналитично (не случайный поиск):
 * результат детерминирован и стабилен между сегментами.
 */
export async function analyzeSegmentColors(
  sourceFile: string,
  startTime: number,
  segmentDuration: number,
  refProfile: ColorProfile,
  lutFile: string,
  tempDir: string,
): Promise<SegmentLUTs | null> {
  const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const tempFiles: string[] = [];

  try {
    // 3 кадра: 15%, 50%, 85% от длительности сегмента
    const offsets = [0.1, 0.25, 0.5, 0.75, 0.9].map((f) =>
      Math.max(0, startTime + segmentDuration * f),
    );

    const srcBufs: Buffer[] = [];

    for (let i = 0; i < offsets.length; i++) {
      const rawFrame = path.join(tempDir, `cr_seg_${id}_${i}.jpg`);
      const lutFrame = path.join(tempDir, `cr_seg_lut_${id}_${i}.jpg`);
      tempFiles.push(rawFrame, lutFrame);

      await extractVideoFrame(sourceFile, offsets[i]!, rawFrame);

      let srcFrame = rawFrame;
      if (lutFile && fs.existsSync(lutFile)) {
        await applyLutToFrame(rawFrame, lutFrame, lutFile);
        srcFrame = lutFrame;
      }

      const buf = await extractRgbBuffer(srcFrame).catch(() => null);
      if (buf) srcBufs.push(buf);
    }

    if (srcBufs.length === 0) return null;

    return buildSegmentLUTs(srcBufs, refProfile);
  } catch {
    return null;
  } finally {
    for (const fp of tempFiles) {
      safeDelete(fp);
    }
  }
}
