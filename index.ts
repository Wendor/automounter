import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';

import { loadConfig, loadSavedConfig, saveConfig }  from './src/config';
import { convertMp3ToWav, analyzeAudio }             from './src/audio';
import { indexMediaFolder }                          from './src/indexer';
import { createDirectorPlan, preFilterFiles }        from './src/director';
import { renderSegments, concatenateAndAddMusic }    from './src/render';
import { showInkUI, showPipelineUI, PipelineCB }    from './src/ui/index';
import {
    AudioAnalysis, VideoInfo, SliceResult,
    RenderQuality, QUALITY_TEMPLATES, RenderSession,
} from './src/types';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

// ─── Console-based callbacks (batch / --batch mode) ───────────────────────────

function makeConsoleCB(): PipelineCB {
    return {
        stage:            (n, t, l) => console.log(`[${n}/${t}] ${l}`),
        info:             (msg)     => console.log(`  ${msg}`),
        renderTick:       (_, __, done, total) => {
            const pct = Math.round(done / total * 100);
            process.stdout.write(`\r  Рендеринг: ${done}/${total}  ${'█'.repeat(Math.round(pct / 5))}${'░'.repeat(20 - Math.round(pct / 5))}  ${pct}%`);
            if (done === total) process.stdout.write('\n');
        },
        assemblyProgress: (pct)    => {
            process.stdout.write(`\r  Сборка: ${'█'.repeat(Math.round(pct / 5))}${'░'.repeat(20 - Math.round(pct / 5))}  ${pct.toFixed(0)}%`);
            if (pct >= 100) process.stdout.write('\n');
        },
        done:             (path)   => console.log(`\n  Готово → ${path}\n`),
        error:            (msg)    => console.error(`\n[Fatal] ${msg}\n`),
        log:              (msg)    => console.log(`  ${msg}`),
    };
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

async function resolveQuality(qualityLevel: string, filePaths: string[]): Promise<RenderQuality> {
    const level = (qualityLevel as keyof typeof QUALITY_TEMPLATES) in QUALITY_TEMPLATES
        ? qualityLevel as keyof typeof QUALITY_TEMPLATES
        : 'medium';
    const template = QUALITY_TEMPLATES[level];
    const bitrate = template.bitrateAuto
        ? await detectMedianBitrate(filePaths)
        : template.bitrate;
    if (template.bitrateAuto) console.log(`  Auto bitrate: ${bitrate} Mbps (медиана по ${filePaths.length} файлам)`);
    return { bitrate, x264preset: template.x264preset, scale: template.scale };
}

async function checkOllamaAvailable(model: string): Promise<void> {
    let data: unknown;
    try {
        const res = await fetch('http://localhost:11434/api/tags');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Ollama недоступен: ${msg}\n  Запусти: ollama serve`);
    }

    const modelBase = model.split(':')[0] ?? '';
    const names: string[] = (
        typeof data === 'object' && data !== null && 'models' in data
            ? ((data as Record<string, unknown>).models as Array<{ name: string }> ?? [])
            : []
    ).map(m => m.name);

    if (!names.some(n => n.startsWith(modelBase))) {
        throw new Error(
            `Модель "${model}" не установлена.\n` +
            `  Доступные: ${names.join(', ') || 'нет'}\n` +
            `  Запусти: ollama pull ${model}`
        );
    }
}

// ─── Основной пайплайн ────────────────────────────────────────────────────────

async function runMainPipeline(
    config: ReturnType<typeof loadConfig>,
    cb: PipelineCB
): Promise<void> {
    const TOTAL = 7;
    const runId    = Date.now().toString(36);
    const TEMP_WAV = path.join(os.tmpdir(), `automounter_${runId}.wav`);
    const TEMP_DIR = path.join(os.tmpdir(), `automounter_${runId}`);

    const cleanup = (): void => {
        if (fs.existsSync(TEMP_WAV)) fs.unlinkSync(TEMP_WAV);
        if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    };

    try {
        cb.stage(1, TOTAL, 'Анализ аудио');
        cb.log('Converting MP3 to WAV...');
        await convertMp3ToWav(config.audio, TEMP_WAV);
        
        cb.log('Analyzing tempo, beats and transients...');
        const audioAnalysis: AudioAnalysis = analyzeAudio(TEMP_WAV);
        cb.info(`${audioAnalysis.tempo} BPM · ${audioAnalysis.style} · ${(audioAnalysis.energy * 100).toFixed(0)}% energy`);

        cb.stage(2, TOTAL, 'Сканирование');
        cb.log(`Reading directory: ${config.input}`);
        const allFiles = fs.readdirSync(config.input)
            .filter(f => /\.(mp4|mov)$/i.test(f) && !f.startsWith('.'));
        if (allFiles.length === 0) throw new Error(`Видеофайлы не найдены в: ${config.input}`);
        
        cb.info(`${allFiles.length} files found`);

        const basicFilesInfo = allFiles.map(file => ({
            id:   file,
            date: fs.statSync(path.join(config.input, file)).birthtime.toISOString(),
        }));

        cb.stage(3, TOTAL, 'AI фильтрация');
        cb.log('Checking Ollama connection...');
        await checkOllamaAvailable(config.model);
        
        cb.log('AI is filtering files by date range...');
        const requestedFileIds: string[] = await preFilterFiles(config.prompt, basicFilesInfo, config.model);
        if (requestedFileIds.length === 0) {
            throw new Error('Нет файлов в диапазоне дат. Проверь промпт.');
        }
        cb.info(`${requestedFileIds.length}/${allFiles.length} clips selected`);

        cb.stage(4, TOTAL, `Индексация`);
        cb.log(`Indexing ${requestedFileIds.length} clips (AI Vision + Metrics)...`);
        const videos: VideoInfo[] = await indexMediaFolder(
            config.input, TEMP_DIR, config.model, requestedFileIds,
            (done, total) => cb.renderTick(0, (done/total)*100, done, total)
        );

        cb.log('Calculating optimal render quality...');
        const allFilePaths = requestedFileIds.map(f => path.join(config.input, f));
        const quality = await resolveQuality(config.quality, allFilePaths);
        cb.info(`${quality.bitrate} Mbps · ${quality.x264preset}`);

        cb.stage(5, TOTAL, 'Монтаж');
        cb.log('AI Director is building edit plan...');
        const plan = await createDirectorPlan(
            config.prompt, videos, audioAnalysis,
            config.duration, TEMP_DIR, config.model
        );
        if (plan.segments.length === 0) throw new Error('Пустой план монтажа.');
        cb.info(`${plan.segments.length} scenes · ${plan.totalDuration.toFixed(1)}s`);

        cb.stage(6, TOTAL, 'Рендеринг');
        cb.log('Parallel segment rendering started...');
        const segProgressMap = new Map<number, number>();
        const segTotal = plan.segments.length;

        const sliceResult: SliceResult = await renderSegments(
            plan.segments, TEMP_DIR, config.lut, 0.5, plan.totalDuration, quality,
            (segIdx, pct) => {
                segProgressMap.set(segIdx, pct);
                const done = [...segProgressMap.values()].filter(p => p >= 100).length;
                cb.renderTick(segIdx, pct, done, segTotal);
            }
        );

        cb.stage(7, TOTAL, 'Сборка');
        cb.log('Final assembly and audio mixing...');
        const segmentConcatInfo = plan.segments.map((seg, i) => ({
            file:               sliceResult.files[i] ?? seg.outputFile,
            targetDuration:     seg.targetDuration,
            transition:         seg.transition,
            transitionDuration: seg.transitionDuration,
        }));

        await concatenateAndAddMusic(
            segmentConcatInfo, config.audio,
            sliceResult.totalDuration, 2.0,
            config.output, TEMP_DIR,
            sliceResult.targetFps, quality,
            (pct) => cb.assemblyProgress(pct)
        );

        const session: RenderSession = {
            segments:      plan.segments,
            totalDuration: plan.totalDuration,
            targetFps:     sliceResult.targetFps,
            audio:         config.audio,
            renderedAt:    new Date().toISOString(),
        };
        config.lastSession = session;
        saveConfig(config);
        cleanup();

        cb.done(config.output);

    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        cleanup();
        cb.error(msg);
        throw error;
    }
}

// ─── Edit пайплайн ────────────────────────────────────────────────────────────

async function runEditPipeline(
    session: RenderSession,
    lut: string,
    qualityLevel: string,
    output: string,
    cb: PipelineCB
): Promise<void> {
    const runId    = Date.now().toString(36);
    const TEMP_DIR = path.join(os.tmpdir(), `automounter_edit_${runId}`);
    fs.mkdirSync(TEMP_DIR, { recursive: true });

    const cleanup = () => fs.rmSync(TEMP_DIR, { recursive: true, force: true });

    try {
        const filePaths = [...new Set(session.segments.map(s => s.sourceFile))];
        const quality = await resolveQuality(qualityLevel, filePaths);
        cb.info(`${qualityLevel} · ${quality.bitrate} Mbps · ${quality.x264preset}${quality.scale ? ` · ${quality.scale}` : ''}`);

        const segments = session.segments.map((seg, i) => ({
            ...seg,
            outputFile: path.join(TEMP_DIR, `segment_${i.toString().padStart(3, '0')}.mp4`),
        }));

        cb.stage(1, 2, 'Рендеринг');
        const segProgressMap = new Map<number, number>();
        const segTotal = segments.length;

        const sliceResult: SliceResult = await renderSegments(
            segments, TEMP_DIR, lut, 0.5, session.totalDuration, quality,
            (segIdx, pct) => {
                segProgressMap.set(segIdx, pct);
                const done = [...segProgressMap.values()].filter(p => p >= 100).length;
                cb.renderTick(segIdx, pct, done, segTotal);
            }
        );

        cb.stage(2, 2, 'Сборка');
        const segmentConcatInfo = segments.map((seg, i) => ({
            file:               sliceResult.files[i] ?? seg.outputFile,
            targetDuration:     seg.targetDuration,
            transition:         seg.transition,
            transitionDuration: seg.transitionDuration,
        }));

        await concatenateAndAddMusic(
            segmentConcatInfo, session.audio,
            session.totalDuration, 2.0,
            output, TEMP_DIR,
            session.targetFps, quality,
            (pct) => cb.assemblyProgress(pct)
        );

        cleanup();
        cb.done(output);

    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        cleanup();
        cb.error(msg);
        throw error;
    }
}

// ─── Index-only режим (CLI) ────────────────────────────────────────────────────

async function runIndexOnly(): Promise<void> {
    const args    = process.argv.slice(2);
    const reindex = args.includes('--reindex');
    const inputIdx = args.indexOf('--input');
    const modelIdx = args.indexOf('--model');
    const input = (inputIdx !== -1 ? args[inputIdx + 1] : undefined) ?? loadSavedConfig().input ?? '';
    const model = (modelIdx !== -1 ? args[modelIdx + 1] : undefined) ?? loadSavedConfig().model ?? 'llava:13b';

    if (!input) { console.error('\n[Fatal] --input обязателен\n'); process.exit(1); }

    if (reindex) {
        const sidecars = fs.readdirSync(input).filter(f => /\.(mp4|mov)\.json$/i.test(f));
        if (sidecars.length > 0) {
            sidecars.forEach(f => {
                const fp = path.join(input, f);
                try {
                    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
                        fs.unlinkSync(fp);
                    }
                } catch (e) {}
            });
            console.log(`  Удалено ${sidecars.length} файлов кэша.`);
        }
    }

    const TEMP_DIR = path.join(os.tmpdir(), `automounter_idx_${Date.now().toString(36)}`);
    try {
        console.log(`\n  Индексация: ${input}\n  Модель:     ${model}\n`);
        await checkOllamaAvailable(model);
        const videos = await indexMediaFolder(input, TEMP_DIR, model);
        console.log(`\n  Готово. ${videos.length} файл(ов) проиндексировано.\n`);
    } catch (error: unknown) {
        console.error(`\n[Fatal] ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    } finally {
        if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const argv = process.argv.slice(2);

    // CLI-режимы без UI
    if (argv.includes('--index-only') || argv.includes('--reindex')) {
        await runIndexOnly();
        return;
    }
    if (argv.includes('--batch') || !process.stdin.isTTY) {
        const config = loadConfig();
        await runMainPipeline(config, makeConsoleCB());
        return;
    }

    // Интерактивный режим — показываем ink UI
    const saved = loadSavedConfig();
    const result = await showInkUI(saved, process.cwd());

    if (result.mode === 'create') {
        saveConfig(result.config);
        await showPipelineUI(result.config, (cb) => runMainPipeline(result.config, cb));

    } else if (result.mode === 'edit') {
        const session = (saved.lastSession as RenderSession | undefined);
        if (!session) { console.error('[Fatal] Нет сохранённой сессии.\n'); process.exit(1); }
        const currentConfig = { ...loadSavedConfig(), lut: result.lut, quality: result.quality, output: result.output } as any;
        await showPipelineUI(currentConfig, (cb) => runEditPipeline(session, result.lut, result.quality, result.output, cb));

    } else if (result.mode === 'index') {
        await showPipelineUI({ ...loadSavedConfig(), input: result.input, model: result.model } as any, async (cb) => {
            cb.stage(1, 2, 'Подготовка');
            if (result.reindex) {
                cb.log(`Cleaning cache in: ${result.input}`);
                const sidecars = fs.existsSync(result.input)
                    ? fs.readdirSync(result.input).filter(f => /\.(mp4|mov)\.json$/i.test(f))
                    : [];
                sidecars.forEach(f => {
                    const fp = path.join(result.input, f);
                    try {
                        if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
                            fs.unlinkSync(fp);
                        }
                    } catch (e) {}
                });
                cb.info(`Cache cleared (${sidecars.length} files)`);
            } else {
                cb.info('Using existing cache');
            }

            cb.stage(2, 2, 'Глубокий анализ');
            cb.log(`Starting Vision AI indexing with model: ${result.model}`);
            await checkOllamaAvailable(result.model);
            
            const TEMP_DIR = path.join(os.tmpdir(), `automounter_idx_${Date.now().toString(36)}`);
            try {
                const videos = await indexMediaFolder(result.input, TEMP_DIR, result.model, undefined, (done, total) => {
                    cb.renderTick(0, (done/total)*100, done, total);
                });
                cb.info(`${videos.length} videos analyzed`);
                cb.done('Indexing complete');
            } finally {
                if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true, force: true });
            }
        });
    }
    
    process.exit(0);
}

main().catch(err => {
    console.error(`\n[Fatal] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
