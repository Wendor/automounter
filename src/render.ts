import * as fs from 'fs';
import * as path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { VideoSegment, SliceResult, SegmentEffect, RenderQuality } from './types';

export type RenderProgressCallback = (segmentIndex: number, percent: number) => void;

interface SegmentConcatInfo {
    file: string;
    targetDuration: number;
    transition: 'dissolve' | 'hard';
    transitionDuration: number;
}

// ─── Codec / FPS helpers ──────────────────────────────────────────────────────

function detectVideoCodec(): string {
    return process.platform === 'darwin' ? 'h264_videotoolbox' : 'libx264';
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
        if (count > bestCount) { best = fps; bestCount = count; }
    }
    return best;
}

export function formatLutPathForFFmpeg(absolutePath: string): string {
    return absolutePath.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, '$1\\:');
}

function timemarkToSeconds(timemark: string): number {
    const parts = timemark.split(':');
    const h = parseFloat(parts[0] ?? '0');
    const m = parseFloat(parts[1] ?? '0');
    const s = parseFloat(parts[2] ?? '0');
    return h * 3600 + m * 60 + s;
}

// ─── Per-segment filter ───────────────────────────────────────────────────────

function buildVideoFilter(
    segment: VideoSegment,
    lutFile: string,
    hasLut: boolean,
    videoFadeDuration: number,
    quality: RenderQuality
): string {
    // Масштаб для low-quality (720p) — ставится первым
    const scaleFilter = quality.scale ? `scale=${quality.scale},` : '';

    // Motion blur: blend source frames when speeding up > ~1.5x
    const needsMotionBlur = segment.ptsFactor < 0.65;
    const motionBlur = needsMotionBlur ? 'tmix=frames=3:weights=1 2 1,' : '';

    let vf = `${scaleFilter}${motionBlur}setpts=${segment.ptsFactor}*PTS`;

    if (hasLut) {
        vf += `,lut3d='${formatLutPathForFFmpeg(lutFile)}'`;
    }

    const effect: SegmentEffect = segment.effect;
    const fadeOutStart = Math.max(0, segment.targetDuration - videoFadeDuration);

    switch (effect) {
        case 'fadeIn':   vf += `,fade=t=in:st=0:d=${videoFadeDuration}`; break;
        case 'fadeOut':  vf += `,fade=t=out:st=${fadeOutStart}:d=${videoFadeDuration}`; break;
        case 'flashIn':  vf += `,fade=t=in:st=0:d=${videoFadeDuration}:color=white`; break;
        case 'flashOut': vf += `,fade=t=out:st=${fadeOutStart}:d=${videoFadeDuration}:color=white`; break;
        case 'cut':
        case 'none':
            break;
    }

    return vf;
}

function renderSegment(
    segment: VideoSegment,
    index: number,
    codec: string,
    targetFps: number,
    hasLut: boolean,
    lutFile: string,
    videoFadeDuration: number,
    quality: RenderQuality,
    onProgress?: RenderProgressCallback
): Promise<void> {
    const videoFilter = buildVideoFilter(segment, lutFile, hasLut, videoFadeDuration, quality);

    const outputOpts = [
        '-c:v', codec,
        '-b:v', `${quality.bitrate}M`,
        '-an',
        '-filter:v', videoFilter,
        '-r', String(targetFps),
        // Жёсткий обрез: гарантируем ровно targetDuration на выходе.
        // Без этого setpts+граница кадра даёт дрейф ~1 кадр/сегмент → рассинхрон и freeze.
        '-t', segment.targetDuration.toFixed(6),
    ];
    // preset поддерживается только libx264 (не videotoolbox)
    if (codec === 'libx264') outputOpts.push('-preset', quality.x264preset);

    return new Promise((resolve, reject) => {
        ffmpeg(segment.sourceFile)
            .inputOptions(['-ss', String(segment.startTime), '-t', String(segment.rawDuration)])
            .outputOptions(outputOpts)
            .on('progress', (progress: { timemark?: string }) => {
                if (progress.timemark && segment.rawDuration > 0) {
                    const secs = timemarkToSeconds(progress.timemark);
                    onProgress?.(index, Math.min(99, (secs / segment.rawDuration) * 100));
                }
            })
            .on('end', () => { onProgress?.(index, 100); resolve(); })
            .on('error', (err: Error) => reject(err))
            .save(segment.outputFile);
    });
}

