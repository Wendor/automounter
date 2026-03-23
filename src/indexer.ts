import * as fs from "fs";
import * as path from "path";
import ffmpeg from "fluent-ffmpeg";
import { VideoInfo, ValidZone } from "./types";
import { cleanJSONString, safeDelete } from "./utils";
import { reverseGeocode } from "./services/geocoding";
import { CACHE_VERSION, OLLAMA_URL, LLM_KEEP_ALIVE } from "./constants";
const DEV_NULL = process.platform === "win32" ? "NUL" : "/dev/null";

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
  detectedObjects: string[];
}

interface CacheFile extends VideoInfo {
  _cacheVersion?: number;
  _fileSize?: number;
}

interface VideoMetrics {
  blackIntervals: ValidZone[];
  sceneChanges: number[];
}

function safeString(input: any): string | null {
  if (typeof input === "string") return input.trim();
  if (typeof input === "object" && input !== null) {
    const val =
      input.name ||
      input.tag ||
      input.label ||
      input.object ||
      Object.values(input)[0];
    if (typeof val === "string") return val.trim();
  }
  return null;
}

function cleanAiArray(input: any): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map(safeString)
    .filter(
      (s): s is string => s !== null && s !== "" && s !== "[object Object]",
    );
}


function extractGpsFromSrt(
  srtPath: string,
): { lat: number; lon: number } | undefined {
  try {
    if (!fs.existsSync(srtPath)) return undefined;
    const content = fs.readFileSync(srtPath, "utf8").slice(0, 20000);
    const latMatch = content.match(/\[latitude:\s*([+-]?\d+\.\d+)\]/i);
    const lonMatch = content.match(/\[longitude:\s*([+-]?\d+\.\d+)\]/i);
    if (latMatch && lonMatch) {
      const lat = parseFloat(latMatch[1]!);
      const realLon = parseFloat(lonMatch[1]!);
      if (!isNaN(lat) && !isNaN(realLon)) return { lat, lon: realLon };
    }
  } catch (e) {}
  return undefined;
}

function extractGpsData(
  tags: any,
  videoPath: string,
): { lat: number; lon: number; source: string } | undefined {
  const srtPath = videoPath.replace(/\.[^.]+$/, ".srt");
  const srtGps = extractGpsFromSrt(srtPath);
  if (srtGps) return { ...srtGps, source: "SRT" };
  const locTag =
    tags?.location ||
    tags?.["com.apple.quicktime.location.ISO6709"] ||
    tags?.["com.dji.common.model.GPS"];
  if (locTag && typeof locTag === "string") {
    const isoMatch = locTag.match(/([+-]\d+\.\d+)([+-]\d+\.\d+)/);
    if (isoMatch) {
      const lat = parseFloat(isoMatch[1]!);
      const lon = parseFloat(isoMatch[2]!);
      if (!isNaN(lat) && !isNaN(lon)) return { lat, lon, source: "Meta" };
    }
  }
  return undefined;
}

async function analyzeVideoMetrics(
  filePath: string,
  duration: number,
): Promise<VideoMetrics> {
  return new Promise((resolve) => {
    const blackIntervals: ValidZone[] = [];
    const sceneChanges: number[] = [];
    const stderrLines: string[] = [];
    const vf = [
      "scale=320:-1",
      "blackdetect=d=0.1:pic_th=0.90:pix_th=0.10",
      "select='gt(scene,0.4)',showinfo",
    ].join(",");
    const inputOpts = [];
    if (process.platform === "darwin")
      inputOpts.push("-hwaccel", "videotoolbox");
    inputOpts.push(
      "-skip_frame",
      "nokey",
      "-t",
      String(Math.min(duration, 600)),
    );
    ffmpeg(filePath)
      .inputOptions(inputOpts)
      .outputOptions(["-vf", vf, "-an", "-f", "null"])
      .on("stderr", (line: string) => stderrLines.push(line))
      .on("end", () => {
        for (const line of stderrLines) {
          const blackRe = /black_start:([\d.]+)\s+black_end:([\d.]+)/g;
          const sceneRe = /pts_time:([\d.]+)/g;
          let m: RegExpExecArray | null;
          while ((m = blackRe.exec(line)) !== null)
            blackIntervals.push({
              start: parseFloat(m[1]!),
              end: parseFloat(m[2]!),
            });
          while ((m = sceneRe.exec(line)) !== null)
            sceneChanges.push(parseFloat(m[1]!));
        }
        resolve({ blackIntervals, sceneChanges });
      })
      .on("error", (err) => {
        resolve({ blackIntervals: [], sceneChanges: [] });
      })
      .save(DEV_NULL);
  });
}

