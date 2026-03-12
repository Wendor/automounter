import * as fs from 'fs';
import * as path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { VideoInfo, ValidZone } from './types';

const CACHE_VERSION = 3;
const DEV_NULL = process.platform === 'win32' ? 'NUL' : '/dev/null';

interface VisionAIResponse {
    score: number;
    description: string;
    tags: string[];
    timeOfDay: string;
    landscape: string;
    cameraAngle: string;
    motion: string;
    dominantColors: string[];
    motionEstimate: number;
}

interface CacheFile extends VideoInfo {
    _cacheVersion?: number;
    _fileSize?: number;
}

// ─── Combined video metrics (black frames + scene changes) ────────────────────
// Single FFmpeg pass: scaled to 640px, 10fps — much faster than full-res decode.
// On macOS uses VideoToolbox hardware decoding for 4K footage.

interface VideoMetrics {
    blackIntervals: ValidZone[];
    sceneChanges: number[];
}

function analyzeVideoMetrics(filePath: string, duration: number): Promise<VideoMetrics> {
    return new Promise(resolve => {
        const blackIntervals: ValidZone[] = [];
        const sceneChanges: number[]     = [];
        const stderrLines: string[]      = [];

        // Scale to 640px wide + 10fps is more than enough for both analyses.
        // blackdetect runs on all frames; select+showinfo emits scene-change timestamps.
        const vf = [
            'scale=640:-1',
            'fps=fps=3',
            'blackdetect=d=0.1:pic_th=0.90:pix_th=0.10',
            "select='gt(scene,0.3)',showinfo",
        ].join(',');

        // hwaccel videotoolbox на macOS критически важен для 4K: GPU-декодинг
        // в разы быстрее CPU-декодинга даже с последующим GPU→CPU переносом кадров.
        const hwaccel = process.platform === 'darwin'
            ? ['-hwaccel', 'videotoolbox']
            : [];

        ffmpeg(filePath)
            .inputOptions([...hwaccel, '-t', String(Math.min(duration, 600))])
            .outputOptions(['-vf', vf, '-an', '-f', 'null'])
            .on('stderr', (line: string) => stderrLines.push(line))
            .on('end', () => {
                for (const line of stderrLines) {
                    const blackRe = /black_start:([\d.]+)\s+black_end:([\d.]+)/g;
                    const sceneRe = /pts_time:([\d.]+)/g;
                    let m: RegExpExecArray | null;
                    while ((m = blackRe.exec(line)) !== null) {
                        blackIntervals.push({ start: parseFloat(m[1]!), end: parseFloat(m[2]!) });
                    }
                    while ((m = sceneRe.exec(line)) !== null) {
                        sceneChanges.push(parseFloat(m[1]!));
                    }
                }
                resolve({ blackIntervals, sceneChanges });
            })
            .on('error', () => resolve({ blackIntervals: [], sceneChanges: [] }))
            .save(DEV_NULL);
    });
}

function calculateValidZones(duration: number, blackIntervals: ValidZone[] = []): ValidZone[] {
    const margin = duration * 0.15;
    const safeStart = margin;
    const safeEnd = duration - margin;

    if (safeEnd <= safeStart) {
        return [{ start: Math.min(0.5, duration / 3), end: Math.max(duration - 0.5, duration * 0.66) }];
    }

    if (blackIntervals.length === 0) {
        return [{ start: safeStart, end: safeEnd }];
    }

    const zones: ValidZone[] = [];
    let cursor = safeStart;

    for (const black of [...blackIntervals].sort((a, b) => a.start - b.start)) {
        if (black.end <= cursor) continue;
        if (black.start > cursor) {
            zones.push({ start: cursor, end: Math.min(black.start, safeEnd) });
        }
        cursor = Math.max(cursor, black.end);
        if (cursor >= safeEnd) break;
    }

    if (cursor < safeEnd) zones.push({ start: cursor, end: safeEnd });

    const usable = zones.filter(z => z.end - z.start >= 1.0);
    return usable.length > 0 ? usable : [{ start: safeStart, end: safeEnd }];
}

