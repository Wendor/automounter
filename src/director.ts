import * as path from 'path';
import { VideoInfo, VideoSegment, AIEditInstruction, ValidZone, AudioAnalysis, AudioSection, SegmentEffect } from './types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cleanJSONString(rawStr: string): string {
    const regex = new RegExp('\\x60\\x60\\x60(?:json)?\\s*([\\s\\S]*?)\\s*\\x60\\x60\\x60');
    const match = rawStr.match(regex);
    return match ? match[1] ?? rawStr : rawStr;
}

function getEnergyAtBeat(beatTime: number, sections: AudioSection[]): number {
    return sections.find(s => beatTime >= s.start && beatTime < s.end)?.energy ?? 0.5;
}

function chunkSizeForEnergy(energy: number): number {
    if (energy > 0.75) return 4;
    if (energy < 0.35) return 12;
    return 8;
}

function colorDistance(hexA: string, hexB: string): number {
    const parse = (hex: string): [number, number, number] => {
        const h = hex.replace('#', '').padEnd(6, '0');
        return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
    };
    const [r1, g1, b1] = parse(hexA);
    const [r2, g2, b2] = parse(hexB);
    return Math.sqrt(((r1 ?? 0) - (r2 ?? 0)) ** 2 + ((g1 ?? 0) - (g2 ?? 0)) ** 2 + ((b1 ?? 0) - (b2 ?? 0)) ** 2);
}

// ─── Landscape groups (subject continuity) ───────────────────────────────────

const LANDSCAPE_GROUP: Record<string, number> = {};
['water', 'coast', 'river', 'lake', 'sea', 'ocean', 'beach'].forEach(l => { LANDSCAPE_GROUP[l] = 0; });
['forest', 'field', 'mountains', 'hill', 'meadow', 'valley', 'nature'].forEach(l => { LANDSCAPE_GROUP[l] = 1; });
['urban', 'road', 'city', 'street', 'building', 'bridge', 'town'].forEach(l => { LANDSCAPE_GROUP[l] = 2; });

function landscapeDistance(a: string | undefined, b: string | undefined): number {
    if (!a || !b) return 0;
    const ga = LANDSCAPE_GROUP[a.toLowerCase()] ?? 3;
    const gb = LANDSCAPE_GROUP[b.toLowerCase()] ?? 3;
    if (ga === gb) return 0;
    return Math.abs(ga - gb) === 1 ? 1 : 2;
}

// ─── Auto-plan builder ────────────────────────────────────────────────────────

type AutoPlanMode = 'score' | 'energy';

function buildAutoInstructions(
    videos: VideoInfo[],
    audioAnalysis: AudioAnalysis,
    mode: AutoPlanMode
): AIEditInstruction[] {
    const beats = audioAnalysis.beats;
    const instructions: AIEditInstruction[] = [];

    // Два пула: высокодинамичные и спокойные клипы
    const byScore  = [...videos].sort((a, b) => (b.aestheticScore ?? 0) - (a.aestheticScore ?? 0));
    const highMotion = byScore.filter(v => (v.motionIntensity ?? 0.5) >= 0.6);
    const lowMotion  = byScore.filter(v => (v.motionIntensity ?? 0.5) <  0.6);

    let beatsUsed = 0;
    let vIndex    = 0;

    while (beatsUsed < beats.length && byScore.length > 0) {
        const beatTime  = beats[beatsUsed] ?? 0;
        const energy    = getEnergyAtBeat(beatTime, audioAnalysis.sections);
        const rawChunk  = chunkSizeForEnergy(energy);
        const chunkSize = (audioAnalysis.style === 'dynamic' || audioAnalysis.style === 'epic')
            ? Math.min(rawChunk, 8)
            : rawChunk;

        if (beatsUsed + chunkSize > beats.length) break;

        let v: VideoInfo | undefined;
        if (mode === 'energy') {
            // Подбираем клип, чей motionIntensity ближе всего к текущей энергии трека
            const pool = energy >= 0.6
                ? (highMotion.length > 0 ? highMotion : byScore)
                : (lowMotion.length  > 0 ? lowMotion  : byScore);
            v = pool[vIndex % pool.length];
        } else {
            v = byScore[vIndex % byScore.length];
        }

        if (v) instructions.push({ clipId: v.id, beatsDuration: chunkSize });
        beatsUsed += chunkSize;
        vIndex++;
    }

    return instructions;
}

