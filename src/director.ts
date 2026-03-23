import * as path from "path";
import { spawn } from "child_process";
import {
  VideoInfo,
  VideoSegment,
  AIEditInstruction,
  AudioAnalysis,
  AudioSection,
  ZoomEffect,
  EntryEffect,
  ExitEffect,
} from "./types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cleanJSONString(rawStr: string): string {
  const mdMatch = rawStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (mdMatch) return mdMatch[1] ?? rawStr;
  const objMatch = rawStr.match(/\{[\s\S]*\}/);
  if (objMatch) return objMatch[0];
  return rawStr;
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

function shuffledPool(videos: VideoInfo[], keywords: string[] = []): VideoInfo[] {
  const kws = keywords.map((k) => k.toLowerCase());
  const keywordScore = (v: VideoInfo): number => {
    if (kws.length === 0) return 0;
    const text = ((v.tags?.join(" ") ?? "") + " " + (v.description ?? "")).toLowerCase();
    return kws.filter((k) => text.includes(k)).length / kws.length;
  };
  // Итоговый score: 70% aesthetic + 30% keyword coverage
  const sorted = [...videos].sort((a, b) => {
    const scoreA = (a.aestheticScore ?? 0) * 0.7 + keywordScore(a) * 10 * 0.3;
    const scoreB = (b.aestheticScore ?? 0) * 0.7 + keywordScore(b) * 10 * 0.3;
    return scoreB - scoreA;
  });
  const third = Math.ceil(sorted.length / 3);
  return [
    ...shuffle(sorted.slice(0, third)),
    ...shuffle(sorted.slice(third, third * 2)),
    ...shuffle(sorted.slice(third * 2)),
  ];
}

// ─── Публичные типы ───────────────────────────────────────────────────────────

/**
 * Результат анализа промпта одним вызовом LLM.
 * Заменяет два предыдущих вызова (preFilterFiles + getFilterDirectivesFromAI).
 */
export interface PromptAnalysis {
  dateStart: string | null;       // "YYYY-MM-DD" или null
  dateEnd: string | null;         // "YYYY-MM-DD" или null
  locationNames: string[];        // топонимы из промпта (оригинальный регистр)
  includeTravel: boolean;         // включать дорогу до/от места
  style: "cinematic" | "fast-paced" | "calm" | "vlog";
  priorityKeywords: string[];     // теги для повышения приоритета
  excludeKeywords: string[];      // теги для исключения
}

/** Результат прямого геокодинга топонима. */
export interface GeoLocation {
  name: string;
  lat: number;
  lon: number;
}

// ─── Гео-математика ───────────────────────────────────────────────────────────

export function haversineKm(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function minDistKm(video: VideoInfo, targets: GeoLocation[]): number | null {
  if (!video.location || targets.length === 0) return null;
  return Math.min(
    ...targets.map((t) =>
      haversineKm(video.location!.lat, video.location!.lon, t.lat, t.lon),
    ),
  );
}

// ─── Анализ промпта (один LLM-вызов) ──────────────────────────────────────────

/**
 * Единственный вызов LLM на весь пайплайн.
 * Извлекает всё: дату, топонимы, стиль, ключевые слова.
 * currentDate нужен для интерпретации "прошлогодний", "этим летом" и т.д.
 */
const TEXT_MODEL = "qwen3-coder:latest";

export async function analyzePrompt(
  prompt: string,
  currentDate: string,
  _modelName: string,
  availableTags: string[] = [],
): Promise<PromptAnalysis> {
  const year = new Date(currentDate).getFullYear();
  const prev = year - 1;
  const tagsBlock = availableTags.length > 0
    ? `\nLibrary tags (use as reference — prefer these exact strings when they match, but also add synonyms):\n${availableTags.join(", ")}\n`
    : "";
  const systemPrompt = `Today is ${currentDate}.
Analyze this video editing request and extract search parameters.

User request: "${prompt}"
${tagsBlock}
Respond ONLY with valid JSON:
{
  "dateStart": "YYYY-MM-DD or null",
  "dateEnd": "YYYY-MM-DD or null",
  "locationNames": [],
  "includeTravel": false,
  "style": "cinematic",
  "priorityKeywords": [],
  "excludeKeywords": []
}

Rules:
- dateStart/dateEnd: extract time range ONLY if the request explicitly mentions a time period. If no time is mentioned → both must be null. Do NOT default to today or current year.
  Year hints when time IS mentioned: "прошлый/прошлогодний" = ${prev}, "этот год" = ${year}.
  Season mapping (replace Y with the resolved year):
    summer/лето=Y-06-01..Y-08-31, early summer=Y-06-01..Y-06-30, mid summer=Y-07-01..Y-07-31, late summer/конец лета=Y-08-01..Y-08-31,
    autumn/осень=Y-09-01..Y-11-30, winter/зима=Y-12-01..(Y+1)-02-28, spring/весна=Y-03-01..Y-05-31.
  Combine: "прошлогодний" + "конец лета" → ${prev}-08-01 .. ${prev}-08-31.
- locationNames: ONLY named places explicitly mentioned in the request (rivers, mountains, cities, regions by name). Do NOT include generic landscape/content words (road, forest, mountain, car, river, highway, city) — those go into priorityKeywords. Do NOT include temporal words. Keep original spelling from the request.
- includeTravel: true if request implies travel (поездка, путешествие, ехали, дорога, trip).
- style: cinematic (default) | fast-paced | calm | vlog.
- priorityKeywords: extract ALL specific subjects/objects mentioned — include EVERY subject even if multiple are listed (e.g. "природа и автомобиль" → include both nature tags AND car tags). Do NOT include: style/mood words (epic, cinematic), overly generic words (road, sky, field, water). First pick matching tags from the library list above, then expand with synonyms. Example: "природа с автомобилем" → ["car","vehicle","suv","automobile","nature","wildlife","landscape","mountain","forest"]. Always English only.
- excludeKeywords: content to exclude — be exhaustive with synonyms. Example: "без людей" → ["people","person","man","woman","child","crowd","tourist","pedestrian","human","figure","silhouette","hiker","walker","group","couple"]. Match library tags first, then add all plausible variants in English.`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 290_000);
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: TEXT_MODEL,
        prompt: systemPrompt,
        format: "json",
        stream: false,
        keep_alive: "20m",
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    if (res.ok) {
      const data: any = await res.json();
      const parsed = JSON.parse(cleanJSONString(data.response));
      const promptLower = prompt.toLowerCase();
      const rawLocations: string[] = Array.isArray(parsed.locationNames) ? parsed.locationNames : [];
      // Keep only location names that actually appear in the user's prompt (anti-hallucination)
      const filteredLocations = rawLocations.filter(loc =>
        promptLower.includes(loc.toLowerCase())
      );
      return {
        dateStart: parsed.dateStart ?? null,
        dateEnd: parsed.dateEnd ?? null,
        locationNames: filteredLocations,
        includeTravel: parsed.includeTravel ?? false,
        style: parsed.style ?? "cinematic",
        priorityKeywords: Array.isArray(parsed.priorityKeywords) ? parsed.priorityKeywords : [],
        excludeKeywords: Array.isArray(parsed.excludeKeywords) ? parsed.excludeKeywords : [],
      };
    }
  } catch {}
  return {
    dateStart: null, dateEnd: null, locationNames: [],
    includeTravel: false, style: "cinematic",
    priorityKeywords: [], excludeKeywords: [],
  };
}

