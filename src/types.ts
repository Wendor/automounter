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
