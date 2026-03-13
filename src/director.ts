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

function pickChunkSize(energy: number, style: string): number {
    // Базовый размер + вариация ±1 ступень
    if (energy > 0.75) {
        // Высокая энергия: 2–4 бита
        return [2, 3, 4, 4][Math.floor(Math.random() * 4)] ?? 4;
    }
    if (energy < 0.35) {
        // Низкая энергия: 8–16 битов
        const pool = style === 'lyrical' || style === 'calm'
            ? [8, 10, 12, 16] : [6, 8, 10, 12];
        return pool[Math.floor(Math.random() * pool.length)] ?? 8;
    }
    // Средняя энергия: 4–8
    return [4, 6, 6, 8, 8][Math.floor(Math.random() * 5)] ?? 6;
}

function shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
}

// Перемешиваем по тиерам (топ-треть, средняя, нижняя) — разнообразие + уважение к score
function shuffledPool(videos: VideoInfo[]): VideoInfo[] {
    const sorted = [...videos].sort((a, b) => (b.aestheticScore ?? 0) - (a.aestheticScore ?? 0));
    const third = Math.ceil(sorted.length / 3);
    return [
        ...shuffle(sorted.slice(0, third)),
        ...shuffle(sorted.slice(third, third * 2)),
        ...shuffle(sorted.slice(third * 2)),
    ];
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

// ─── Content filter ───────────────────────────────────────────────────────────

// Parses user prompt for content exclusions and filters clips accordingly.
const PEOPLE_TAGS = new Set(['people', 'person', 'man', 'woman', 'human', 'crowd', 'tourist', 'child', 'boy', 'girl', 'face', 'athlete']);

function filterVideosByContent(videos: VideoInfo[], prompt: string): VideoInfo[] {
    const lower = prompt.toLowerCase();

    const excludePeople =
        /без\s*(люд|человек|людини|людей|people|person|human)/i.test(lower) ||
        /no\s+(people|persons?|humans?|one)/i.test(lower);

    if (!excludePeople) return videos;

    const filtered = videos.filter(v =>
        !(v.tags ?? []).some(t => PEOPLE_TAGS.has(t.toLowerCase()))
    );
    // Safety: keep original list if filter is too aggressive
    const result = filtered.length >= Math.min(3, videos.length) ? filtered : videos;
    if (result.length < videos.length) {
        console.log(`  -> Content filter: excluded ${videos.length - result.length} clips with people`);
    }
    return result;
}

// ─── Auto-plan builder ────────────────────────────────────────────────────────

type AutoPlanMode = 'score' | 'energy';

function buildAutoInstructions(
    videos: VideoInfo[],
    audioAnalysis: AudioAnalysis,
    mode: AutoPlanMode,
    targetDurationSeconds: number
): AIEditInstruction[] {
    const beats = audioAnalysis.beats;
    const instructions: AIEditInstruction[] = [];

    // Единый перемешанный пул — один poolIndex, нет рассинхрона между sub-пулами
    const pool = shuffledPool(videos);
    const usedCount = new Map<string, number>();  // clipId → сколько раз использован
    const maxUses   = Math.max(1, Math.ceil(targetDurationSeconds / 4 / pool.length * 1.5));

    // Для mode=energy храним предпочтение по motion, но в рамках единого пула
    const energyPreference = (v: VideoInfo, energy: number): number => {
        const m = v.motionIntensity ?? 0.5;
        return 1 - Math.abs(m - energy);  // 0..1, чем ближе — тем лучше
    };

    let beatsUsed       = 0;
    let poolIndex       = 0;
    let accumulatedSecs = 0;
    const MAX_RECENT    = Math.min(6, Math.floor(pool.length / 2));
    const recentIds:   string[] = [];
    const recentDates: number[] = [];  // timestamps in ms for date-spread penalty

    while (beatsUsed < beats.length) {
        const startBeat: number | undefined = beats[beatsUsed];
        const beatTime = startBeat ?? 0;
        const energy   = getEnergyAtBeat(beatTime, audioAnalysis.sections);
        const chunkSize = pickChunkSize(energy, audioAnalysis.style);

        if (beatsUsed + chunkSize > beats.length) break;

        const endBeat: number | undefined = beats[beatsUsed + chunkSize];
        if (startBeat === undefined || endBeat === undefined) break;

        const segDuration = endBeat - startBeat;
        if (accumulatedSecs + segDuration > targetDurationSeconds) break;

        const lastAngle = instructions.length > 0
            ? videos.find(v => v.id === instructions[instructions.length - 1]!.clipId)?.cameraAngle
            : undefined;

        // Ищем лучший незаезженный клип, не повторяя ракурс подряд
        // Сортируем кандидатов: штраф за недавнее использование + бонус за energy match
        let chosen: VideoInfo | undefined;
        let bestScore = -Infinity;

        for (let i = 0; i < pool.length; i++) {
            const candidate = pool[(poolIndex + i) % pool.length];
            if (!candidate) continue;
            if ((usedCount.get(candidate.id) ?? 0) >= maxUses) continue;

            const isRecent    = recentIds.includes(candidate.id);
            const isSameAngle = lastAngle != null && candidate.cameraAngle === lastAngle;
            if (isSameAngle) continue;  // жёсткий запрет на один ракурс подряд

            let score = mode === 'energy' ? energyPreference(candidate, energy) : 0;
            if (isRecent) score -= 0.5;

            // Date-diversity: penalise clips shot within 12 h of recently used ones
            if (candidate.creationDate) {
                const ts = new Date(candidate.creationDate).getTime();
                const isSameDay = recentDates.some(d => Math.abs(ts - d) < 12 * 3600_000);
                if (isSameDay) score -= 0.4;
            }

            if (score > bestScore) {
                bestScore = score;
                chosen    = candidate;
                // не меняем poolIndex здесь — берём лучшего, а не первого
            }
        }

        // Fallback: хотя бы не тот же ракурс подряд
        if (!chosen) {
            for (let i = 0; i < pool.length; i++) {
                const c = pool[(poolIndex + i) % pool.length];
                if (c && c.cameraAngle !== lastAngle) { chosen = c; break; }
            }
        }
        // Последний fallback
        if (!chosen) chosen = pool[poolIndex % pool.length];

        if (chosen) {
            instructions.push({ clipId: chosen.id, beatsDuration: chunkSize });
            usedCount.set(chosen.id, (usedCount.get(chosen.id) ?? 0) + 1);
            recentIds.push(chosen.id);
            if (recentIds.length > MAX_RECENT) recentIds.shift();
            if (chosen.creationDate) {
                recentDates.push(new Date(chosen.creationDate).getTime());
                if (recentDates.length > MAX_RECENT) recentDates.shift();
            }
            accumulatedSecs += segDuration;
            // Двигаем poolIndex вперёд чтобы следующий поиск начинался с другой точки
            poolIndex = (pool.findIndex(v => v.id === chosen!.id) + 1) % pool.length;
        }

        beatsUsed += chunkSize;
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

function estimateTargetBeats(beats: number[], targetSecs: number): number {
    // Находим первый бит после targetSecs и возвращаем его индекс
    const idx = beats.findIndex(b => b >= targetSecs);
    return idx > 0 ? idx : beats.length;
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
    beats: number[],
    targetDurationSeconds: number
): AIEditInstruction[] {
    const validIds  = new Set(videos.map(v => v.id));
    const videoMap  = new Map(videos.map(v => [v.id, v]));
    let totalBeats  = 0;
    let totalSecs   = 0;
    const valid: AIEditInstruction[] = [];
    // Ограничиваем повторы: каждый клип — не более чем раз на каждые ~5 уникальных клипов
    const usedCount = new Map<string, number>();
    const maxUses   = Math.max(2, Math.ceil(targetDurationSeconds / 5 / videos.length * videos.length));

    for (const inst of instructions) {
        if (!validIds.has(inst.clipId))                                      { console.warn(`  -> Unknown clip "${inst.clipId}", skipping.`); continue; }
        if (typeof inst.beatsDuration !== 'number' || inst.beatsDuration <= 0) { console.warn(`  -> Bad beatsDuration for "${inst.clipId}", skipping.`); continue; }
        if (totalBeats + inst.beatsDuration > beats.length)                  { console.warn(`  -> Plan exceeds available beats, truncating.`); break; }

        const startBeat = beats[totalBeats];
        const endBeat   = beats[totalBeats + inst.beatsDuration];
        if (startBeat === undefined || endBeat === undefined) break;
        if (totalSecs + (endBeat - startBeat) > targetDurationSeconds)       break;

        const uses = usedCount.get(inst.clipId) ?? 0;
        if (uses >= maxUses) { console.warn(`  -> Clip "${inst.clipId}" used ${uses} times, skipping repeat.`); continue; }

        // Не ставим один ракурс подряд
        const lastClip = valid[valid.length - 1];
        if (lastClip) {
            const prevAngle = videoMap.get(lastClip.clipId)?.cameraAngle;
            const currAngle = videoMap.get(inst.clipId)?.cameraAngle;
            if (prevAngle && currAngle && prevAngle === currAngle) {
                console.warn(`  -> Same angle as previous ("${prevAngle}"), skipping.`);
                continue;
            }
        }

        usedCount.set(inst.clipId, uses + 1);
        totalBeats += inst.beatsDuration;
        totalSecs  += endBeat - startBeat;
        valid.push(inst);
    }

    return valid;
}

async function getPlanFromLLM(
    prompt: string,
    videos: VideoInfo[],
    audioAnalysis: AudioAnalysis,
    targetDurationSeconds: number,
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

    // Сколько битов нужно для targetDurationSeconds
    const targetBeats = estimateTargetBeats(audioAnalysis.beats, targetDurationSeconds);

    const systemPrompt = `You are an expert video editor.
Track: ${audioAnalysis.tempo} BPM | style: ${audioAnalysis.style} | energy: ${(audioAnalysis.energy * 100).toFixed(0)}%
${dropsInfo}
Energy over time: ${energyMap}
Target duration: ${targetDurationSeconds}s ≈ ${targetBeats} beats

User request: "${prompt}"

Clips (use diverse selection — don't repeat same clip or same cameraAngle back-to-back):
${JSON.stringify(availableClips, null, 2)}

Rules:
- Pacing: high energy (>75%) → 2–4 beats; low energy (<35%) → 8–12 beats; else 4–8 beats
- Vary segment lengths — avoid all segments being the same duration
- Style "${audioAnalysis.style}": ${audioAnalysis.style === 'dynamic' || audioAnalysis.style === 'epic'
    ? 'prefer high-motion clips, short cuts, avoid slow/static shots'
    : 'longer clips welcome, slow-motion ok on isSlowMotionSuitable clips'}
- Total beatsDuration MUST be close to ${targetBeats} (target) and NOT exceed ${audioAnalysis.beats.length}
- Use as many DIFFERENT clips as possible — avoid repeating the same clipId
- Respond ONLY with a JSON array: [{"clipId": "file.mp4", "beatsDuration": 6}, ...]
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
                return validateInstructions(parsed as AIEditInstruction[], videos, audioAnalysis.beats, targetDurationSeconds);
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

    // Filter videos by content constraints expressed in the prompt (e.g. "без людей")
    const filteredVideos = filterVideosByContent(videos, userPrompt);

    const llmInstructions = await getPlanFromLLM(userPrompt, filteredVideos, audioAnalysis, targetDurationSeconds, textModelName);
    const beats = audioAnalysis.beats;
    const isLyricalOrCalm = audioAnalysis.style === 'lyrical' || audioAnalysis.style === 'calm';

    // ── Multi-pass: собираем кандидатов и выбираем лучший по скору ────────────
    const candidates: { label: string; instructions: AIEditInstruction[] }[] = [];
    if (llmInstructions.length > 0) {
        candidates.push({ label: 'AI plan', instructions: llmInstructions });
    }
    candidates.push({ label: 'auto:score',  instructions: buildAutoInstructions(filteredVideos, audioAnalysis, 'score',  targetDurationSeconds) });
    candidates.push({ label: 'auto:energy', instructions: buildAutoInstructions(filteredVideos, audioAnalysis, 'energy', targetDurationSeconds) });

    let bestInstructions: AIEditInstruction[] = [];
    let bestScore = -Infinity;
    for (const c of candidates) {
        const score  = scorePlan(c.instructions, filteredVideos, audioAnalysis);
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

        const selectedVideo = filteredVideos.find(v => v.id === instruction.clipId);
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

        // Natural speed by default: rawDuration ≈ targetDuration → ptsFactor ≈ 1.0.
        // Slow-mo clips: rawDuration = targetDuration * 0.5 → ptsFactor = 2.0 (half speed).
        // Avoid 1.2–1.8× multiplier that made every segment play at wrong speed.
        const desiredRaw = targetDuration * slowMotionFactor;

        // Use preferredZone only if it has enough footage; otherwise fall back to activeZone.
        const preferredLen  = preferredZone.end - preferredZone.start;
        const effectiveZone = preferredLen >= desiredRaw * 0.8 ? preferredZone : activeZone;
        const zoneLen       = effectiveZone.end - effectiveZone.start;

        // Clamp rawDuration strictly within zone bounds.
        // Minimum is min(0.5, zoneLen) — never exceed zone length even for floor value,
        // otherwise we'd read past the valid zone boundary into black-frame territory.
        const minRaw = Math.min(0.5, zoneLen);
        let rawDuration = Math.max(minRaw, Math.min(desiredRaw, zoneLen));

        const safeMaxTime = effectiveZone.end - rawDuration;
        const startTime   = effectiveZone.start + Math.random() * Math.max(0, safeMaxTime - effectiveZone.start);
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
