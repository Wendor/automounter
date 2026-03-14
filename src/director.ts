import * as path from "path";
import {
  VideoInfo,
  VideoSegment,
  AIEditInstruction,
  ValidZone,
  AudioAnalysis,
  AudioSection,
  SegmentEffect,
} from "./types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cleanJSONString(rawStr: string): string {
  const regex = new RegExp(
    "\\x60\\x60\\x60(?:json)?\\s*([\\s\\S]*?)\\s*\\x60\\x60\\x60",
  );
  const match = rawStr.match(regex);
  return match ? (match[1] ?? rawStr) : rawStr;
}

function getEnergyAtBeat(beatTime: number, sections: AudioSection[]): number {
  return (
    sections.find((s) => beatTime >= s.start && beatTime < s.end)?.energy ?? 0.5
  );
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function shuffledPool(videos: VideoInfo[]): VideoInfo[] {
  const sorted = [...videos].sort(
    (a, b) => (b.aestheticScore ?? 0) - (a.aestheticScore ?? 0),
  );
  const third = Math.ceil(sorted.length / 3);
  return [
    ...shuffle(sorted.slice(0, third)),
    ...shuffle(sorted.slice(third, third * 2)),
    ...shuffle(sorted.slice(third * 2)),
  ];
}

// ─── AI-Driven Content Filtering ──────────────────────────────────────────────

interface FilterDirectives {
  excludeKeywords: string[];
  includeKeywords: string[];
  priorityKeywords: string[];
}

async function getFilterDirectivesFromAI(
  prompt: string,
  allTags: string[],
  modelName: string,
): Promise<FilterDirectives> {
  const systemPrompt = `Analyze user request and tags to create filtering rules.
User prompt: "${prompt}"
Tags: ${allTags.join(", ")}
Respond ONLY JSON: {"excludeKeywords": [], "includeKeywords": [], "priorityKeywords": []}`;
  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelName,
        prompt: systemPrompt,
        format: "json",
        stream: false,
        keep_alive: "20m",
      }),
    });
    if (res.ok) {
      const data: any = await res.json();
      const parsed = JSON.parse(cleanJSONString(data.response));
      return {
        excludeKeywords: parsed.excludeKeywords ?? [],
        includeKeywords: parsed.includeKeywords ?? [],
        priorityKeywords: parsed.priorityKeywords ?? [],
      };
    }
  } catch (e) {}
  return { excludeKeywords: [], includeKeywords: [], priorityKeywords: [] };
}

function applyAiFiltering(
  videos: VideoInfo[],
  directives: FilterDirectives,
): VideoInfo[] {
  const filtered = videos.filter((v) => {
    const text = (
      v.tags?.join(" ") +
      " " +
      (v.description || "")
    ).toLowerCase();
    return !directives.excludeKeywords.some((k) =>
      text.includes(k.toLowerCase()),
    );
  });
  if (filtered.length < videos.length * 0.2 || filtered.length < 5) {
    return videos;
  }
  return filtered;
}

// ─── Semantic Analysis ────────────────────────────────────────────────────────

interface PromptIntent {
  keywords: string[];
  style: "cinematic" | "fast-paced" | "calm" | "vlog";
}

function analyzePromptIntent(prompt: string): PromptIntent {
  const lower = prompt.toLowerCase();
  const keywords: string[] = [];
  const lt = [
    "water",
    "forest",
    "urban",
    "mountains",
    "road",
    "coast",
    "city",
    "nature",
    "snow",
  ];
  for (const k of lt) if (lower.includes(k)) keywords.push(k);
  let style: PromptIntent["style"] = "cinematic";
  if (lower.match(/fast|action|dynamic|drive/)) style = "fast-paced";
  else if (lower.match(/calm|meditation|relax|slow/)) style = "calm";
  return { keywords, style };
}