function selectKeyframeTimes(activeZone: ValidZone, sceneChanges: number[], maxFrames = 5): number[] {
    const zoneLen = activeZone.end - activeZone.start;
    const inZone  = sceneChanges.filter(t => t >= activeZone.start && t <= activeZone.end);

    if (inZone.length === 0) {
        return [0.25, 0.50, 0.75].map(p => activeZone.start + zoneLen * p);
    }

    // Include the start-of-zone anchor and up to maxFrames-1 scene change points
    return [activeZone.start, ...inZone].slice(0, maxFrames);
}

// ─── FPS detection ────────────────────────────────────────────────────────────

function parseFps(rFrameRate: string | undefined): number {
    if (!rFrameRate) return 30;
    const [num, den] = rFrameRate.split('/').map(Number);
    if (!num || !den) return 30;
    const fps = num / den;
    return fps > 0 && fps <= 120 ? Math.round(fps * 100) / 100 : 30;
}

// ─── Vision AI ───────────────────────────────────────────────────────────────

function extractKeyframe(videoPath: string, timeInSeconds: number, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .screenshots({
                timestamps: [timeInSeconds],
                filename: path.basename(outputPath),
                folder: path.dirname(outputPath),
                size: '640x?'
            })
            .on('end', () => resolve())
            .on('error', (err: Error) => reject(err));
    });
}

function cleanJSONString(rawStr: string): string {
    const regex = new RegExp('\\x60\\x60\\x60(?:json)?\\s*([\\s\\S]*?)\\s*\\x60\\x60\\x60');
    const match = rawStr.match(regex);
    return match ? match[1] ?? rawStr : rawStr;
}

async function evaluateFrameWithVisionAI(imagePath: string, modelName: string): Promise<VisionAIResponse> {
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');

    const promptText = `You are an expert film colorist and video archivist. Analyze this drone frame in detail.
Return ONLY a valid JSON object with these keys:
"score" (number 1-10, aesthetic quality and cinematic composition),
"description" (string, detailed scene description with mood, 1-2 sentences),
"tags" (array of 3-5 strings: subjects like "river", "bridge", "sunset", "forest"),
"timeOfDay" (string: "morning", "noon", "golden hour", "dusk", "night", "overcast"),
"landscape" (string: "forest", "urban", "water", "mountains", "field", "road", "coast"),
"cameraAngle" (string: "top-down", "horizon", "low-angle", "oblique"),
"motion" (string: "flying forward", "panning left", "static hovering", "tracking", "ascending", "descending"),
"dominantColors" (array of 2-3 hex color codes for dominant palette, e.g. ["#1a3a5c","#f4a261"]),
"motionEstimate" (number 0.0-1.0, estimated movement/dynamics in the frame).
No markdown, no explanations, only JSON.`;

    try {
        const response = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelName, prompt: promptText, images: [base64Image], format: 'json', stream: false, keep_alive: '10m' })
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data: unknown = await response.json();
        if (typeof data === 'object' && data !== null && 'response' in data) {
            const rawText = String((data as Record<string, unknown>).response);
            const parsed  = JSON.parse(cleanJSONString(rawText)) as Record<string, unknown>;

            if ('score' in parsed) {
                return {
                    score:          Number(parsed.score) || 5,
                    description:    String(parsed.description || 'Unknown'),
                    tags:           Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
                    timeOfDay:      String(parsed.timeOfDay || 'Unknown'),
                    landscape:      String(parsed.landscape || 'Unknown'),
                    cameraAngle:    String(parsed.cameraAngle || 'Unknown'),
                    motion:         String(parsed.motion || 'Unknown'),
                    dominantColors: Array.isArray(parsed.dominantColors) ? parsed.dominantColors.map(String) : [],
                    motionEstimate: typeof parsed.motionEstimate === 'number' ? parsed.motionEstimate : 0.5,
                };
            }
        }
    } catch {
        // fall through to defaults
    }

    return { score: 5, description: 'Analysis failed', tags: [], timeOfDay: 'Unknown', landscape: 'Unknown', cameraAngle: 'Unknown', motion: 'Unknown', dominantColors: [], motionEstimate: 0.5 };
}

const MOTION_KEYWORDS: Array<[string, number]> = [
    ['static', 0.1], ['hovering', 0.15], ['panning', 0.35], ['rotating', 0.4],
    ['ascending', 0.45], ['descending', 0.45], ['tracking', 0.65], ['flying', 0.6],
    ['fast', 0.85], ['racing', 0.9],
];