// ─── Plan scoring ─────────────────────────────────────────────────────────────

function scorePlan(
    instructions: AIEditInstruction[],
    videos: VideoInfo[],
    audioAnalysis: AudioAnalysis
): number {
    if (instructions.length === 0) return 0;

    const videoMap = new Map(videos.map(v => [v.id, v]));

    // 1. Разнообразие: доля уникальных клипов
    const uniqueClips = new Set(instructions.map(i => i.clipId)).size;
    const diversity   = Math.min(1, uniqueClips / Math.max(1, instructions.length));

    // 2. Соответствие энергии: motionIntensity клипа ~ энергии секции
    let energyMatchSum = 0;
    let beatIndex = 0;
    for (const inst of instructions) {
        const beatTime = audioAnalysis.beats[beatIndex] ?? 0;
        const energy   = getEnergyAtBeat(beatTime, audioAnalysis.sections);
        const motion   = videoMap.get(inst.clipId)?.motionIntensity ?? 0.5;
        energyMatchSum += 1 - Math.abs(energy - motion);
        beatIndex += inst.beatsDuration;
    }
    const energyMatch = energyMatchSum / instructions.length;

    // 3. Разнообразие пейзажей: нормализованная энтропия
    const landscapeCounts = new Map<string, number>();
    for (const inst of instructions) {
        const l = videoMap.get(inst.clipId)?.landscape ?? 'unknown';
        landscapeCounts.set(l, (landscapeCounts.get(l) ?? 0) + 1);
    }
    const total = instructions.length;
    let entropy = 0;
    for (const count of landscapeCounts.values()) {
        const p = count / total;
        entropy -= p * Math.log2(p);
    }
    const maxEntropy       = Math.log2(Math.max(1, landscapeCounts.size));
    const landscapeVariety = maxEntropy > 0 ? entropy / maxEntropy : 1;

    // 4. Штраф за одинаковые клипы подряд
    let consecDups = 0;
    for (let i = 1; i < instructions.length; i++) {
        if (instructions[i]!.clipId === instructions[i - 1]!.clipId) consecDups++;
    }
    const dupPenalty = consecDups / Math.max(1, instructions.length - 1);

    return diversity * 0.3 + energyMatch * 0.4 + landscapeVariety * 0.2 - dupPenalty * 0.1;
}

// ─── Pre-filter ───────────────────────────────────────────────────────────────

export async function preFilterFiles(
    userPrompt: string,
    filesBasicInfo: { id: string; date: string }[],
    textModelName: string
): Promise<string[]> {
    console.log(`  -> Asking AI to extract date range from prompt...`);

    const systemPrompt = `You are a helpful assistant. Extract the date range from the user's video editing request.
User prompt: "${userPrompt}"

Respond ONLY with a valid JSON object in this exact format:
{"dateStart": "YYYY-MM-DD", "dateEnd": "YYYY-MM-DD"}
Use null for missing dates. Example: "с 23 по 27 августа 2025" -> {"dateStart": "2025-08-23", "dateEnd": "2025-08-27"}
No markdown, no explanations, only JSON.`;

    try {
        const response = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: textModelName, prompt: systemPrompt, format: 'json', stream: false, keep_alive: '10m' })
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data: unknown = await response.json();
        if (typeof data === 'object' && data !== null && 'response' in data) {
            const parsed = JSON.parse(cleanJSONString(String((data as Record<string, unknown>).response))) as Record<string, unknown>;
            const dateStart = typeof parsed.dateStart === 'string' ? parsed.dateStart : null;
            const dateEnd   = typeof parsed.dateEnd   === 'string' ? parsed.dateEnd   : null;

            let filtered = filesBasicInfo;
            if (dateStart) filtered = filtered.filter(f => new Date(f.date) >= new Date(dateStart));
            if (dateEnd) {
                const end = new Date(dateEnd); end.setHours(23, 59, 59, 999);
                filtered = filtered.filter(f => new Date(f.date) <= end);
            }

            if (dateStart || dateEnd) {
                console.log(`  -> Date filter: ${dateStart ?? '*'} → ${dateEnd ?? '*'} | ${filtered.length}/${filesBasicInfo.length} files match`);
            } else {
                console.log(`  -> No date filter, using all ${filesBasicInfo.length} files`);
            }

            return filtered.map(f => f.id);
        }
    } catch (error: unknown) {
        console.warn(`  -> Could not extract dates (${error instanceof Error ? error.message : String(error)}). Using all files.`);
    }

    return filesBasicInfo.map(f => f.id);
}