function calculateClipRelevance(
  video: VideoInfo,
  intent: PromptIntent,
  directives: FilterDirectives,
  energy: number,
  usedCount: number,
): number {
  let score = 0;
  const text = (
    video.tags?.join(" ") +
    " " +
    (video.description || "")
  ).toLowerCase();
  if (directives.excludeKeywords.some((k) => text.includes(k.toLowerCase())))
    score -= 15.0;
  if (usedCount > 0) score -= 10.0 * usedCount;
  for (const kw of directives.priorityKeywords)
    if (text.includes(kw.toLowerCase())) score += 4.0;
  for (const kw of intent.keywords) if (text.includes(kw)) score += 3.0;
  if (intent.style === "fast-paced")
    score += (video.motionIntensity ?? 0.5) * 2.0;
  else if (intent.style === "calm")
    score += (1 - (video.motionIntensity ?? 0.5)) * 2.0;
  score += (video.aestheticScore ?? 5) / 2;
  score += (1 - Math.abs((video.motionIntensity ?? 0.5) - energy)) * 1.5;
  return score;
}

function findNearestPeak(
  time: number,
  peaks: number[],
  maxDelta: number = 0.1,
): number {
  let nearest = time;
  let minDist = maxDelta;
  for (const p of peaks) {
    const dist = Math.abs(p - time);
    if (dist < minDist) {
      minDist = dist;
      nearest = p;
    }
  }
  return nearest;
}

function buildAutoInstructions(
  videos: VideoInfo[],
  audioAnalysis: AudioAnalysis,
  directives: FilterDirectives,
  targetDurationSeconds: number,
  userPrompt: string,
): AIEditInstruction[] {
  const beats = audioAnalysis.beats;
  const instructions: AIEditInstruction[] = [];
  const intent = analyzePromptIntent(userPrompt);
  const pool = shuffledPool(videos);
  const usedCountMap = new Map<string, number>();
  let beatsUsed = 0;
  let accumulatedSecs = 0;
  const recentIds: string[] = [];

  while (beatsUsed < beats.length && accumulatedSecs < targetDurationSeconds) {
    const currentSec = beats[beatsUsed] ?? 0;
    const currentEnergy = getEnergyAtBeat(currentSec, audioAnalysis.sections);
    const pattern = [4, 8, 4, 8];
    const rawChunkSize = pattern[instructions.length % pattern.length] ?? 8;
    const t1 = audioAnalysis.beats[beatsUsed];
    const t2 = audioAnalysis.beats[beatsUsed + rawChunkSize];
    if (t1 === undefined || t2 === undefined) break;
    let effectiveEnd = findNearestPeak(t2, audioAnalysis.peaks, 0.15);
    const segDuration = effectiveEnd - t1;
    if (accumulatedSecs + segDuration > targetDurationSeconds + 2) break;

    let chosen: VideoInfo | undefined;
    let bestScore = -Infinity;
    for (const candidate of pool) {
      const uses = usedCountMap.get(candidate.id) ?? 0;
      if (uses >= 2) continue;
      if (recentIds.includes(candidate.id) && pool.length > 3) continue;
      let score = calculateClipRelevance(
        candidate,
        intent,
        directives,
        currentEnergy,
        uses,
      );
      if (score > bestScore) {
        bestScore = score;
        chosen = candidate;
      }
    }
    if (chosen) {
      instructions.push({ clipId: chosen.id, beatsDuration: rawChunkSize });
      usedCountMap.set(chosen.id, (usedCountMap.get(chosen.id) ?? 0) + 1);
      recentIds.push(chosen.id);
      if (recentIds.length > 10) recentIds.shift();
      accumulatedSecs += segDuration;
    } else break;
    beatsUsed += rawChunkSize;
  }
  return instructions;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export async function preFilterFiles(
  userPrompt: string,
  filesBasicInfo: { id: string; date: string }[],
  textModelName: string,
): Promise<string[]> {
  const systemPrompt = `Extract date range from: "${userPrompt}". Respond ONLY JSON: {"dateStart": "YYYY-MM-DD", "dateEnd": "YYYY-MM-DD"}. Use null if missing.`;
  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: textModelName,
        prompt: systemPrompt,
        format: "json",
        stream: false,
        keep_alive: "20m",
      }),
    });
    if (res.ok) {
      const data: any = await res.json();
      const parsed = JSON.parse(cleanJSONString(data.response));
      let filtered = filesBasicInfo;
      if (parsed.dateStart)
        filtered = filtered.filter(
          (f) => new Date(f.date) >= new Date(parsed.dateStart),
        );
      if (parsed.dateEnd)
        filtered = filtered.filter(
          (f) => new Date(f.date) <= new Date(parsed.dateEnd),
        );
      return filtered.map((f) => f.id);
    }
  } catch {}
  return filesBasicInfo.map((f) => f.id);
}

