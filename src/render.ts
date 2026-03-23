import * as fs from "fs";
import * as path from "path";
import ffmpeg from "fluent-ffmpeg";
import {
  VideoSegment,
  SliceResult,
  RenderQuality,
  Orientation,
} from "./types";
import { formatLutPath, safeDelete } from "./utils";
import { BASE_WIDTH, BASE_HEIGHT, VERTICAL_WIDTH, VERTICAL_HEIGHT, ZOOM_DELTA } from "./constants";

export type RenderProgressCallback = (
  segmentIndex: number,
  percent: number,
) => void;

interface SegmentConcatInfo {
  file: string;
  targetDuration: number;
  transition: "dissolve" | "hard";
  transitionDuration: number;
}

function detectVideoCodec(): string {
  return process.platform === "darwin" ? "h264_videotoolbox" : "libx264";
}

function computeMajorityFps(segments: VideoSegment[]): number {
  const counts = new Map<number, number>();
  for (const seg of segments) {
    const fps = seg.sourceFps;
    counts.set(fps, (counts.get(fps) ?? 0) + 1);
  }
  let best = 30;
  let bestCount = 0;
  for (const [fps, count] of counts) {
    if (count > bestCount) {
      best = fps;
      bestCount = count;
    }
  }
  return best;
}

/** @deprecated Используй formatLutPath из utils.ts */
export const formatLutPathForFFmpeg = formatLutPath;

function timemarkToSeconds(timemark: string): number {
  const parts = timemark.split(":");
  const h = parseFloat(parts[0] ?? "0");
  const m = parseFloat(parts[1] ?? "0");
  const s = parseFloat(parts[2] ?? "0");
  return h * 3600 + m * 60 + s;
}

function buildVideoFilter(
  segment: VideoSegment,
  lutFile: string,
  hasLut: boolean,
  videoFadeDuration: number,
  quality: RenderQuality,
  targetFps: number,
  orientation: Orientation,
): string {
  const outW = orientation === "vertical" ? VERTICAL_WIDTH : BASE_WIDTH;
  const outH = orientation === "vertical" ? VERTICAL_HEIGHT : BASE_HEIGHT;

  const filters: string[] = [];

  // Для вертикального: масштабируем по высоте, обрезаем ширину из центра.
  // Для горизонтального: масштабируем по ширине, обрезаем высоту из центра.
  filters.push(
    `scale=${orientation === "vertical" ? "-2" : outW}:${orientation === "vertical" ? outH : "-2"}` +
    `:force_original_aspect_ratio=increase,crop=${outW}:${outH},setsar=1`,
  );

  const totalFrames = Math.max(1, Math.round(segment.targetDuration * targetFps));

  // Зум через scale:eval=frame + crop с фиксированным выходом.
  // Для вертикального зум идёт по высоте, для горизонтального — по ширине.
  if (segment.zoomEffect === "zoomIn") {
    if (orientation === "vertical") {
      filters.push(
        `scale=w=-2:h='trunc((${outH}+${ZOOM_DELTA}*n/${totalFrames})/2)*2':eval=frame,crop=${outW}:${outH}`,
      );
    } else {
      filters.push(
        `scale=w='trunc((${outW}+${ZOOM_DELTA}*n/${totalFrames})/2)*2':h=-2:eval=frame,crop=${outW}:${outH}`,
      );
    }
  } else if (segment.zoomEffect === "zoomOut") {
    if (orientation === "vertical") {
      filters.push(
        `scale=w=-2:h='trunc((${outH + ZOOM_DELTA}-${ZOOM_DELTA}*n/${totalFrames})/2)*2':eval=frame,crop=${outW}:${outH}`,
      );
    } else {
      filters.push(
        `scale=w='trunc((${outW + ZOOM_DELTA}-${ZOOM_DELTA}*n/${totalFrames})/2)*2':h=-2:eval=frame,crop=${outW}:${outH}`,
      );
    }
  }

  filters.push(`setpts=${segment.ptsFactor}*PTS`);
  if (segment.ptsFactor < 0.65) filters.push("tmix=frames=3:weights=1 2 1");
  if (hasLut) filters.push(`lut3d='${formatLutPath(lutFile)}'`);
  if (segment.eqFilter) filters.push(segment.eqFilter);

  const fadeOutStart = Math.max(0, segment.targetDuration - videoFadeDuration);
  if (segment.entryEffect === "fadeIn")
    filters.push(`fade=t=in:st=0:d=${videoFadeDuration}`);
  else if (segment.entryEffect === "flashIn")
    filters.push(`fade=t=in:st=0:d=${videoFadeDuration}:color=white`);

  if (segment.exitEffect === "fadeOut")
    filters.push(`fade=t=out:st=${fadeOutStart}:d=${videoFadeDuration}`);
  else if (segment.exitEffect === "flashOut")
    filters.push(`fade=t=out:st=${fadeOutStart}:d=${videoFadeDuration}:color=white`);

  filters.push(`scale=${outW}:${outH},setsar=1,format=yuv420p`);
  return filters.join(",");
}