// ─── LLM plan ─────────────────────────────────────────────────────────────────

function validateInstructions(
    instructions: AIEditInstruction[],
    videos: VideoInfo[],
    beats: number[]
): AIEditInstruction[] {
    const validIds = new Set(videos.map(v => v.id));
    let totalBeats = 0;
    const valid: AIEditInstruction[] = [];

    for (const inst of instructions) {
        if (!validIds.has(inst.clipId))                                  { console.warn(`  -> Unknown clip "${inst.clipId}", skipping.`); continue; }
        if (typeof inst.beatsDuration !== 'number' || inst.beatsDuration <= 0) { console.warn(`  -> Bad beatsDuration for "${inst.clipId}", skipping.`); continue; }
        if (totalBeats + inst.beatsDuration > beats.length)              { console.warn(`  -> Plan exceeds available beats, truncating.`); break; }
        totalBeats += inst.beatsDuration;
        valid.push(inst);
    }

    return valid;
}

async function getPlanFromLLM(
    prompt: string,
    videos: VideoInfo[],
    audioAnalysis: AudioAnalysis,
    textModel: string
): Promise<AIEditInstruction[]> {
    const availableClips = videos.map(v => ({
        id: v.id, score: v.aestheticScore, description: v.description,
        tags: v.tags, timeOfDay: v.timeOfDay, landscape: v.landscape,
        cameraAngle: v.cameraAngle, motion: v.motion,
        motionIntensity: v.motionIntensity, isSlowMotionSuitable: v.isSlowMotionSuitable,
        dominantColors: v.dominantColors,
    }));

    const dropsInfo = audioAnalysis.drops.length > 0
        ? `Energy drops at: ${audioAnalysis.drops.map(d => d.toFixed(1) + 's').join(', ')}`
        : 'No dramatic energy drops';

    // Energy map: sample every 4th section to keep prompt concise
    const energyMap = audioAnalysis.sections
        .filter((_, i) => i % 4 === 0)
        .map(s => `  ${s.start.toFixed(0)}s: ${(s.energy * 100).toFixed(0)}%`)
        .join('  ');

    const systemPrompt = `You are an expert video editor.
Track: ${audioAnalysis.tempo} BPM | style: ${audioAnalysis.style} | energy: ${(audioAnalysis.energy * 100).toFixed(0)}%
${dropsInfo}
Energy over time: ${energyMap}
Available beats: ${audioAnalysis.beats.length}

User request: "${prompt}"

Clips:
${JSON.stringify(availableClips, null, 2)}

Rules:
- Pacing: at moments with high energy (>75%), use 4 beats; low energy (<35%), use 12 beats; else 8
- Style "${audioAnalysis.style}": ${audioAnalysis.style === 'dynamic' || audioAnalysis.style === 'epic'
    ? 'prefer high-motion clips, avoid slow/static shots, no slow-motion'
    : 'longer clips are welcome, slow-motion suitable on isSlowMotionSuitable clips'}
- Total beatsDuration must not exceed ${audioAnalysis.beats.length}
- Respond ONLY with a JSON array: [{"clipId": "file.mp4", "beatsDuration": 8}, ...]
No markdown, no explanations, only JSON.`;

    try {
        const response = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: textModel, prompt: systemPrompt, format: 'json', stream: false, keep_alive: '10m' })
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data: unknown = await response.json();
        if (typeof data === 'object' && data !== null && 'response' in data) {
            const parsed: unknown = JSON.parse(cleanJSONString(String((data as Record<string, unknown>).response)));
            if (Array.isArray(parsed)) {
                return validateInstructions(parsed as AIEditInstruction[], videos, audioAnalysis.beats);
            }
        }
    } catch (error: unknown) {
        console.warn(`  -> LLM planning failed (${error instanceof Error ? error.message : String(error)}), using auto plan.`);
    }

    return [];
}