export async function createDirectorPlan(
  userPrompt: string,
  videos: VideoInfo[],
  audioAnalysis: AudioAnalysis,
  targetDurationSeconds: number,
  tempDir: string,
  textModelName: string,
): Promise<{ segments: VideoSegment[]; totalDuration: number }> {
  const allTags = [...new Set(videos.flatMap((v) => v.tags || []))];
  const directives = await getFilterDirectivesFromAI(
    userPrompt,
    allTags,
    textModelName,
  );
  const filteredVideos = applyAiFiltering(
    videos.filter((v) => v.validZones.length > 0),
    directives,
  );
  const autoPlan = buildAutoInstructions(
    filteredVideos,
    audioAnalysis,
    directives,
    targetDurationSeconds,
    userPrompt,
  );
  const segments: VideoSegment[] = [];
  let accumulated = 0;
  let beatIdx = 0;
  const clipUsageTimes = new Map<string, number>();

  for (const inst of autoPlan) {
    const t1 = audioAnalysis.beats[beatIdx];
    const t2 = audioAnalysis.beats[beatIdx + Math.ceil(inst.beatsDuration)];
    if (t1 === undefined || t2 === undefined) break;
    let endT = findNearestPeak(t2, audioAnalysis.peaks, 0.15);
    const targetDur = endT - t1;
    const video = filteredVideos.find((v) => v.id === inst.clipId);
    if (!video) continue;
    const activeZone =
      video.bestSegments?.[0] ||
      video.validZones.sort((a, b) => b.end - a.start - (a.end - a.start))[0];
    if (!activeZone) continue;

    const usageCount = clipUsageTimes.get(video.id) ?? 0;
    clipUsageTimes.set(video.id, usageCount + 1);
    const slowMo = (video.isSlowMotionSuitable ?? false) ? 0.5 : 1.0;
    let rawDur = Math.max(
      0.5,
      Math.min(targetDur * slowMo, activeZone.end - activeZone.start),
    );
    let startTime =
      usageCount === 1
        ? Math.max(activeZone.start, activeZone.end - rawDur - 1.0)
        : activeZone.start +
          Math.random() *
            Math.max(0, activeZone.end - rawDur - activeZone.start);

    segments.push({
      sourceFile: video.filePath,
      startTime,
      rawDuration: rawDur,
      targetDuration: targetDur,
      ptsFactor: targetDur / rawDur,
      outputFile: path.join(
        tempDir,
        `segment_${segments.length.toString().padStart(3, "0")}.mp4`,
      ),
      isFirst: segments.length === 0,
      isLast: false,
      effect:
        segments.length === 0
          ? "fadeIn"
          : (video.motionIntensity ?? 0.5) < 0.4
            ? Math.random() > 0.5
              ? "zoomIn"
              : "zoomOut"
            : "none",
      slowMotionFactor: slowMo,
      sourceFps: video.fps ?? 30,
      transition: "dissolve",
      transitionDuration: 0.5,
    });
    accumulated += targetDur;
    beatIdx += Math.ceil(inst.beatsDuration);
  }
  if (segments.length > 0) {
    segments[segments.length - 1]!.isLast = true;
    segments[segments.length - 1]!.effect = "fadeOut";
  }
  return { segments, totalDuration: accumulated };
}
