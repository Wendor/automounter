import { execFile, spawn } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";

const execFileAsync = promisify(execFile);
const FFMPEG = ffmpegInstaller.path;
const FFPROBE = ffprobeInstaller.path;

const EVAL_RES = 64;
const MAX_SOURCE_VIDEOS = 8;

const hwaccelArgs: string[] =
  process.platform === "darwin" ? ["-hwaccel", "videotoolbox"] : [];

// ─── Публичные типы ───────────────────────────────────────────────────────────

export interface FFmpegColorSettings {
  contrast: number;
  brightness: number;
  saturation: number;
  gamma: number;
}

export function eqFilterString(s: FFmpegColorSettings): string {
  return `eq=contrast=${s.contrast.toFixed(3)}:brightness=${s.brightness.toFixed(3)}:saturation=${s.saturation.toFixed(3)}:gamma=${s.gamma.toFixed(3)}`;
}

// ─── Математическое ядро ─────────────────────────────────────────────────────

function applyEq(
  r: number,
  g: number,
  b: number,
  s: FFmpegColorSettings,
): [number, number, number] {
  let rn = r / 255,
    gn = g / 255,
    bn = b / 255;
  rn = (rn - 0.5) * s.contrast + 0.5 + s.brightness;
  gn = (gn - 0.5) * s.contrast + 0.5 + s.brightness;
  bn = (bn - 0.5) * s.contrast + 0.5 + s.brightness;
  rn = rn > 0 ? rn ** (1 / s.gamma) : 0;
  gn = gn > 0 ? gn ** (1 / s.gamma) : 0;
  bn = bn > 0 ? bn ** (1 / s.gamma) : 0;
  const luma = 0.299 * rn + 0.587 * gn + 0.114 * bn;
  rn = luma + s.saturation * (rn - luma);
  gn = luma + s.saturation * (gn - luma);
  bn = luma + s.saturation * (bn - luma);
  return [
    Math.max(0, Math.min(255, Math.round(rn * 255))),
    Math.max(0, Math.min(255, Math.round(gn * 255))),
    Math.max(0, Math.min(255, Math.round(bn * 255))),
  ];
}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  let rn = r / 255,
    gn = g / 255,
    bn = b / 255;
  rn = rn > 0.04045 ? ((rn + 0.055) / 1.055) ** 2.4 : rn / 12.92;
  gn = gn > 0.04045 ? ((gn + 0.055) / 1.055) ** 2.4 : gn / 12.92;
  bn = bn > 0.04045 ? ((bn + 0.055) / 1.055) ** 2.4 : bn / 12.92;
  const x = (rn * 0.4124 + gn * 0.3576 + bn * 0.1805) / 0.95047;
  const y = rn * 0.2126 + gn * 0.7152 + bn * 0.0722;
  const z = (rn * 0.0193 + gn * 0.1192 + bn * 0.9505) / 1.08883;
  const f = (v: number) =>
    v > 0.008856 ? v ** (1 / 3) : 7.787 * v + 16 / 116;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function deltaE(
  lab1: [number, number, number],
  lab2: [number, number, number],
  lumaOnly: boolean,
): number {
  const dL = lab1[0] - lab2[0];
  if (lumaOnly) return Math.abs(dL);
  return Math.sqrt(
    dL * dL + (lab1[1] - lab2[1]) ** 2 + (lab1[2] - lab2[2]) ** 2,
  );
}

// Средний L* канал буфера (0–100)
function meanL(buf: Buffer): number {
  const pixels = Math.floor(buf.length / 3);
  let sum = 0;
  for (let i = 0; i < pixels * 3; i += 3) {
    sum += rgbToLab(buf[i]!, buf[i + 1]!, buf[i + 2]!)[0];
  }
  return sum / pixels;
}

// ─── Работа с буферами ────────────────────────────────────────────────────────

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
        const errMsg = stderr.join("").split("\n").filter(Boolean).at(-1) ?? "unknown";
        reject(new Error(`Empty rawvideo output for ${path.basename(imagePath)}: ${errMsg}`));
      } else {
        resolve(buf);
      }
    });
    proc.on("error", reject);
  });
}

function averageBuffers(buffers: Buffer[]): Buffer {
  const valid = buffers.filter((b) => b.length > 0 && b.length % 3 === 0);
  if (valid.length === 0) throw new Error("No valid RGB buffers");
  const len = Math.min(...valid.map((b) => b.length));
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (const b of valid) sum += b[i]!;
    out[i] = Math.round(sum / valid.length);
  }
  return out;
}

// ─── Оптимизатор (Simulated Annealing) ───────────────────────────────────────

type Bounds = { min: number; max: number };

const PARAM_BOUNDS: Record<keyof FFmpegColorSettings, Bounds> = {
  contrast: { min: 0.8, max: 1.2 },
  brightness: { min: -0.15, max: 0.15 },
  saturation: { min: 0.5, max: 1.5 },
  gamma: { min: 0.8, max: 1.2 },
};

function evaluateDelta(
  ref: Buffer,
  src: Buffer,
  s: FFmpegColorSettings,
  lumaOnly: boolean,
): number {
  let total = 0;
  const pixels = Math.floor(ref.length / 3);
  for (let i = 0; i < pixels * 3; i += 3) {
    const [ar, ag, ab] = applyEq(src[i]!, src[i + 1]!, src[i + 2]!, s);
    total += deltaE(
      rgbToLab(ref[i]!, ref[i + 1]!, ref[i + 2]!),
      rgbToLab(ar, ag, ab),
      lumaOnly,
    );
  }
  return total / pixels;
}

