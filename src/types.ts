export interface AudioData {
    sampleRate: number;
    channelData: Float32Array[];
}

/** @deprecated Use AudioAnalysis */
export interface TempoResult {
    tempo: string;
    beats: number[];
}

export type AudioStyle = 'dynamic' | 'lyrical' | 'epic' | 'calm';

export interface AudioSection {
    start: number;    // seconds
    end: number;      // seconds
    energy: number;   // 0.0 – 1.0 normalized RMS
    style: AudioStyle;
}

export interface AudioAnalysis {
    tempo: string;
    beats: number[];          // beat timestamps in seconds
    style: AudioStyle;        // overall track character
    energy: number;           // overall normalized RMS, 0–1
    drops: number[];          // timestamps (sec) of energy spikes after silence
    sections: AudioSection[]; // 2-second windowed breakdown
}

export type SegmentEffect = 'fadeIn' | 'fadeOut' | 'flashIn' | 'flashOut' | 'cut' | 'none';

export interface ValidZone {
    start: number;
    end: number;
}

export interface VideoInfo {
    id: string;
    filePath: string;
    duration: number;
    creationDate: string;
    validZones: ValidZone[];
    fps?: number;             // detected native frame rate
    aestheticScore?: number;
    description?: string;
    tags?: string[];
    timeOfDay?: string;
    landscape?: string;
    cameraAngle?: string;
    motion?: string;
    bestSegments?: ValidZone[];
    motionIntensity?: number;
    dominantColors?: string[];
    isSlowMotionSuitable?: boolean;
}

export interface AIEditInstruction {
    clipId: string;
    beatsDuration: number;
}

export interface VideoSegment {
    sourceFile: string;
    startTime: number;
    rawDuration: number;
    targetDuration: number;
    ptsFactor: number;
    outputFile: string;
    isFirst: boolean;
    isLast: boolean;
    effect: SegmentEffect;
    slowMotionFactor: number;
    sourceFps: number;               // native fps of source clip
    transition: 'dissolve' | 'hard'; // transition INTO this segment from previous
    transitionDuration: number;      // seconds (0 for hard cut)
}

export interface SliceResult {
    files: string[];
    totalDuration: number;
    targetFps: number;  // majority fps across all rendered segments
}

// ─── Quality ──────────────────────────────────────────────────────────────────

export type QualityLevel = 'low' | 'medium' | 'high';

export interface RenderQuality {
    bitrate: number;       // Mbps, всегда конкретное значение
    x264preset: string;    // ultrafast | fast | slow
    scale: string | null;  // null = оригинальное разрешение, 'w:h' = масштаб
}

export const QUALITY_TEMPLATES: Record<QualityLevel, RenderQuality & { label: string; description: string; bitrateAuto: boolean }> = {
    low:    { label: 'Low (Preview)',  description: '720p · 8 Mbps · ultrafast', bitrate: 8,  x264preset: 'ultrafast', scale: '1280:720', bitrateAuto: false },
    medium: { label: 'Medium',         description: 'full res · auto Mbps · fast', bitrate: 0,  x264preset: 'fast',      scale: null,       bitrateAuto: true  },
    high:   { label: 'High',           description: 'full res · 80 Mbps · slow',  bitrate: 80, x264preset: 'slow',      scale: null,       bitrateAuto: false },
};

// ─── Render session (сохраняется в config.json для ре-рендера) ────────────────

export interface RenderSession {
    segments: VideoSegment[];
    totalDuration: number;
    targetFps: number;
    audio: string;
    renderedAt: string;
}
