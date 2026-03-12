import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';

import { loadConfig, loadSavedConfig, saveConfig }    from './src/config';
import { promptSetup, drawProgress, clearProgress }   from './src/ui';
import { convertMp3ToWav, analyzeAudio }              from './src/audio';
import { indexMediaFolder }                           from './src/indexer';
import { createDirectorPlan, preFilterFiles }         from './src/director';
import { renderSegments, concatenateAndAddMusic }     from './src/render';
import { AudioAnalysis, VideoInfo, SliceResult }      from './src/types';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stage(n: number, total: number, label: string): void {
    console.log(`[${n}/${total}] ${label}`);
}

function info(msg: string): void {
    console.log(`  ${msg}`);
}

async function detectMedianBitrate(filePaths: string[]): Promise<number> {
    const results = await Promise.all(filePaths.map(fp =>
        new Promise<number>(resolve => {
            ffmpeg.ffprobe(fp, (err, data) => {
                if (err || !data?.format?.bit_rate) { resolve(0); return; }
                resolve(Math.round(Number(data.format.bit_rate) / 1_000_000));
            });
        })
    ));
    const valid = results.filter(b => b > 0).sort((a, b) => a - b);
    if (valid.length === 0) return 50;
    const median = valid[Math.floor(valid.length / 2)]!;
    return Math.min(80, Math.max(25, median));
}