// ─── Геокодинг ────────────────────────────────────────────────────────────────

/**
 * Прямой геокодинг топонимов через Nominatim (OpenStreetMap).
 * Знает и "Мульта", и "Мультинские озёра", и любые другие географические объекты.
 */
export async function geocodeLocationNames(
  names: string[],
): Promise<GeoLocation[]> {
  const results: GeoLocation[] = [];
  for (const name of names) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&format=json&limit=1&accept-language=ru,en`;
      const res = await fetch(url, {
        headers: { "User-Agent": "automounter-video-editor/1.0" },
      });
      if (res.ok) {
        const data: any[] = await res.json();
        if (data[0]) {
          results.push({
            name,
            lat: parseFloat(data[0].lat),
            lon: parseFloat(data[0].lon),
          });
        }
      }
    } catch {}
    // Nominatim policy: не более 1 запроса в секунду
    if (names.length > 1) await new Promise((r) => setTimeout(r, 1100));
  }
  return results;
}

// ─── Пре-фильтрация (до индексации) ──────────────────────────────────────────

interface FileBasicInfo {
  id: string;
  date: string;
  lat?: number;
  lon?: number;
}

/**
 * Пре-фильтрация файлов ДО дорогостоящей индексации.
 * Комбинирует фильтрацию по дате и GPS-координатам.
 *
 * Если includeTravel=true:
 *   1. Находим "on-location" клипы (в радиусе 50 км от цели)
 *   2. Берём диапазон дат этих клипов — это и есть поездка
 *   3. Включаем ВСЕ клипы из этого диапазона (дорога туда/обратно)
 */
export interface PreFilterResult {
  ids: string[];
  tripDateRange: { start: string; end: string } | null; // реальный диапазон из GPS
}

export function preFilterByPrompt(
  analysis: PromptAnalysis,
  targets: GeoLocation[],
  files: FileBasicInfo[],
): PreFilterResult {
  // Шаг 1: фильтрация по дате
  let pool = files;
  if (analysis.dateStart) {
    pool = pool.filter((f) => f.date >= analysis.dateStart!);
  }
  if (analysis.dateEnd) {
    const end = analysis.dateEnd + "T23:59:59";
    pool = pool.filter((f) => f.date <= end);
  }

  const noGeo = (ids: string[]): PreFilterResult => ({ ids, tripDateRange: null });

  // Нет геолокации → только дата
  if (targets.length === 0) {
    return noGeo((pool.length > 0 ? pool : files).map((f) => f.id));
  }

  // Шаг 2: GPS-ближайшие (широкий радиус 300 км для пре-фильтра)
  const PREFILTER_KM = 300;
  const nearbyIds = new Set(
    pool
      .filter(
        (f) =>
          f.lat != null &&
          f.lon != null &&
          targets.some(
            (t) => haversineKm(f.lat!, f.lon!, t.lat, t.lon) < PREFILTER_KM,
          ),
      )
      .map((f) => f.id),
  );

  if (!analysis.includeTravel) {
    const combined = new Set([...pool.map((f) => f.id), ...nearbyIds]);
    const result = files.filter((f) => combined.has(f.id));
    return noGeo(result.length > 0 ? result.map((f) => f.id) : files.map((f) => f.id));
  }

  // Шаг 3: "Trip mode" — GPS важнее даты из LLM.
  // Ищем on-location файлы во ВСЕЙ библиотеке, дата LLM — подсказка, не фильтр.
  const ON_LOCATION_KM = 50;
  const allOnLocation = files.filter(
    (f) =>
      f.lat != null &&
      f.lon != null &&
      targets.some(
        (t) => haversineKm(f.lat!, f.lon!, t.lat, t.lon) < ON_LOCATION_KM,
      ),
  );

  let onLocation = allOnLocation;
  if (allOnLocation.length > 0 && (analysis.dateStart || analysis.dateEnd)) {
    const narrowed = allOnLocation.filter((f) => {
      if (analysis.dateStart && f.date < analysis.dateStart) return false;
      if (analysis.dateEnd && f.date > analysis.dateEnd + "T23:59:59") return false;
      return true;
    });
    if (narrowed.length > 0) onLocation = narrowed;
  }

  if (onLocation.length === 0) {
    const combined = new Set([...pool.map((f) => f.id), ...nearbyIds]);
    const result = files.filter((f) => combined.has(f.id));
    return noGeo(result.length > 0 ? result.map((f) => f.id) : files.map((f) => f.id));
  }

  // Дни поездки = точные даты on-location клипов + 1 день буфер
  const tripDays = onLocation.map((f) => f.date.slice(0, 10)).sort();
  const tripStart = tripDays[0]!;
  const tripEnd = tripDays[tripDays.length - 1]!;

  const startWithBuffer = new Date(tripStart);
  startWithBuffer.setDate(startWithBuffer.getDate() - 1);
  const endWithBuffer = new Date(tripEnd);
  endWithBuffer.setDate(endWithBuffer.getDate() + 1);
  const bufStart = startWithBuffer.toISOString().slice(0, 10);
  const bufEnd = endWithBuffer.toISOString().slice(0, 10);

  const onTrip = files.filter((f) => {
    const d = f.date.slice(0, 10);
    return d >= bufStart && d <= bufEnd;
  });

  const tripDateRange = { start: bufStart, end: bufEnd };
  const ids = onTrip.length > 0 ? onTrip.map((f) => f.id) : files.map((f) => f.id);
  return { ids, tripDateRange };
}

// ─── Релевантность клипа ──────────────────────────────────────────────────────

interface TripDateRange {
  start: string;
  end: string;
}

function calculateClipRelevance(
  video: VideoInfo,
  analysis: PromptAnalysis,
  targets: GeoLocation[],
  tripRange: TripDateRange | null,
  energy: number,
  usedCount: number,
): number {
  let score = 0;
  const text = (
    (video.tags?.join(" ") ?? "") +
    " " +
    (video.description ?? "")
  ).toLowerCase();

  // Штраф за исключённый контент
  if (analysis.excludeKeywords.some((k) => text.includes(k.toLowerCase())))
    score -= 15.0;

  // Штраф за повторное использование
  if (usedCount > 0) score -= 10.0 * usedCount;

  // Приоритетные ключевые слова
  for (const kw of analysis.priorityKeywords)
    if (text.includes(kw.toLowerCase())) score += 4.0;

  // Стиль
  if (analysis.style === "fast-paced")
    score += (video.motionIntensity ?? 0.5) * 2.0;
  else if (analysis.style === "calm")
    score += (1 - (video.motionIntensity ?? 0.5)) * 2.0;

  // Эстетика и соответствие энергии
  score += (video.aestheticScore ?? 5) / 2;
  score += (1 - Math.abs((video.motionIntensity ?? 0.5) - energy)) * 1.5;

  // GPS-скоринг: близость к целевой локации
  const dist = minDistKm(video, targets);
  if (dist !== null) {
    if (dist < 5) score += 22;        // точно на месте
    else if (dist < 30) score += 14;  // рядом
    else if (dist < 100) score += 7;  // та же зона
    else if (dist > 500) score -= 6;  // далеко, вероятно другая поездка
  } else if (targets.length > 0 && tripRange) {
    // GPS нет в метаданных — проверяем по датам поездки
    const d = video.creationDate.slice(0, 10);
    if (d >= tripRange.start && d <= tripRange.end) score += 8;
  }

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
  analysis: PromptAnalysis,
  targets: GeoLocation[],
  tripRange: TripDateRange | null,
  targetDurationSeconds: number,
): AIEditInstruction[] {
  const beats = audioAnalysis.beats;
  const instructions: AIEditInstruction[] = [];
  const pool = shuffledPool(videos, analysis.priorityKeywords);
  const usedCountMap = new Map<string, number>();
  let beatsUsed = 0;
  let accumulatedSecs = 0;
  const recentIds: string[] = [];

  while (beatsUsed < beats.length && accumulatedSecs < targetDurationSeconds) {
    const currentSec = beats[beatsUsed] ?? 0;
    const currentEnergy = getEnergyAtBeat(currentSec, audioAnalysis.sections);

    // Длина сегмента зависит от энергии: тихо → длинные кадры, громко → быстрые cuts
    let chunkSize: number;
    if (currentEnergy > 0.80) {
      chunkSize = [2, 2, 4][instructions.length % 3] ?? 2;       // 2–4 бита
    } else if (currentEnergy > 0.60) {
      chunkSize = [4, 4, 8][instructions.length % 3] ?? 4;       // 4–8 битов
    } else if (currentEnergy > 0.35) {
      chunkSize = [8, 4, 8, 16][instructions.length % 4] ?? 8;   // 4–16 битов
    } else {
      chunkSize = [16, 8, 16, 32][instructions.length % 4] ?? 16; // 8–32 бита (тихие участки)
    }
    const t1 = audioAnalysis.beats[beatsUsed];
    if (t1 === undefined) break;

    // Если полный чанк выходит за цель — пробуем минимальный (4 бита)
    let t2 = audioAnalysis.beats[beatsUsed + chunkSize];
    if (t2 !== undefined) {
      const fullEnd = findNearestPeak(t2, audioAnalysis.peaks, 0.15);
      if (accumulatedSecs + (fullEnd - t1) > targetDurationSeconds + 2 && chunkSize > 4) {
        chunkSize = 4;
        t2 = audioAnalysis.beats[beatsUsed + chunkSize];
      }
    }
    if (t2 === undefined) break;
    let effectiveEnd = findNearestPeak(t2, audioAnalysis.peaks, 0.15);
    const segDuration = effectiveEnd - t1;
    if (accumulatedSecs + segDuration > targetDurationSeconds + 2) break;

    let chosen: VideoInfo | undefined;
    let bestScore = -Infinity;
    for (const candidate of pool) {
      const uses = usedCountMap.get(candidate.id) ?? 0;
      const maxUses = Math.max(2, (candidate.bestSegments?.length ?? 0) || candidate.validZones.length);
      if (uses >= maxUses) continue;
      if (recentIds.includes(candidate.id) && pool.length > 3) continue;
      const score = calculateClipRelevance(
        candidate,
        analysis,
        targets,
        tripRange,
        currentEnergy,
        uses,
      );
      if (score > bestScore) {
        bestScore = score;
        chosen = candidate;
      }
    }
    if (chosen) {
      instructions.push({ clipId: chosen.id, beatsDuration: chunkSize });
      usedCountMap.set(chosen.id, (usedCountMap.get(chosen.id) ?? 0) + 1);
      recentIds.push(chosen.id);
      if (recentIds.length > 10) recentIds.shift();
      accumulatedSecs += segDuration;
    } else break;
    beatsUsed += chunkSize;
  }
  return instructions;
}

// ─── AI Content Filter ────────────────────────────────────────────────────────

async function filterByContentAI(
  videos: VideoInfo[],
  analysis: PromptAnalysis,
): Promise<VideoInfo[]> {
  if (videos.length <= 15) return videos;

  // Топ-60 по aesthetic score, разбиваем на батчи по 10 и отправляем параллельно
  const candidates = [...videos]
    .sort((a, b) => (b.aestheticScore ?? 0) - (a.aestheticScore ?? 0))
    .slice(0, 60);

  const requestDesc = [
    analysis.priorityKeywords.slice(0, 10).join(", "),
    analysis.excludeKeywords.length ? `EXCLUDE: ${analysis.excludeKeywords.slice(0, 5).join(", ")}` : "",
    analysis.locationNames.length ? `location: ${analysis.locationNames.join(", ")}` : "",
  ].filter(Boolean).join(". ");

  // Ollama обрабатывает запросы последовательно — батчи идут один за другим.
  // Оптимизация: компактный формат строки (меньше токенов = быстрее генерация).
  const BATCH_SIZE = 10;
  const batches: VideoInfo[][] = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE)
    batches.push(candidates.slice(i, i + BATCH_SIZE));

  const filterBatch = async (batch: VideoInfo[]): Promise<string[]> => {
    // Сверхкомпактный формат: id:tag1,tag2|desc (экономим ~50% токенов)
    const lines = batch.map((v) => {
      const tags = (v.tags ?? []).slice(0, 4).join(",");
      const desc = (v.description ?? "").slice(0, 50);
      return `${v.id}:${tags}|${desc}`;
    });
    const prompt = `Match:"${requestDesc}"\nKeep relevant, reject excluded.\n${lines.join("\n")}\nJSON:{"keep":["id",...]}`;

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60_000);
      const res = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: TEXT_MODEL, prompt, format: "json", stream: false, keep_alive: "20m",
          options: { num_predict: 128, temperature: 0.1 } }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      if (!res.ok) return batch.map((v) => v.id);
      const data: any = await res.json();
      const parsed = JSON.parse(cleanJSONString(data.response));
      return Array.isArray(parsed.keep) ? parsed.keep.filter((id: any) => typeof id === "string") : batch.map((v) => v.id);
    } catch {
      return batch.map((v) => v.id);
    }
  };

  try {
    const allKept: string[] = [];
    for (const batch of batches) {
      const kept = await filterBatch(batch);
      allKept.push(...kept);
    }
    const keptSet = new Set(allKept);
    const approved = candidates.filter((v) => keptSet.has(v.id));

    if (approved.length < 5) return videos;

    const nonCandidates = videos.filter((v) => !candidates.some((c) => c.id === v.id));
    const supplemented = approved.length >= 20
      ? approved
      : [...approved, ...nonCandidates.slice(0, 30 - approved.length)];

    console.log(`AI content filter: ${approved.length}/${candidates.length} clips kept (of ${videos.length} total)`);
    return supplemented;
  } catch {
    return videos;
  }
}

// ─── LLM Director ─────────────────────────────────────────────────────────────

async function buildLLMInstructions(
  videos: VideoInfo[],
  analysis: PromptAnalysis,
  audioAnalysis: AudioAnalysis,
  targetDurationSeconds: number,
): Promise<AIEditInstruction[] | null> {
  // Топ-30 по скорингу + shuffle — вдвое меньше токенов в промпте → быстрее prefill
  const scored = shuffledPool(videos, analysis.priorityKeywords).slice(0, 30);
  // Компактный формат: shortName вместо полного ID (экономия ~20 символов на строку)
  const clipLines = scored.map((v) => {
    const zoneCount = v.bestSegments?.length || v.validZones.length;
    const shortName = path.basename(v.filePath).replace(/^DJI_\d+_(\d+)_D\.MP4$/i, "DJI_$1").slice(0, 16);
    const tags = (v.tags ?? []).slice(0, 4).join(",");
    const loc = v.location?.address ? ` [${v.location.address.split(",")[0]}]` : "";
    const sm = v.isSlowMotionSuitable ? "~" : "";
    return `${shortName} ${tags} ${v.duration.toFixed(0)}s sc:${(v.aestheticScore ?? 0).toFixed(1)} m:${(v.motionIntensity ?? 0.5).toFixed(2)} z:${zoneCount}${sm}${loc}`;
  });

  const windowSize = 15;
  const audioParts: string[] = [];
  for (let t = 0; t < targetDurationSeconds; t += windowSize) {
    const energy = getEnergyAtBeat(t, audioAnalysis.sections);
    const style = audioAnalysis.sections.find((s) => t >= s.start && t < s.end)?.style ?? audioAnalysis.style;
    audioParts.push(`${t}-${Math.min(t + windowSize, targetDurationSeconds)}s: energy=${energy.toFixed(2)} ${style}`);
  }

  const avgBeatSec = audioAnalysis.beats.length > 1
    ? (audioAnalysis.beats[audioAnalysis.beats.length - 1]! - audioAnalysis.beats[0]!) / audioAnalysis.beats.length
    : 0.5;

  const prompt = `You are a professional video editor. Create a ${analysis.style} music video edit plan.
The clips below are in RANDOM order — you must deliberately reorder them to build a narrative arc.

TARGET: ${targetDurationSeconds}s total. Beat ≈ ${avgBeatSec.toFixed(2)}s each.
KEYWORDS: ${analysis.priorityKeywords.slice(0, 6).join(", ") || "none"}

AUDIO ENERGY PROFILE (place clips accordingly):
${audioParts.join("\n")}

CLIPS (id shortname tags dur sc:score m:motion z:zones ~ =slowmo):
${clipLines.join("\n")}

RULES:
- Select the best clips and arrange them for a narrative arc: calm opening → build-up → climax → resolution.
- A clip with z:N zones can appear up to N times (different parts each time).
- Prefer clips with high score. Use slowmo (~) clips near energy peaks.
- Return enough clip IDs to fill ${targetDurationSeconds}s. Estimate ~${Math.max(2, avgBeatSec * 4).toFixed(1)}s per clip → need ~${Math.ceil(targetDurationSeconds / Math.max(2, avgBeatSec * 4))} clips. Clips with z>1 can repeat. Max ${Math.min(scored.length * 2, 40)} IDs.

Respond ONLY with JSON: {"s":["id1","id2","id3",...]}
`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 290_000);
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: TEXT_MODEL, prompt, format: "json", stream: false, keep_alive: "20m",
        options: { num_predict: 512, temperature: 0.3 } }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!res.ok) { console.log(`LLM phase 1 HTTP error: ${res.status}`); return null; }
    const data: any = await res.json();
    let parsed: any;
    try { parsed = JSON.parse(cleanJSONString(data.response)); }
    catch { console.log(`LLM phase 1 JSON parse failed: ${String(data.response).slice(0, 200)}`); return null; }
    // LLM возвращает только упорядоченный массив ID: {"s":["id1","id2",...]}
    const rawIds: any[] = Array.isArray(parsed.s) ? parsed.s : [];
    const videoIds = new Set(videos.map((v) => v.id));
    // shortName → fullId на случай если LLM вернул сокращённое имя
    const shortToFull = new Map(scored.map((v) => [
      path.basename(v.filePath).replace(/^DJI_\d+_(\d+)_D\.MP4$/i, "DJI_$1").slice(0, 16),
      v.id,
    ]));

    const orderedIds = rawIds
      .filter((id): id is string => typeof id === "string")
      .map((id) => videoIds.has(id) ? id : (shortToFull.get(id) ?? null))
      .filter((id): id is string => id !== null && videoIds.has(id));

    console.log(`LLM phase 1 raw: ${rawIds.length} ids, matched: ${orderedIds.length}`);
    if (orderedIds.length === 0) return null;
    const maxClips = Math.min(40, Math.ceil(targetDurationSeconds / Math.max(2, avgBeatSec * 4)) + 5);
    const cappedIds = orderedIds.slice(0, maxClips);
    console.log(`LLM director phase 1: ordered ${cappedIds.length} clips`);

    // ── Фаза 2: эффекты для выбранных клипов ─────────────────────────────────
    // Оцениваем позицию каждого клипа в таймлайне (приблизительно, 4 бита = avgBeatSec*4)
    const approxSegDur = avgBeatSec * 4;
    const videoMap = new Map(videos.map((v) => [v.id, v]));
    // shortName в phase 2 — ID в ответе будут короче (~8 vs ~29 символов)
    const p2ShortToFull = new Map<string, string>();
    const effectLines = cappedIds.map((id, i) => {
      const v = videoMap.get(id);
      const sn = path.basename(id).replace(/^DJI_\d+_(\d+)_D\.MP4$/i, "DJI_$1").slice(0, 16);
      p2ShortToFull.set(sn, id);
      const t = i * approxSegDur;
      const energy = getEnergyAtBeat(t, audioAnalysis.sections);
      const sm = v?.isSlowMotionSuitable ? "~" : "";
      const motion = (v?.motionIntensity ?? 0.5).toFixed(2);
      return `${sn} t:${t.toFixed(0)}s en:${energy.toFixed(2)} m:${motion}${sm}`;
    });

    const effectPrompt = `Assign creative effects for each clip in this ${analysis.style} video edit.
For each clip you see: id, timeline position (t), audio energy (en:0-1), motion (m:0-1), ~ = slowmo.

CLIPS:
${effectLines.join("\n")}

RULES (be specific per clip, not generic):
- z: zoom direction — "zoomIn"|"zoomOut"|"none". Use on at most 1 clip total (the most visually calm one, m<0.4). All others must be "none".
- e: entry effect — "fadeIn"|"flashIn"|"none". flashIn only at high energy (en>0.7). First clip always "fadeIn". Most clips should be "none".
- x: exit effect — "fadeOut"|"flashOut"|"none". Last clip always "fadeOut". Use sparingly, most clips "none".
- sp: playback speed — 0.3-0.5 for slowmo (~) clips at peaks, 1.4 for fast action, 1.0 default.
- t: transition to NEXT clip — "hard"|"dissolve". dissolve only when en<0.4.
- n: which part of clip — "start"|"middle"|"end".

Respond ONLY with JSON: {"s":[{"i":"id","z":"none","e":"none","x":"none","sp":1.0,"t":"hard","n":"start"},...]}`;

    const ctrl2 = new AbortController();
    const t2 = setTimeout(() => ctrl2.abort(), 290_000);
    const res2 = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: TEXT_MODEL, prompt: effectPrompt, format: "json", stream: false, keep_alive: "20m",
        options: { temperature: 0.3 } }),
      signal: ctrl2.signal,
    }).finally(() => clearTimeout(t2));

    const validZoom = new Set(["zoomIn", "zoomOut", "none"]);
    const validEntry = new Set(["fadeIn", "flashIn", "none"]);
    const validExit = new Set(["fadeOut", "flashOut", "none"]);
    const validZone = new Set(["start", "middle", "end"]);

    let effectMap = new Map<string, Partial<AIEditInstruction>>();
    if (!res2.ok) {
      console.log(`LLM phase 2 HTTP error: ${res2.status}`);
    } else {
      const d2: any = await res2.json();
      let p2: any;
      try { p2 = JSON.parse(cleanJSONString(d2.response)); }
      catch (e) {
        console.log(`LLM phase 2 JSON parse failed (response truncated?): ${String(d2.response).slice(-100)}`);
        p2 = {};
      }
      const segs2: any[] = Array.isArray(p2.s) ? p2.s : [];
      for (const s of segs2) {
        const rawId = s.i ?? s.id;
        if (typeof rawId !== "string") continue;
        const id = p2ShortToFull.get(rawId) ?? rawId; // резолвим shortName → fullId
        effectMap.set(id, {
          zoomEffect: validZoom.has(s.z) ? s.z : undefined,
          entryEffect: validEntry.has(s.e) ? s.e : undefined,
          exitEffect: validExit.has(s.x) ? s.x : undefined,
          speedFactor: typeof s.sp === "number" ? Math.max(0.3, Math.min(2.0, s.sp)) : undefined,
          transition: s.t === "hard" ? "hard" : s.t === "dissolve" ? "dissolve" : undefined,
          transitionDuration: s.t === "dissolve" ? 0.5 : 0.0,
          zoneHint: validZone.has(s.n) ? s.n : undefined,
        });
      }
      console.log(`LLM director phase 2: effects for ${effectMap.size} clips`);
    }

    const instructions: AIEditInstruction[] = cappedIds.map((id) => ({
      clipId: id,
      beatsDuration: 0, // 0 = sentinel: createDirectorPlan вычислит по энергии
      ...effectMap.get(id),
    }));
    return instructions;
  } catch (err) {
    console.log(`LLM director failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}