function runFfmpegSegment(
  segment: VideoSegment,
  overrideZoom: "zoomIn" | "zoomOut" | "none",
  codec: string,
  targetFps: number,
  hasLut: boolean,
  lutFile: string,
  videoFadeDuration: number,
  quality: RenderQuality,
  orientation: Orientation,
  onProgress?: RenderProgressCallback,
  index?: number,
): Promise<void> {
  const seg = overrideZoom === segment.zoomEffect
    ? segment
    : { ...segment, zoomEffect: overrideZoom };
  const videoFilter = buildVideoFilter(seg, lutFile, hasLut, videoFadeDuration, quality, targetFps, orientation);
  return new Promise((resolve, reject) => {
    ffmpeg(segment.sourceFile)
      .inputOptions(["-ss", String(segment.startTime), "-t", String(segment.rawDuration)])
      .outputOptions([
        "-c:v", codec,
        "-b:v", `${quality.bitrate || 25}M`,
        "-an",
        "-filter:v", videoFilter,
        "-r", String(targetFps),
        "-t", segment.targetDuration.toFixed(6),
        "-pix_fmt", "yuv420p",
      ])
      .on("progress", (p: any) => {
        if (p.timemark && index !== undefined)
          onProgress?.(index, Math.min(99, (timemarkToSeconds(p.timemark) / segment.rawDuration) * 100));
      })
      .on("end", () => { if (index !== undefined) onProgress?.(index, 100); resolve(); })
      .on("error", (err: Error) => reject(err))
      .save(segment.outputFile);
  });
}

async function renderSegment(
  segment: VideoSegment,
  index: number,
  codec: string,
  targetFps: number,
  hasLut: boolean,
  lutFile: string,
  videoFadeDuration: number,
  quality: RenderQuality,
  orientation: Orientation,
  onProgress?: RenderProgressCallback,
  total?: number,
): Promise<void> {
  if (fs.existsSync(segment.outputFile)) {
    onProgress?.(index, 100);
    return;
  }
  const name = path.basename(segment.sourceFile);
  const speedPct = Math.round((segment.rawDuration / segment.targetDuration) * 100);
  const totalStr = total !== undefined ? `/${total}` : "";
  const fx = [segment.zoomEffect !== "none" ? segment.zoomEffect : "", segment.entryEffect !== "none" ? segment.entryEffect : "", segment.exitEffect !== "none" ? segment.exitEffect : ""].filter(Boolean).join("+") || "none";
  console.log(`  Rendering [${index + 1}${totalStr}] ${name}  ${segment.targetDuration.toFixed(1)}s (speed ${speedPct}%)  ${fx}`);

  try {
    await runFfmpegSegment(segment, segment.zoomEffect, codec, targetFps, hasLut, lutFile, videoFadeDuration, quality, orientation, onProgress, index);
  } catch (err) {
    if (segment.zoomEffect !== "none") {
      console.warn(`  [zoom fallback] ${name}: retry without zoom`);
      safeDelete(segment.outputFile);
      await runFfmpegSegment(segment, "none", codec, targetFps, hasLut, lutFile, videoFadeDuration, quality, orientation, onProgress, index);
    } else {
      throw err;
    }
  }
}