// ─── Effect selection ─────────────────────────────────────────────────────────

function selectEffect(
    video: VideoInfo,
    audioAnalysis: AudioAnalysis,
    isFirst: boolean,
    accumulatedSeconds: number
): SegmentEffect {
    if (isFirst) return 'fadeIn';

    const nearDrop = audioAnalysis.drops.some(d => Math.abs(d - accumulatedSeconds) < 1.5);
    if (nearDrop && (audioAnalysis.style === 'epic' || audioAnalysis.style === 'dynamic')) return 'flashIn';
    if (audioAnalysis.style === 'dynamic' && (video.motionIntensity ?? 0.5) > 0.65) return 'cut';
    return 'none';
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function createDirectorPlan(
    userPrompt: string,
    videos: VideoInfo[],
    audioAnalysis: AudioAnalysis,
    targetDurationSeconds: number,
    tempDir: string,
    textModelName: string
): Promise<{ segments: VideoSegment[], totalDuration: number }> {

    const llmInstructions = await getPlanFromLLM(userPrompt, videos, audioAnalysis, textModelName);
    const beats = audioAnalysis.beats;
    const isLyricalOrCalm = audioAnalysis.style === 'lyrical' || audioAnalysis.style === 'calm';

    // ── Multi-pass: собираем кандидатов и выбираем лучший по скору ────────────
    const candidates: { label: string; instructions: AIEditInstruction[] }[] = [];
    if (llmInstructions.length > 0) {
        candidates.push({ label: 'AI plan', instructions: llmInstructions });
    }
    candidates.push({ label: 'auto:score',  instructions: buildAutoInstructions(videos, audioAnalysis, 'score')  });
    candidates.push({ label: 'auto:energy', instructions: buildAutoInstructions(videos, audioAnalysis, 'energy') });

    let bestInstructions: AIEditInstruction[] = [];
    let bestScore = -Infinity;
    for (const c of candidates) {
        const score  = scorePlan(c.instructions, videos, audioAnalysis);
        const marker = score > bestScore ? '  ← best' : '';
        console.log(`  -> ${c.label.padEnd(18)} score=${score.toFixed(3)}  (${c.instructions.length} scenes)${marker}`);
        if (score > bestScore) { bestScore = score; bestInstructions = c.instructions; }
    }

    const instructions = bestInstructions;

    const segments: VideoSegment[] = [];
    let accumulatedDuration = 0;
    let currentBeatIndex    = 0;

    for (const instruction of instructions) {
        const startBeat: number | undefined = beats[currentBeatIndex];
        const endBeatIndex = currentBeatIndex + instruction.beatsDuration;
        const endBeat: number | undefined   = beats[endBeatIndex];

        if (typeof startBeat !== 'number' || typeof endBeat !== 'number') break;

        const targetDuration = endBeat - startBeat;
        if (accumulatedDuration + targetDuration > targetDurationSeconds && segments.length > 0) break;

        const selectedVideo = videos.find(v => v.id === instruction.clipId);
        if (!selectedVideo) continue;

        // Use the longest valid zone (black-frame-aware)
        const activeZone: ValidZone | undefined = [...selectedVideo.validZones]
            .sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
        if (!activeZone) continue;

        const isFirst  = segments.length === 0;
        const effect   = selectEffect(selectedVideo, audioAnalysis, isFirst, accumulatedDuration);

        const applySlowMo = !isFirst &&
            audioAnalysis.style !== 'dynamic' &&
            audioAnalysis.style !== 'epic' &&
            (selectedVideo.isSlowMotionSuitable ?? false);
        const slowMotionFactor = applySlowMo ? 0.5 : 1.0;

        // Prefer best-scored segment zone; verify it's inside a valid zone
        const bestZone    = selectedVideo.bestSegments?.[0];
        const inValidZone = bestZone && selectedVideo.validZones.some(z =>
            bestZone.start >= z.start && bestZone.end <= z.end
        );
        const preferredZone: ValidZone = (bestZone && inValidZone) ? bestZone : activeZone;

        let rawDuration  = targetDuration * (1.2 + Math.random() * 0.6) * slowMotionFactor;
        const maxAvailable = preferredZone.end - preferredZone.start;
        if (rawDuration > maxAvailable) rawDuration = maxAvailable;
        rawDuration = Math.max(rawDuration, 0.5);

        const safeMaxTime = preferredZone.end - rawDuration;
        const startTime   = preferredZone.start + Math.random() * Math.max(0, safeMaxTime - preferredZone.start);
        const ptsFactor   = targetDuration / rawDuration;
        const outputFile  = path.join(tempDir, `segment_${segments.length.toString().padStart(3, '0')}.mp4`);

        segments.push({
            sourceFile:        selectedVideo.filePath,
            startTime,
            rawDuration,
            targetDuration,
            ptsFactor,
            outputFile,
            isFirst,
            isLast:            false,
            effect,
            slowMotionFactor,
            sourceFps:         selectedVideo.fps ?? 30,
            transition:        (!isFirst && isLyricalOrCalm) ? 'dissolve' : 'hard',
            transitionDuration: (!isFirst && isLyricalOrCalm) ? 0.5 : 0.0,
        });

        accumulatedDuration += targetDuration;
        currentBeatIndex = endBeatIndex;
    }

    // Fix last segment
    if (segments.length > 0) {
        const last = segments[segments.length - 1]!;
        last.isLast = true;
        last.effect = 'fadeOut';
        last.transition = 'hard';
        last.transitionDuration = 0.0;
    }

    // ── Color harmony pass ──────────────────────────────────────────────────
    // Scan consecutive pairs; jarring color jumps → promote to flashIn
    for (let i = 1; i < segments.length - 1; i++) {
        const prevSeg  = segments[i - 1]!;
        const currSeg  = segments[i]!;
        const prevVideo = videos.find(v => v.filePath === prevSeg.sourceFile);
        const currVideo = videos.find(v => v.filePath === currSeg.sourceFile);

        const prevColor = prevVideo?.dominantColors?.[0];
        const currColor = currVideo?.dominantColors?.[0];

        if (prevColor && currColor) {
            const dist = colorDistance(prevColor, currColor);
            if (dist > 120 && currSeg.effect !== 'flashIn') {
                currSeg.effect = 'flashIn';
                currSeg.transition = 'hard'; // flash overrides dissolve
                currSeg.transitionDuration = 0.0;
            }
        }
    }

    // ── Subject continuity pass ─────────────────────────────────────────────
    // Резкая смена типа пейзажа (вода → город) → добавляем dissolve
    for (let i = 1; i < segments.length - 1; i++) {
        const currSeg   = segments[i]!;
        const prevVideo = videos.find(v => v.filePath === segments[i - 1]!.sourceFile);
        const currVideo = videos.find(v => v.filePath === currSeg.sourceFile);

        const dist = landscapeDistance(prevVideo?.landscape, currVideo?.landscape);
        if (dist >= 2 && currSeg.effect !== 'flashIn' && currSeg.transition !== 'dissolve') {
            currSeg.transition        = 'dissolve';
            currSeg.transitionDuration = 0.5;
        }
    }

    return { segments, totalDuration: accumulatedDuration };
}