function calculateValidZones(
  duration: number,
  blackIntervals: ValidZone[] = [],
): ValidZone[] {
  const margin = duration * 0.1;
  const safeStart = margin;
  const safeEnd = duration - margin;
  if (safeEnd <= safeStart) return [{ start: 0, end: duration }];
  if (blackIntervals.length === 0) return [{ start: safeStart, end: safeEnd }];
  const zones: ValidZone[] = [];
  let cursor = safeStart;
  for (const black of [...blackIntervals].sort((a, b) => a.start - b.start)) {
    if (black.end <= cursor) continue;
    if (black.start > cursor)
      zones.push({ start: cursor, end: Math.min(black.start, safeEnd) });
    cursor = Math.max(cursor, black.end);
    if (cursor >= safeEnd) break;
  }
  if (cursor < safeEnd) zones.push({ start: cursor, end: safeEnd });
  const usable = zones.filter((z) => z.end - z.start >= 1.0);
  return usable.length > 0 ? usable : [{ start: safeStart, end: safeEnd }];
}

function selectKeyframeTimes(
  activeZone: ValidZone,
  sceneChanges: number[],
  duration: number,
): number[] {
  const maxFrames = Math.min(10, Math.max(4, Math.floor(duration / 15)));
  const zoneLen = activeZone.end - activeZone.start;
  const inZone = sceneChanges.filter(
    (t) => t >= activeZone.start && t <= activeZone.end,
  );
  if (inZone.length === 0)
    return Array.from(
      { length: maxFrames },
      (_, i) => activeZone.start + (zoneLen * (i + 1)) / (maxFrames + 1),
    );
  return [activeZone.start, ...inZone].slice(0, maxFrames);
}

function parseFps(rFrameRate: string | undefined): number {
  if (!rFrameRate) return 30;
  const [num, den] = rFrameRate.split("/").map(Number);
  if (!num || !den) return 30;
  const fps = num / den;
  return fps > 0 && fps <= 120 ? Math.round(fps * 100) / 100 : 30;
}

function extractKeyframe(
  videoPath: string,
  timeInSeconds: number,
  outputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .screenshots({
        timestamps: [timeInSeconds],
        filename: path.basename(outputPath),
        folder: path.dirname(outputPath),
        size: "1280x?",
      })
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err));
  });
}


async function evaluateFrameWithVisionAI(
  imagePath: string,
  modelName: string,
): Promise<VisionAIResponse> {
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString("base64");
  const promptText = `Analyze this drone/aerial footage frame. Return ONLY valid JSON, no markdown.

{
  "score": <1-10 aesthetic quality>,
  "description": "<1-2 sentences: what is shown, from aerial perspective, mention specific subjects>",
  "tags": ["<single English words or short 2-word phrases describing SUBJECTS visible in frame: car, suv, truck, person, crowd, building, bridge, river, forest, road, field, mountain, etc. Be specific: prefer 'suv' over 'vehicle', 'pickup truck' over 'car'. Always tag humans if visible: person, people, man, woman, crowd, pedestrian>"],
  "detectedObjects": ["<specific objects with color/type: white suv, red truck, pedestrian, cyclist, boat>"],
  "timeOfDay": "<day|golden hour|sunset|sunrise|night|overcast>",
  "landscape": "<urban|rural|coastal|mountain|desert|forest|mixed>",
  "cameraAngle": "<top-down|oblique|low-angle|horizon>",
  "motion": "<static|slow pan|fast movement|rotation>",
  "dominantColors": ["<color names>"],
  "motionEstimate": <0.0 static - 1.0 very fast>
}`;
  try {
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelName,
        prompt: promptText,
        images: [base64Image],
        format: "json",
        stream: false,
        keep_alive: LLM_KEEP_ALIVE,
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data: any = await response.json();
    const parsed = JSON.parse(cleanJSONString(data.response));
    return {
      score: Number(parsed.score) || 5,
      description: String(parsed.description || ""),
      tags: cleanAiArray(parsed.tags),
      detectedObjects: cleanAiArray(parsed.detectedObjects),
      timeOfDay: String(parsed.timeOfDay || "unknown"),
      landscape: String(parsed.landscape || "unknown"),
      cameraAngle: String(parsed.cameraAngle || "horizon"),
      motion: String(parsed.motion || "static"),
      dominantColors: Array.isArray(parsed.dominantColors)
        ? parsed.dominantColors.map(String)
        : [],
      motionEstimate: Number(parsed.motionEstimate) || 0.5,
    };
  } catch {
    return {
      score: 5,
      description: "failed",
      tags: [],
      detectedObjects: [],
      timeOfDay: "unknown",
      landscape: "unknown",
      cameraAngle: "unknown",
      motion: "unknown",
      dominantColors: [],
      motionEstimate: 0.5,
    };
  }
}

function findProxyFile(filePath: string): string | null {
  const proxyPath = filePath.replace(/\.[^.]+$/, ".lrf");
  if (fs.existsSync(proxyPath)) return proxyPath;
  const proxyPathUpper = filePath.replace(/\.[^.]+$/, ".LRF");
  if (fs.existsSync(proxyPathUpper)) return proxyPathUpper;
  return null;
}