async function renderWithConcurrency(
    segments: VideoSegment[],
    codec: string,
    targetFps: number,
    hasLut: boolean,
    lutFile: string,
    videoFadeDuration: number,
    quality: RenderQuality,
    concurrency: number,
    onProgress?: RenderProgressCallback
): Promise<void> {
    let i = 0;
    const worker = async (): Promise<void> => {
        while (i < segments.length) {
            const idx = i++;
            const seg = segments[idx];
            if (seg) await renderSegment(seg, idx, codec, targetFps, hasLut, lutFile, videoFadeDuration, quality, onProgress);
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
    onProgress?: RenderProgressCallback
): Promise<SliceResult> {
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const codec       = detectVideoCodec();
    const hasLut      = fs.existsSync(lutFile);
    const targetFps   = computeMajorityFps(segments);
    const concurrency = codec === 'h264_videotoolbox' ? 3 : 2;

    if (!hasLut && lutFile) {
        console.log(`  -> LUT not found at "${lutFile}", rendering without color grading.`);
    }

    const generatedFiles = segments.map(s => s.outputFile);
    await renderWithConcurrency(segments, codec, targetFps, hasLut, lutFile, videoFadeDuration, quality, concurrency, onProgress);

    return { files: generatedFiles, totalDuration, targetFps };
}

// ─── Final assembly ───────────────────────────────────────────────────────────

function buildXfadeFiltergraph(
    segments: SegmentConcatInfo[],
    audioInputIndex: number,
    totalDuration: number,
    audioFadeDuration: number
): { filterLines: string[]; actualVideoDuration: number } {
    const n = segments.length;
    const lines: string[] = [];
    // Накапливаем позицию в выходной временной шкале.
    // После каждого xfade видео короче на transitionDuration (перекрытие клипов).
    let outputCursor = 0;

    for (let k = 0; k < n - 1; k++) {
        const seg  = segments[k]!;
        const tDur = seg.transition === 'dissolve' ? seg.transitionDuration : 0.033;

        // offset = момент в выходной шкале, когда начинается переход,
        // т.е. за tDur до конца текущего клипа.
        outputCursor += seg.targetDuration;
        const offset  = outputCursor - tDur;
        // После перекрытия cursor «съедает» tDur у следующего клипа
        outputCursor -= tDur;

        const inA  = k === 0 ? '[0:v]' : `[v${k}]`;
        const inB  = `[${k + 1}:v]`;
        const outV = k < n - 2 ? `[v${k + 1}]` : '[vout]';

        lines.push(`${inA}${inB}xfade=transition=fade:duration=${tDur.toFixed(3)}:offset=${offset.toFixed(3)}${outV}`);
    }
    // Добавляем последний сегмент без перехода
    outputCursor += segments[n - 1]!.targetDuration;
    const actualVideoDuration = outputCursor;

    const audioFadeStart = Math.max(0, actualVideoDuration - audioFadeDuration);
    lines.push(`[${audioInputIndex}:a]afade=t=out:st=${audioFadeStart}:d=${audioFadeDuration}[aout]`);

    return { filterLines: lines, actualVideoDuration };
}

function concatenateHardCuts(
    segmentFiles: string[],
    audioFile: string,
    totalDuration: number,
    audioFadeDuration: number,
    outputFile: string,
    tempDir: string,
    onProgress?: (percent: number) => void
): Promise<void> {
    const listFilePath = path.join(tempDir, 'files_list.txt');
    fs.writeFileSync(listFilePath, segmentFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));

    const audioFadeStart = Math.max(0, totalDuration - audioFadeDuration);

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(listFilePath).inputOptions(['-f', 'concat', '-safe', '0'])
            .input(audioFile)
            .complexFilter([`[1:a]afade=t=out:st=${audioFadeStart}:d=${audioFadeDuration}[aout]`])
            .outputOptions([
                '-map', '0:v:0',
                '-map', '[aout]',
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-b:a', '320k',
                '-t', String(totalDuration)
            ])
            .on('progress', (p: { timemark?: string }) => {
                if (p.timemark && totalDuration > 0) {
                    onProgress?.(Math.min(99, (timemarkToSeconds(p.timemark) / totalDuration) * 100));
                }
            })
            .on('end', () => { onProgress?.(100); resolve(); })
            .on('error', (err: Error) => reject(err))
            .save(outputFile);
    });
}

function concatenateWithXfade(
    segments: SegmentConcatInfo[],
    audioFile: string,
    totalDuration: number,
    audioFadeDuration: number,
    outputFile: string,
    targetFps: number,
    quality: RenderQuality,
    onProgress?: (percent: number) => void
): Promise<void> {
    const n = segments.length;

    if (n === 1 && segments[0]) {
        return concatenateHardCuts([segments[0].file], audioFile, totalDuration, audioFadeDuration, outputFile, path.dirname(segments[0].file), onProgress);
    }

    const { filterLines, actualVideoDuration } = buildXfadeFiltergraph(segments, n, totalDuration, audioFadeDuration);

    return new Promise((resolve, reject) => {
        let cmd = ffmpeg();
        for (const seg of segments) cmd = cmd.input(seg.file);
        cmd = cmd.input(audioFile);

        cmd
            .complexFilter(filterLines)
            .outputOptions([
                '-map', '[vout]',
                '-map', '[aout]',
                '-c:v', 'libx264',
                '-b:v', `${quality.bitrate}M`,
                '-preset', quality.x264preset,
                '-r', String(targetFps),
                '-c:a', 'aac',
                '-b:a', '320k',
                '-t', String(actualVideoDuration),
            ])
            .on('progress', (p: { timemark?: string }) => {
                if (p.timemark && actualVideoDuration > 0) {
                    onProgress?.(Math.min(99, (timemarkToSeconds(p.timemark) / actualVideoDuration) * 100));
                }
            })
            .on('end', () => { onProgress?.(100); resolve(); })
            .on('error', (err: Error) => reject(err))
            .save(outputFile);
    });
}

export function concatenateAndAddMusic(
    segments: SegmentConcatInfo[],
    audioFile: string,
    totalDuration: number,
    audioFadeDuration: number,
    outputFile: string,
    tempDir: string,
    targetFps: number,
    quality: RenderQuality,
    onProgress?: (percent: number) => void
): Promise<void> {
    const hasDissolve = segments.some(s => s.transition === 'dissolve');

    if (!hasDissolve) {
        return concatenateHardCuts(
            segments.map(s => s.file), audioFile,
            totalDuration, audioFadeDuration, outputFile, tempDir, onProgress
        );
    }

    return concatenateWithXfade(
        segments, audioFile, totalDuration, audioFadeDuration, outputFile, targetFps, quality, onProgress
    );
}