async function renderWithConcurrency(
  segments: VideoSegment[],
  codec: string,
  targetFps: number,
  hasLut: boolean,
  lutFile: string,
  videoFadeDuration: number,
  quality: RenderQuality,
  orientation: Orientation,
  concurrency: number,
  onProgress?: RenderProgressCallback,
): Promise<void> {
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < segments.length) {
      const idx = i++;
      const seg = segments[idx];
      if (seg)
        await renderSegment(
          seg,
          idx,
          codec,
          targetFps,
          hasLut,
          lutFile,
          videoFadeDuration,
          quality,
          orientation,
          onProgress,
          segments.length,
        );
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

export async function renderSegments(
  segments: VideoSegment[],
  tempDir: string,
  lutFile: string,
  videoFadeDuration: number,
  totalDuration: number,
  quality: RenderQuality,
  orientation: Orientation,
  onProgress?: RenderProgressCallback,
): Promise<SliceResult> {
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const codec = detectVideoCodec();
  const hasLut = fs.existsSync(lutFile);
  const targetFps = computeMajorityFps(segments);
  const concurrency = codec === "h264_videotoolbox" ? 3 : 2;
  console.log(`Render: ${orientation} ${orientation === "vertical" ? "1080×1920" : "1920×1080"}`);
  await renderWithConcurrency(
    segments,
    codec,
    targetFps,
    hasLut,
    lutFile,
    videoFadeDuration,
    quality,
    orientation,
    concurrency,
    onProgress,
  );
  return { files: segments.map((s) => s.outputFile), totalDuration, targetFps };
}

function buildXfadeFiltergraph(segments: SegmentConcatInfo[]): {
  filterLines: string[];
  duration: number;
} {
  const lines: string[] = [];
  let cursor = 0;
  for (let k = 0; k < segments.length - 1; k++) {
    const seg = segments[k]!;
    const tDur = seg.transition === "dissolve" ? seg.transitionDuration : 0.033;
    cursor += seg.targetDuration;
    const offset = cursor - tDur;
    cursor -= tDur;
    const inA = k === 0 ? "[0:v]" : `[v${k}]`;
    const inB = `[${k + 1}:v]`;
    const outV = k < segments.length - 2 ? `[v${k + 1}]` : "[vout]";
    lines.push(
      `${inA}${inB}xfade=transition=fade:duration=${tDur.toFixed(3)}:offset=${offset.toFixed(3)}${outV}`,
    );
  }
  cursor += segments[segments.length - 1]!.targetDuration;
  return { filterLines: lines, duration: cursor };
}

async function mergeChunk(
  segments: SegmentConcatInfo[],
  outputFile: string,
  targetFps: number,
  quality: RenderQuality,
): Promise<number> {
  if (segments.length === 1) {
    return new Promise((res, rej) => {
      ffmpeg(segments[0]!.file)
        .outputOptions(["-c:v", "copy", "-an"])
        .on("end", () => res(segments[0]!.targetDuration))
        .on("error", rej)
        .save(outputFile);
    });
  }
  const { filterLines, duration } = buildXfadeFiltergraph(segments);
  return new Promise((resolve, reject) => {
    let cmd = ffmpeg();
    for (const s of segments) cmd = cmd.input(s.file);
    cmd
      .complexFilter(filterLines)
      .outputOptions([
        "-map",
        "[vout]",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-r",
        String(targetFps),
        "-pix_fmt",
        "yuv420p",
        "-max_muxing_queue_size",
        "1024",
        "-an",
      ])
      .on("end", () => resolve(duration))
      .on("error", (err) => {
        console.error(`Chunk Merge Error: ${err.message}`);
        reject(err);
      })
      .save(outputFile);
  });
}

export async function concatenateAndAddMusic(
  segments: SegmentConcatInfo[],
  audioFile: string,
  totalDuration: number,
  audioFadeDuration: number,
  outputFile: string,
  tempDir: string,
  targetFps: number,
  quality: RenderQuality,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const CHUNK_SIZE = 4;
  const chunks: string[] = [];
  const chunkDurations: number[] = [];
  for (let i = 0; i < segments.length; i += CHUNK_SIZE) {
    const slice = segments.slice(i, i + CHUNK_SIZE);
    const chunkPath = path.join(tempDir, `chunk_${chunks.length}.mp4`);
    safeDelete(chunkPath);
    console.log(
      `  -> Assembling chunk ${chunks.length + 1}/${Math.ceil(segments.length / CHUNK_SIZE)}...`,
    );
    const dur = await mergeChunk(slice, chunkPath, targetFps, quality);
    chunks.push(chunkPath);
    chunkDurations.push(dur);
    onProgress?.(Math.min(50, (i / segments.length) * 50));
  }

  const listFile = path.join(tempDir, "chunks_list.txt");
  fs.writeFileSync(
    listFile,
    chunks.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n"),
  );
  const finalVideoDur = chunkDurations.reduce((a, b) => a + b, 0);
  const audioFadeStart = Math.max(0, finalVideoDur - audioFadeDuration);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .input(audioFile)
      .complexFilter([
        `[1:a]afade=t=out:st=${audioFadeStart}:d=${audioFadeDuration}[aout]`,
      ])
      .outputOptions([
        "-map",
        "0:v:0",
        "-map",
        "[aout]",
        "-c:v",
        "libx264",
        "-b:v",
        `${quality.bitrate || 25}M`,
        "-preset",
        quality.x264preset,
        "-r",
        String(targetFps),
        "-c:a",
        "aac",
        "-b:a",
        "320k",
        "-t",
        String(finalVideoDur),
        "-pix_fmt",
        "yuv420p",
      ])
      .on("progress", (p: any) => {
        if (p.timemark)
          onProgress?.(
            50 +
              Math.min(
                49,
                (timemarkToSeconds(p.timemark) / finalVideoDur) * 50,
              ),
          );
      })
      .on("end", () => resolve())
      .on("error", reject)
      .save(outputFile);
  });
}