export async function indexMediaFolder(
  dirPath: string,
  tempDir: string,
  visionModel: string,
  requestedFiles?: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<VideoInfo[]> {
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  let files = fs
    .readdirSync(dirPath)
    .filter((f) => /\.(mp4|mov)$/i.test(f) && !f.startsWith("."));
  if (requestedFiles && requestedFiles.length > 0)
    files = files.filter((f) => requestedFiles.includes(f));
  const videos: VideoInfo[] = [];
  for (let i = 0; i < files.length; i++) {
    const filename = files[i]!;
    const filePath = path.join(dirPath, filename);
    const metadataPath = `${filePath}.json`;
    const stats = fs.statSync(filePath);
    if (fs.existsSync(metadataPath)) {
      try {
        const cache = JSON.parse(
          fs.readFileSync(metadataPath).toString(),
        ) as CacheFile;
        if (
          cache._cacheVersion === CACHE_VERSION &&
          cache._fileSize === stats.size
        ) {
          videos.push(cache as VideoInfo);
          onProgress?.(i + 1, files.length);
          continue;
        }
      } catch {}
    }
    try {
      console.log(`[${i + 1}/${files.length}] Indexing: ${filename}`);
      const probeData: any = await new Promise((res, rej) =>
        ffmpeg.ffprobe(filePath, (err, data) => (err ? rej(err) : res(data))),
      );
      const videoStream = probeData.streams.find(
        (s: any) => s.codec_type === "video",
      );
      if (!videoStream) {
        onProgress?.(i + 1, files.length);
        continue;
      }

      const gpsInfo = extractGpsData(probeData.format?.tags, filePath);
      let location: VideoInfo["location"] | undefined = undefined;
      if (gpsInfo) {
        console.log(
          `  -> GPS (${gpsInfo.source}): ${gpsInfo.lat.toFixed(4)}, ${gpsInfo.lon.toFixed(4)}`,
        );
        const address = await reverseGeocode(gpsInfo.lat, gpsInfo.lon);
        if (address) {
          console.log(`  -> Location: ${address}`);
        }
        location = { lat: gpsInfo.lat, lon: gpsInfo.lon, address: address ?? undefined };
      }

      const duration = probeData.format.duration || 0;
      const proxyFile = findProxyFile(filePath);
      const { blackIntervals, sceneChanges } = await analyzeVideoMetrics(
        proxyFile ?? filePath,
        duration,
      );
      console.log(
        `  -> Metrics: scenes: ${sceneChanges.length}, black: ${blackIntervals.length}`,
      );
      const validZones = calculateValidZones(duration, blackIntervals);
      const activeZone = [...validZones].sort(
        (a, b) => b.end - b.start - (a.end - a.start),
      )[0];
      if (activeZone) {
        const timestamps = selectKeyframeTimes(
          activeZone,
          sceneChanges,
          duration,
        );
        const results: VisionAIResponse[] = [];
        console.log(`-> Vision AI`);
        for (let j = 0; j < timestamps.length; j++) {
          const imgPath = path.join(tempDir, `thumb_${filename}_${j}.jpg`);
          try {
            await extractKeyframe(
              proxyFile ?? filePath,
              timestamps[j]!,
              imgPath,
            );
            results.push(await evaluateFrameWithVisionAI(imgPath, visionModel));
            safeDelete(imgPath);
            console.log(`- Frame ${j + 1}/${timestamps.length}`);
          } catch (e) {}
        }
        if (results.length > 0) {
          const best = results.reduce((a, b) => (a.score > b.score ? a : b));
          // Объединяем описания всех кадров — каждый кадр может фиксировать разные объекты.
          // Уникальные предложения, начиная с лучшего кадра.
          const allDescriptions = [best.description, ...results
            .filter((r) => r !== best && r.description && r.description !== "failed")
            .map((r) => r.description)];
          const description = [...new Set(allDescriptions)].join(" ");
          const videoInfo: VideoInfo = {
            id: filename,
            filePath,
            duration,
            creationDate: stats.birthtime.toISOString(),
            validZones,
            fps: parseFps(videoStream.r_frame_rate),
            location,
            aestheticScore:
              results.reduce((s, r) => s + r.score, 0) / results.length,
            description,
            tags: [
              ...new Set(
                results.flatMap((r) => [...r.tags, ...r.detectedObjects]),
              ),
            ],
            timeOfDay: best.timeOfDay,
            landscape: best.landscape,
            cameraAngle: best.cameraAngle,
            motion: best.motion,
            dominantColors: best.dominantColors,
            motionIntensity: Math.max(...results.map((r) => r.motionEstimate)),
            isSlowMotionSuitable:
              Math.max(...results.map((r) => r.motionEstimate)) < 0.3,
            bestSegments: [{ start: activeZone.start, end: activeZone.end }],
          };
          fs.writeFileSync(
            metadataPath,
            JSON.stringify(
              {
                ...videoInfo,
                _cacheVersion: CACHE_VERSION,
                _fileSize: stats.size,
              },
              null,
              2,
            ),
          );
          videos.push(videoInfo);
          console.log("  -> Done");
        }
      }
    } catch (e) {
      console.error(`  ! Error: ${(e as Error).message}`);
    }
    onProgress?.(i + 1, files.length);
  }
  return videos;
}