async function checkOllamaAvailable(model: string): Promise<void> {
    let data: unknown;
    try {
        const res = await fetch('http://localhost:11434/api/tags');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Ollama is not reachable: ${msg}\n  Start it with: ollama serve`);
    }

    const modelBase = model.split(':')[0] ?? '';
    const names: string[] = (
        typeof data === 'object' && data !== null && 'models' in data
            ? ((data as Record<string, unknown>).models as Array<{ name: string }> ?? [])
            : []
    ).map(m => m.name);

    if (!names.some(n => n.startsWith(modelBase))) {
        throw new Error(
            `Model "${model}" is not pulled.\n` +
            `  Available: ${names.join(', ') || 'none'}\n` +
            `  Run: ollama pull ${model}`
        );
    }
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

async function runMainPipeline(): Promise<void> {
    const TOTAL = 7;
    const isBatch = !process.stdin.isTTY || process.argv.includes('--batch');

    // ── Config (interactive or batch) ─────────────────────────────────────────
    let config;
    if (isBatch) {
        config = loadConfig();
    } else {
        const saved = loadSavedConfig();
        config = await promptSetup(saved);
        saveConfig(config);
    }

    const runId    = Date.now().toString(36);
    const TEMP_WAV = path.join(os.tmpdir(), `automounter_${runId}.wav`);
    const TEMP_DIR = path.join(os.tmpdir(), `automounter_${runId}`);

    const cleanup = (): void => {
        if (fs.existsSync(TEMP_WAV)) fs.unlinkSync(TEMP_WAV);
        if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    };

    try {
        // ── Stage 1: Audio ─────────────────────────────────────────────────────
        stage(1, TOTAL, 'Analyzing audio');
        await convertMp3ToWav(config.audio, TEMP_WAV);
        const audioAnalysis: AudioAnalysis = analyzeAudio(TEMP_WAV);
        info(`${audioAnalysis.tempo} BPM  |  style: ${audioAnalysis.style}  |  energy: ${(audioAnalysis.energy * 100).toFixed(0)}%  |  ${audioAnalysis.beats.length} beats  |  ${audioAnalysis.drops.length} drops`);

        // ── Stage 2: Scan ──────────────────────────────────────────────────────
        stage(2, TOTAL, 'Scanning input folder');
        const allFiles = fs.readdirSync(config.input)
            .filter(f => /\.(mp4|mov)$/i.test(f) && !f.startsWith('.'));

        if (allFiles.length === 0) throw new Error(`No video files found in: ${config.input}`);
        info(`${allFiles.length} video files found`);

        const basicFilesInfo = allFiles.map(file => ({
            id:   file,
            date: fs.statSync(path.join(config.input, file)).birthtime.toISOString(),
        }));

        // ── Stage 3: Filter ────────────────────────────────────────────────────
        stage(3, TOTAL, 'Checking Ollama + filtering by prompt');
        await checkOllamaAvailable(config.model);
        const requestedFileIds: string[] = await preFilterFiles(config.prompt, basicFilesInfo, config.model);

        if (requestedFileIds.length === 0) {
            throw new Error(
                'No files matched the date range in your prompt.\n' +
                '  Check that the dates match your video file timestamps.'
            );
        }

        // ── Stage 4: Index ─────────────────────────────────────────────────────
        stage(4, TOTAL, `Indexing ${requestedFileIds.length} video(s) with Vision AI`);
        const videos: VideoInfo[] = await indexMediaFolder(
            config.input, TEMP_DIR, config.model, requestedFileIds
        );

        // ── Bitrate: авто-определение по медиане исходников ───────────────────
        if (config.bitrate === 0) {
            const allFilePaths = requestedFileIds.map(f => path.join(config.input, f));
            config.bitrate = await detectMedianBitrate(allFilePaths);
            info(`Auto bitrate: ${config.bitrate} Mbps (median of ${requestedFileIds.length} source files)`);
        }

        // ── Stage 5: Director ──────────────────────────────────────────────────
        stage(5, TOTAL, 'Creating edit plan');
        const plan = await createDirectorPlan(
            config.prompt, videos, audioAnalysis,
            config.duration, TEMP_DIR, config.model
        );

        if (plan.segments.length === 0) throw new Error('Edit plan is empty. Try a different prompt.');
        info(`${plan.segments.length} segments, ${plan.totalDuration.toFixed(1)}s total`);

        // Plan details table
        for (const seg of plan.segments) {
            const speedPct = ((1 / seg.ptsFactor) * 100).toFixed(0);
            const slomoTag = seg.slowMotionFactor < 1.0 ? '  [slow-mo]' : '';
            info(`  ${path.basename(seg.sourceFile).padEnd(24)}  ${seg.effect.padEnd(9)}  ${speedPct.padStart(3)}% speed  ${seg.targetDuration.toFixed(1)}s${slomoTag}`);
        }

        // ── Stage 6: Render ────────────────────────────────────────────────────
        stage(6, TOTAL, `Rendering ${plan.segments.length} segments`);

        const segProgress = new Map<number, number>();
        const total = plan.segments.length;

        const sliceResult: SliceResult = await renderSegments(
            plan.segments, TEMP_DIR, config.lut, 0.5, plan.totalDuration, config.bitrate,
            (segIdx, pct) => {
                segProgress.set(segIdx, pct);
                const overall = [...segProgress.values()].reduce((a, b) => a + b, 0) / total;
                const done    = [...segProgress.values()].filter(p => p >= 100).length;
                drawProgress('', overall, `${done}/${total} done`);
            }
        );
        clearProgress();
        info('All segments rendered.');

        // ── Stage 7: Assemble ──────────────────────────────────────────────────
        stage(7, TOTAL, 'Assembling final video');

        const segmentConcatInfo = plan.segments.map((seg, i) => ({
            file:               sliceResult.files[i] ?? seg.outputFile,
            targetDuration:     seg.targetDuration,
            transition:         seg.transition,
            transitionDuration: seg.transitionDuration,
        }));

        const hasDissolve = segmentConcatInfo.some(s => s.transition === 'dissolve');
        if (hasDissolve) info('Cross-dissolve transitions enabled (xfade)');

        await concatenateAndAddMusic(
            segmentConcatInfo, config.audio,
            sliceResult.totalDuration, 2.0,
            config.output, TEMP_DIR,
            sliceResult.targetFps,
            config.bitrate,
            (pct) => drawProgress('', pct)
        );
        clearProgress();

        cleanup();
        console.log(`\n  Done → ${config.output}\n`);

    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        clearProgress();
        console.error(`\n[Fatal] ${msg}\n`);
        cleanup();
        process.exit(1);
    }
}

// ─── Index-only mode ──────────────────────────────────────────────────────────

async function runIndexOnly(): Promise<void> {
    const args    = process.argv.slice(2);
    const reindex = args.includes('--reindex');

    // Минимальный конфиг: нужны только input и model
    const inputIdx = args.indexOf('--input');
    const modelIdx = args.indexOf('--model');
    const input = (inputIdx !== -1 ? args[inputIdx + 1] : undefined) ?? loadSavedConfig().input ?? '';
    const model = (modelIdx !== -1 ? args[modelIdx + 1] : undefined) ?? loadSavedConfig().model ?? 'llava:13b';

    if (!input) {
        console.error('\n[Fatal] --input is required for --index-only\n');
        process.exit(1);
    }

    if (reindex) {
        const sidecars = fs.readdirSync(input)
            .filter(f => /\.(mp4|mov)\.json$/i.test(f));
        if (sidecars.length > 0) {
            sidecars.forEach(f => fs.unlinkSync(path.join(input, f)));
            console.log(`  Cleared ${sidecars.length} cache file(s).`);
        }
    }

    const TEMP_DIR = path.join(os.tmpdir(), `automounter_idx_${Date.now().toString(36)}`);

    try {
        console.log(`\n  Indexing: ${input}`);
        console.log(`  Model:    ${model}\n`);
        await checkOllamaAvailable(model);
        const videos = await indexMediaFolder(input, TEMP_DIR, model);
        console.log(`\n  Done. ${videos.length} file(s) indexed.\n`);
    } catch (error: unknown) {
        console.error(`\n[Fatal] ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    } finally {
        if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
if (argv.includes('--index-only') || argv.includes('--reindex')) {
    runIndexOnly();
} else {
    runMainPipeline();
}