function motionToIntensity(motion: string): number {
    const lower = motion.toLowerCase();
    for (const [kw, val] of MOTION_KEYWORDS) {
        if (lower.includes(kw)) return val;
    }
    return 0.5;
}

// ─── Proxy file lookup ────────────────────────────────────────────────────────
// DJI и некоторые другие камеры кладут рядом .lrf — облегчённую версию видео.
// Используем её для анализа и извлечения кадров; оригинал только для рендера.

function findProxyFile(filePath: string): string | null {
    const proxyPath = filePath.replace(/\.[^.]+$/, '.lrf');
    if (fs.existsSync(proxyPath)) return proxyPath;
    const proxyPathUpper = filePath.replace(/\.[^.]+$/, '.LRF');
    if (fs.existsSync(proxyPathUpper)) return proxyPathUpper;
    return null;
}

// ─── Logging helpers ──────────────────────────────────────────────────────────

function sec(ms: number): string {
    return (ms / 1000).toFixed(1) + 's';
}

function stepLine(label: string, elapsed: string, detail: string): void {
    console.log(`         ${label.padEnd(10)} ${elapsed.padStart(5)}  │  ${detail}`);
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function indexMediaFolder(
    dirPath: string,
    tempDir: string,
    visionModel: string,
    requestedFiles?: string[]
): Promise<VideoInfo[]> {
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    let files = fs.readdirSync(dirPath)
        .filter(f => /\.(mp4|mov)$/i.test(f) && !f.startsWith('.'));

    if (requestedFiles && requestedFiles.length > 0) {
        files = files.filter(f => requestedFiles.includes(f));
    }

    if (files.length === 0) throw new Error('No matching video files found in folder.');

    const total  = files.length;
    const videos: VideoInfo[] = [];
    let   cached = 0;

    for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
        const filename    = files[fileIdx]!;
        const filePath    = path.join(dirPath, filename);
        const metadataPath = `${filePath}.json`;
        const currentSize  = fs.statSync(filePath).size;
        const prefix       = `  [${fileIdx + 1}/${total}]`;

        // ── Cache check ──────────────────────────────────────────────────────
        if (fs.existsSync(metadataPath)) {
            try {
                const cache = JSON.parse(fs.readFileSync(metadataPath).toString()) as CacheFile;
                if (cache._cacheVersion === CACHE_VERSION && cache._fileSize === currentSize) {
                    cached++;
                    console.log(`${prefix} ${filename}  ${cached === 1 ? '' : ''}[cache]`);
                    const { _cacheVersion: _v, _fileSize: _s, ...info } = cache;
                    videos.push(info as VideoInfo);
                    continue;
                }
            } catch { /* fall through */ }
            fs.unlinkSync(metadataPath);
        }

        const fileStart = Date.now();
        console.log(`${prefix} ${filename}`);

        // ── ffprobe ──────────────────────────────────────────────────────────
        let t = Date.now();
        const stats = fs.statSync(filePath);
        const probeData: ffmpeg.FfprobeData = await new Promise((res, rej) => {
            ffmpeg.ffprobe(filePath, (err, data) => err ? rej(err) : res(data));
        });
        const duration    = probeData.format.duration || 0;
        const videoStream = probeData.streams.find(s => s.codec_type === 'video');
        const detectedFps = parseFps(videoStream?.r_frame_rate as string | undefined);
        const resolution  = videoStream ? `${videoStream.width ?? '?'}×${videoStream.height ?? '?'}` : '?';
        const proxyFile = findProxyFile(filePath);
        stepLine('ffprobe', sec(Date.now() - t),
            `${duration.toFixed(1)}s clip  |  ${detectedFps} fps  |  ${resolution}  |  ${(currentSize / 1e6).toFixed(0)} MB${proxyFile ? '  |  proxy ✓' : ''}`);

        // ── Combined analysis: black frames + scene changes (single FFmpeg pass) ─
        // Используем proxy (.lrf) если доступен — намного быстрее для 4K оригиналов.
        t = Date.now();
        const { blackIntervals, sceneChanges } = await analyzeVideoMetrics(proxyFile ?? filePath, duration);
        const validZones = calculateValidZones(duration, blackIntervals);
        const analyzeDetail = blackIntervals.length === 0 && sceneChanges.length === 0
            ? 'no black frames, no scene changes'
            : [
                blackIntervals.length > 0 ? `${blackIntervals.length} black interval(s) → ${validZones.length} valid zone(s)` : 'no black frames',
                sceneChanges.length > 0   ? `${sceneChanges.length} scene changes` : 'no scene changes',
              ].join('  |  ');
        stepLine('analyze', sec(Date.now() - t), analyzeDetail);

        const videoInfo: VideoInfo = {
            id: filename, filePath, duration,
            creationDate: stats.birthtime.toISOString(),
            validZones, fps: detectedFps,
        };

        const activeZone = [...validZones].sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];

        if (activeZone) {
            const timestamps  = selectKeyframeTimes(activeZone, sceneChanges, 5);
            const frameDetail = sceneChanges.length === 0
                ? `no scene changes → ${timestamps.length} evenly-spaced frames`
                : `${sceneChanges.length} scene changes → ${timestamps.length} frames at ${sceneChanges.slice(0, 4).map(s => s.toFixed(1) + 's').join(', ')}${sceneChanges.length > 4 ? '…' : ''}`;
            stepLine('keyframes', '—', frameDetail);

            // ── Keyframe extraction ──────────────────────────────────────────
            t = Date.now();
            const tempImages = timestamps.map((_, i) =>
                path.join(tempDir, `thumb_${filename.replace(/[^a-z0-9]/gi, '_')}_${i}.jpg`)
            );
            await Promise.all(timestamps.map((ts, i) => extractKeyframe(proxyFile ?? filePath, ts, tempImages[i]!)));
            stepLine('extract', sec(Date.now() - t),
                `${timestamps.length} frame(s) at ${timestamps.map(ts => ts.toFixed(1) + 's').join(', ')}`);

            // ── Vision AI — sequential for per-frame progress ────────────────
            const results: VisionAIResponse[] = [];
            for (let i = 0; i < tempImages.length; i++) {
                const imgPath = tempImages[i]!;
                t = Date.now();
                const result = await evaluateFrameWithVisionAI(imgPath, visionModel);
                results.push(result);
                if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
                stepLine(
                    `vision ${i + 1}/${tempImages.length}`,
                    sec(Date.now() - t),
                    `score=${result.score}  ${result.landscape}  ${result.timeOfDay}  ${result.motion}`
                );
            }

            // ── Aggregate ────────────────────────────────────────────────────
            const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length;
            const best     = results.reduce((a, b) => a.score > b.score ? a : b);
            const bestIdx  = results.indexOf(best);
            const bestTime = timestamps[bestIdx] ?? timestamps[Math.floor(timestamps.length / 2)] ?? activeZone.start;

            videoInfo.aestheticScore       = avgScore;
            videoInfo.description          = best.description;
            videoInfo.tags                 = [...new Set(results.flatMap(r => r.tags))];
            videoInfo.timeOfDay            = best.timeOfDay;
            videoInfo.landscape            = best.landscape;
            videoInfo.cameraAngle          = best.cameraAngle;
            videoInfo.motion               = best.motion;
            videoInfo.dominantColors       = best.dominantColors;
            videoInfo.motionIntensity      = Math.max(best.motionEstimate, motionToIntensity(best.motion));
            videoInfo.isSlowMotionSuitable = (videoInfo.motionIntensity < 0.4) && (avgScore >= 7);
            videoInfo.bestSegments = [{
                start: Math.max(activeZone.start, bestTime - 3),
                end:   Math.min(activeZone.end,   bestTime + 3),
            }];

            const totalSec = sec(Date.now() - fileStart);
            console.log(`         ${'─'.repeat(52)}`);
            console.log(`         avg score: ${avgScore.toFixed(1)}  │  best: frame ${bestIdx + 1}  │  ${best.landscape}  │  ${best.timeOfDay}  │  total: ${totalSec}`);
            console.log(`         tags: ${videoInfo.tags.slice(0, 6).join(', ')}`);
        }

        const cacheData: CacheFile = { ...videoInfo, _cacheVersion: CACHE_VERSION, _fileSize: currentSize };
        fs.writeFileSync(metadataPath, JSON.stringify(cacheData, null, 2));
        videos.push(videoInfo);
    }

    return videos;
}