function optimizeSettings(
  refBuf: Buffer,
  srcBuf: Buffer,
): FFmpegColorSettings {
  const DEF_BRIGHTNESS = Math.max(
    -0.15,
    Math.min(0.15, (meanL(refBuf) - meanL(srcBuf)) / 100),
  );
  const DEFAULT: FFmpegColorSettings = {
    contrast: 1.0,
    brightness: DEF_BRIGHTNESS,
    saturation: 1.0,
    gamma: 1.0,
  };

  // Если сцены слишком разные по цвету (deltaE > 35) — только яркость/контраст
  const lumaOnly = evaluateDelta(refBuf, srcBuf, DEFAULT, false) > 35;
  const allKeys = Object.keys(DEFAULT) as (keyof FFmpegColorSettings)[];
  const keys = lumaOnly ? allKeys.filter((k) => k !== "saturation") : allKeys;

  let cur = { ...DEFAULT };
  let best = { ...DEFAULT };
  let curCost = evaluateDelta(refBuf, srcBuf, cur, lumaOnly);
  let bestCost = curCost;
  let temp = 100;

  for (let i = 0; i < 2000; i++) {
    const candidate = { ...cur };
    const key = keys[Math.floor(Math.random() * keys.length)]!;
    const b = PARAM_BOUNDS[key];
    candidate[key] = Math.max(
      b.min,
      Math.min(
        b.max,
        candidate[key] +
          (Math.random() - 0.5) * (b.max - b.min) * (temp / 100),
      ),
    );
    const cost = evaluateDelta(refBuf, srcBuf, candidate, lumaOnly);
    if (cost < curCost || Math.random() < Math.exp(-(cost - curCost) / temp)) {
      cur = candidate;
      curCost = cost;
      if (curCost < bestCost) {
        best = { ...cur };
        bestCost = curCost;
      }
    }
    temp *= 0.99;
  }
  return best;
}

// ─── Видео-утилиты ────────────────────────────────────────────────────────────

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

async function extractFrame(
  videoPath: string,
  fraction: number,
  outputPath: string,
): Promise<void> {
  const duration = await getVideoDuration(videoPath);
  await execFileAsync(FFMPEG, [
    ...hwaccelArgs,
    "-ss",
    String(duration * fraction),
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

function formatLutPath(lutPath: string): string {
  return lutPath.replace(/\\/g, "/").replace(/^([a-zA-Z]):/, "$1\\:");
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
 * Анализирует цветовой референс и возвращает параметры eq-фильтра FFmpeg.
 *
 * sourceVideoPaths — уникальные исходники из плана монтажа (все сцены).
 * Из каждого берётся 1 кадр (50%), усредняются — это «средний цвет всего ролика».
 * Оптимизатор ищет коррекцию от этой базы к палитре референса.
 */
export async function analyzeColorReference(
  refVideoPath: string,
  sourceVideoPaths: string[],
  lutFile: string,
  tempDir: string,
  log: (msg: string) => void = console.log,
): Promise<FFmpegColorSettings | null> {
  const id = Date.now().toString(36);
  const tempFiles: string[] = [];

  try {
    // 5 кадров из референса: лучшее покрытие его цветового диапазона
    const refFractions = [0.1, 0.25, 0.5, 0.75, 0.9];
    log(`Extracting ${refFractions.length} reference frames...`);
    const refFrames = await Promise.all(
      refFractions.map(async (frac, i) => {
        const p = path.join(tempDir, `cr_ref_${id}_${i}.jpg`);
        tempFiles.push(p);
        await extractFrame(refVideoPath, frac, p);
        return p;
      }),
    );

    // 1 кадр с каждого исходника (до MAX_SOURCE_VIDEOS)
    const sources = sourceVideoPaths.slice(0, MAX_SOURCE_VIDEOS);
    log(`Sampling ${sources.length} source clip(s)...`);
    const srcFrames = await Promise.all(
      sources.map(async (videoPath, i) => {
        const p = path.join(tempDir, `cr_src_${id}_${i}.jpg`);
        tempFiles.push(p);
        await extractFrame(videoPath, 0.5, p);
        return p;
      }),
    );

    // Применяем LUT к исходникам перед сравнением (если задан)
    let analysisFrames = srcFrames;
    if (lutFile && fs.existsSync(lutFile)) {
      log("Applying LUT to source frames...");
      analysisFrames = await Promise.all(
        srcFrames.map(async (fp, i) => {
          const p = path.join(tempDir, `cr_src_lut_${id}_${i}.jpg`);
          tempFiles.push(p);
          await applyLutToFrame(fp, p, lutFile);
          return p;
        }),
      );
    }

    log("Sampling pixels...");
    const [refBufs, srcBufs] = await Promise.all([
      Promise.all(refFrames.map(extractRgbBuffer)),
      Promise.all(analysisFrames.map(extractRgbBuffer)),
    ]);

    const refBuf = averageBuffers(refBufs);
    const srcBuf = averageBuffers(srcBufs);

    log("Optimizing color parameters (2000 iterations)...");
    const settings = optimizeSettings(refBuf, srcBuf);
    log(
      `Color result: contrast=${settings.contrast.toFixed(2)} brightness=${settings.brightness.toFixed(3)} saturation=${settings.saturation.toFixed(2)} gamma=${settings.gamma.toFixed(2)}`,
    );

    return settings;
  } catch (err) {
    log(
      `Color analysis failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    for (const fp of tempFiles) {
      try {
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      } catch {}
    }
  }
}