// ─── Exports ──────────────────────────────────────────────────────────────────

// ─── Visual Deduplication ─────────────────────────────────────────────────────

function extractFramePixels(file: string, t: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const proc = spawn("ffmpeg", [
      "-ss", t.toFixed(3), "-i", file, "-vframes", "1",
      "-vf", "scale=32:32:force_original_aspect_ratio=disable,format=gray",
      "-f", "rawvideo", "pipe:1",
    ], { stdio: ["ignore", "pipe", "ignore"] });
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    const timer = setTimeout(() => { proc.kill(); resolve(null); }, 6000);
    proc.on("close", () => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      resolve(buf.length >= 1024 ? buf.subarray(0, 1024) : null);
    });
    proc.on("error", () => { clearTimeout(timer); resolve(null); });
  });
}

function aHash(pixels: Buffer): Uint8Array {
  let sum = 0;
  for (let i = 0; i < pixels.length; i++) sum += pixels[i]!;
  const mean = sum / pixels.length;
  return Uint8Array.from(pixels, (p) => (p > mean ? 1 : 0));
}

function hammingDist(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

async function deduplicateSegments(segments: VideoSegment[]): Promise<VideoSegment[]> {
  const THRESHOLD = 25; // из 256 бит; < 25 = визуально идентичны
  const CONCURRENCY = 4;

  // Извлекаем кадр из середины каждого сегмента
  const hashes: Array<Uint8Array | null> = new Array(segments.length).fill(null);
  let i = 0;
  const worker = async () => {
    while (i < segments.length) {
      const idx = i++;
      const seg = segments[idx]!;
      const t = seg.startTime + seg.rawDuration * 0.5;
      const pixels = await extractFramePixels(seg.sourceFile, t);
      hashes[idx] = pixels ? aHash(pixels) : null;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const kept: VideoSegment[] = [];
  const keptHashes: Uint8Array[] = [];
  let removed = 0;

  for (let j = 0; j < segments.length; j++) {
    const hash = hashes[j];
    if (!hash) { kept.push(segments[j]!); keptHashes.push(new Uint8Array(1024)); continue; }

    const isDuplicate = keptHashes.some((h) => hammingDist(hash, h) < THRESHOLD);
    if (isDuplicate) {
      removed++;
    } else {
      kept.push(segments[j]!);
      keptHashes.push(hash);
    }
  }

  if (removed > 0) console.log(`Visual dedup: removed ${removed} near-identical segments`);
  return kept;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export async function createDirectorPlan(
  analysis: PromptAnalysis,
  targets: GeoLocation[],
  videos: VideoInfo[],
  audioAnalysis: AudioAnalysis,
  targetDurationSeconds: number,
  tempDir: string,
): Promise<{ segments: VideoSegment[]; totalDuration: number }> {
  const withZones = videos.filter((v) => v.validZones.length > 0);
  const textOf = (v: VideoInfo) =>
    ((v.tags?.join(" ") ?? "") + " " + (v.description ?? "")).toLowerCase();

  // Жёсткое исключение по excludeKeywords
  const afterExclude = withZones.filter((v) => {
    if (analysis.excludeKeywords.length === 0) return true;
    return !analysis.excludeKeywords.some((k) => textOf(v).includes(k.toLowerCase()));
  });

  // Жёсткий фильтр по priorityKeywords — всегда, если они есть.
  // "машина в кадре" = обязательное условие независимо от наличия даты/локации.
  // Прогрессивный откат: если совпадений нет — снижаем порог, затем снимаем фильтр.
  const afterInclude = (() => {
    if (analysis.priorityKeywords.length === 0) return afterExclude;
    const kws = analysis.priorityKeywords.map((k) => k.toLowerCase());
    // Полное совпадение: хотя бы одно ключевое слово в тегах/описании
    const strict = afterExclude.filter((v) => kws.some((k) => textOf(v).includes(k)));
    if (strict.length >= 5) return strict;
    // Частичное: хотя бы одно слово из keyword содержится как подстрока
    const partial = afterExclude.filter((v) =>
      kws.some((k) => k.split(" ").some((word) => word.length > 3 && textOf(v).includes(word))),
    );
    if (partial.length >= 5) return partial;
    // Совсем ничего не нашлось — используем без content-фильтра
    return afterExclude;
  })();

  // Если фильтры убили слишком много — откатываемся (не ломаем монтаж)
  const MIN_VIDEOS = 5;
  const preEffective =
    afterInclude.length >= MIN_VIDEOS
      ? afterInclude
      : afterExclude.length >= MIN_VIDEOS
        ? afterExclude
        : withZones;

  // AI content filter: всегда при excludeKeywords (чтобы поймать людей с нестандартными тегами),
  // или если пул большой, или если нет keyword-фильтра.
  const needsAiFilter = analysis.excludeKeywords.length > 0 ||
    preEffective.length > 80 ||
    (analysis.priorityKeywords.length === 0 && preEffective.length > 15);
  const aiFiltered = needsAiFilter
    ? await filterByContentAI(preEffective, analysis)
    : preEffective;
  const effective = aiFiltered.length >= MIN_VIDEOS ? aiFiltered : preEffective;

  console.log(
    `Director: ${effective.length}/${videos.length} clips selected` +
    (analysis.priorityKeywords.length > 0 ? ` [keywords: ${analysis.priorityKeywords.slice(0, 4).join(", ")}]` : "") +
    (analysis.excludeKeywords.length > 0 ? ` [exclude: ${analysis.excludeKeywords.slice(0, 4).join(", ")}]` : "") +
    (analysis.locationNames.length > 0 ? ` [location: ${analysis.locationNames.join(", ")}]` : "")
  );

  // Определяем диапазон поездки по on-location видео (для GPS-безопасного скоринга)
  let tripRange: TripDateRange | null = null;
  if (analysis.includeTravel && targets.length > 0) {
    const onLocation = effective.filter((v) => {
      const d = minDistKm(v, targets);
      return d !== null && d < 50;
    });
    if (onLocation.length > 0) {
      const days = onLocation.map((v) => v.creationDate.slice(0, 10)).sort();
      tripRange = { start: days[0]!, end: days[days.length - 1]! };
    }
  }

  // Сначала пробуем LLM-режиссёра, fallback на алгоритм
  const llmPlan = await buildLLMInstructions(effective, analysis, audioAnalysis, targetDurationSeconds);
  const autoPlan = llmPlan ?? buildAutoInstructions(
    effective, audioAnalysis, analysis, targets, tripRange, targetDurationSeconds,
  );
  if (llmPlan) console.log("Using LLM director plan");
  else console.log("Using algorithmic director plan (LLM fallback)");

  const segments: VideoSegment[] = [];
  let accumulated = 0;
  let beatIdx = 0;
  let zoomUsed = false; // максимум 1 zoom на весь ролик
  const clipUsageTimes = new Map<string, number>();

  for (const inst of autoPlan) {
    if (accumulated >= targetDurationSeconds) break;

    // Определяем размер чанка в битах
    // beatsDuration=0 (sentinel от LLM-директора) → вычисляем по энергии аудио
    const currentSec = audioAnalysis.beats[beatIdx] ?? 0;
    const currentEnergy = getEnergyAtBeat(currentSec, audioAnalysis.sections);
    let chunkSize: number;
    if (inst.beatsDuration && inst.beatsDuration > 0) {
      chunkSize = inst.beatsDuration;
    } else if (currentEnergy > 0.80) {
      chunkSize = [2, 2, 4][segments.length % 3] ?? 2;
    } else if (currentEnergy > 0.60) {
      chunkSize = [4, 4, 8][segments.length % 3] ?? 4;
    } else if (currentEnergy > 0.35) {
      chunkSize = [8, 4, 8, 16][segments.length % 4] ?? 8;
    } else {
      chunkSize = [16, 8, 16, 32][segments.length % 4] ?? 16;
    }

    // Для первого сегмента t1=0: покрывает вступление аудио до первого бита.
    // Иначе cuts будут опережать аудио на beats[0] секунд.
    const isIntro = segments.length === 0;
    const t1 = isIntro ? 0 : audioAnalysis.beats[beatIdx];
    if (t1 === undefined) break;

    let t2 = audioAnalysis.beats[beatIdx + chunkSize];
    if (t2 !== undefined) {
      const fullEnd = findNearestPeak(t2, audioAnalysis.peaks, 0.15);
      if (accumulated + (fullEnd - t1) > targetDurationSeconds + 2 && chunkSize > 4) {
        chunkSize = 4;
        t2 = audioAnalysis.beats[beatIdx + chunkSize];
      }
    }
    if (t2 === undefined) break;
    const endT = findNearestPeak(t2, audioAnalysis.peaks, 0.15);
    const targetDur = endT - t1;
    if (accumulated + targetDur > targetDurationSeconds + 2) break;

    const video = effective.find((v) => v.id === inst.clipId);
    if (!video) { beatIdx += chunkSize; continue; }
    const usageCount = clipUsageTimes.get(video.id) ?? 0;
    const zones = (
      video.bestSegments?.length ? video.bestSegments : video.validZones
    ).slice().sort((a, b) => (b.end - b.start) - (a.end - a.start));
    const activeZone = zones[usageCount % zones.length] ?? zones[0];
    if (!activeZone) { beatIdx += chunkSize; continue; }

    clipUsageTimes.set(video.id, usageCount + 1);

    // Скорость: LLM имеет приоритет, иначе эвристика
    const energy = getEnergyAtBeat(Math.max(t1, audioAnalysis.beats[0] ?? 0), audioAnalysis.sections);
    const motion = video.motionIntensity ?? 0.5;
    const introBeat0 = audioAnalysis.beats[0] ?? 0;
    let playbackFactor: number;
    if (isIntro && introBeat0 > 0.5) {
      // Вступление до первого бита — slow-mo для плавного открытия
      playbackFactor = video.isSlowMotionSuitable ? 0.3 : 0.5;
    } else if (inst.speedFactor !== undefined) {
      playbackFactor = inst.speedFactor;
    } else if (video.isSlowMotionSuitable) {
      playbackFactor = 0.5;
    } else if (energy > 0.72 && motion > 0.55 && analysis.style !== "calm") {
      playbackFactor = 1.4;
    } else if (motion < 0.35 && analysis.style !== "fast-paced") {
      playbackFactor = 0.7;
    } else {
      playbackFactor = 1.0;
    }

    const rawDur = Math.max(0.5, Math.min(targetDur * playbackFactor, activeZone.end - activeZone.start));
    const zoneLen = activeZone.end - activeZone.start;
    let startTime: number;
    if (inst.zoneHint === "end") {
      startTime = Math.max(activeZone.start, activeZone.end - rawDur);
    } else if (inst.zoneHint === "middle") {
      startTime = activeZone.start + Math.max(0, (zoneLen - rawDur) / 2);
    } else if (usageCount === 1) {
      startTime = Math.max(activeZone.start, activeZone.end - rawDur - 1.0);
    } else {
      startTime = activeZone.start + Math.random() * Math.max(0, zoneLen - rawDur);
    }

    // Эффекты: LLM имеет приоритет, иначе эвристика
    const pos = segments.length;
    let zoomEffect: ZoomEffect;
    let entryEffect: EntryEffect;
    let exitEffect: ExitEffect;

    // Zoom: максимум 1 раз на весь ролик, только на стабильном кадре
    if (zoomUsed) {
      zoomEffect = "none";
    } else if (inst.zoomEffect !== undefined && inst.zoomEffect !== "none") {
      zoomEffect = inst.zoomEffect;
      zoomUsed = true;
    } else if (!zoomUsed && motion < 0.4 && pos > 0 && pos % 4 === 0) {
      zoomEffect = pos % 8 === 0 ? "zoomIn" : "zoomOut";
      zoomUsed = true;
    } else {
      zoomEffect = "none";
    }

    // entry/exit: LLM "none" не переопределяет алгоритм — только явные non-none значения
    if (inst.entryEffect !== undefined && inst.entryEffect !== "none") {
      entryEffect = inst.entryEffect;
    } else if (pos === 0) {
      entryEffect = "fadeIn";
    } else if (energy > 0.75 && pos % 3 === 0) {
      entryEffect = "flashIn";
    } else if (energy < 0.35 && pos % 5 === 0) {
      entryEffect = "fadeIn"; // мягкий вход в тихих участках
    } else {
      entryEffect = "none";
    }

    if (inst.exitEffect !== undefined && inst.exitEffect !== "none") {
      exitEffect = inst.exitEffect;
    } else if (energy < 0.35 && pos % 5 === 2) {
      exitEffect = "fadeOut"; // мягкий выход в тихих участках
    } else {
      exitEffect = "none";
    }

    segments.push({
      sourceFile: video.filePath,
      startTime,
      rawDuration: rawDur,
      targetDuration: targetDur,
      ptsFactor: targetDur / rawDur,
      outputFile: path.join(tempDir, `segment_${segments.length.toString().padStart(3, "0")}.mp4`),
      isFirst: pos === 0,
      isLast: false,
      zoomEffect,
      entryEffect,
      exitEffect,
      slowMotionFactor: playbackFactor,
      transition: inst.transition ?? "hard",
      transitionDuration: inst.transitionDuration ?? 0.0,
      sourceFps: video.fps ?? 30,
    });
    accumulated += targetDur;
    beatIdx += chunkSize;
  }
  const deduped = await deduplicateSegments(segments);

  if (deduped.length > 0) {
    deduped[deduped.length - 1]!.isLast = true;
    deduped[deduped.length - 1]!.exitEffect = "fadeOut";
    deduped[0]!.isFirst = true;
  }
  const totalDuration = deduped.reduce((s, seg) => s + seg.targetDuration, 0);
  return { segments: deduped, totalDuration };
}
