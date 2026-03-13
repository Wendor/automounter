import * as fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { AudioData, AudioAnalysis, AudioStyle, AudioSection } from './types';

interface WavDecoder {
    decode(buffer: Buffer): AudioData;
}

interface MusicTempoInstance {
    tempo: string;
    beats: number[];
}

interface MusicTempoConstructor {
    new (audioData: Float32Array): MusicTempoInstance;
}

import _wav from 'node-wav';
import _MusicTempo from 'music-tempo';
const wav = _wav as unknown as WavDecoder;
const MusicTempo = _MusicTempo as unknown as MusicTempoConstructor;

export function convertMp3ToWav(inputFile: string, outputFile: string): Promise<void> {
    return new Promise((resolve, reject) => {
        ffmpeg(inputFile)
            .toFormat('wav')
            .audioChannels(1)
            .audioFrequency(44100)
            .on('end', () => resolve())
            .on('error', (err: Error) => reject(err))
            .save(outputFile);
    });
}

function classifyStyle(tempoNum: number, normalizedEnergy: number): AudioStyle {
    if (tempoNum >= 128 && normalizedEnergy >= 0.7) return 'epic';
    if (tempoNum >= 120 && normalizedEnergy >= 0.5) return 'dynamic';
    if (tempoNum < 100  && normalizedEnergy < 0.4)  return 'calm';
    return 'lyrical';
}

export function analyzeAudio(wavFilePath: string): AudioAnalysis {
    const buffer: Buffer = fs.readFileSync(wavFilePath);
    const decoded: AudioData = wav.decode(buffer);

    const audioData: Float32Array | undefined = decoded.channelData[0];
    if (!audioData) {
        throw new Error('No audio data found in WAV file.');
    }

    const mt = new MusicTempo(audioData);
    const sampleRate = decoded.sampleRate;

    // RMS windowing: 2-second windows with 50% overlap
    const windowSamples = Math.floor(2.0 * sampleRate);
    const hopSamples    = Math.floor(windowSamples / 2);

    const rmsValues: number[]    = [];
    const windowTimes: number[]  = [];

    for (let offset = 0; offset + windowSamples <= audioData.length; offset += hopSamples) {
        let sumSq = 0;
        for (let i = offset; i < offset + windowSamples; i++) {
            sumSq += (audioData[i] ?? 0) ** 2;
        }
        rmsValues.push(Math.sqrt(sumSq / windowSamples));
        windowTimes.push(offset / sampleRate);
    }

    const maxRms = Math.max(...rmsValues, 1e-9);
    const normalizedRms = rmsValues.map(v => v / maxRms);
    const overallEnergy = normalizedRms.reduce((a, b) => a + b, 0) / (normalizedRms.length || 1);

    // Drop detection: energy spike (> 0.75) following low-energy window (< 0.4)
    const drops: number[] = [];
    for (let i = 1; i < normalizedRms.length; i++) {
        if ((normalizedRms[i] ?? 0) > 0.75 && (normalizedRms[i - 1] ?? 1) < 0.4) {
            drops.push(windowTimes[i] ?? 0);
        }
    }

    const tempoNum = parseFloat(mt.tempo);
    const overallStyle = classifyStyle(tempoNum, overallEnergy);

    const sections: AudioSection[] = normalizedRms.map((energy, i) => ({
        start:  windowTimes[i]  ?? 0,
        end:    (windowTimes[i] ?? 0) + 2.0,
        energy: energy,
        style:  classifyStyle(tempoNum, energy),
    }));

    return {
        tempo: mt.tempo,
        beats: mt.beats,
        style: overallStyle,
        energy: overallEnergy,
        drops,
        sections,
    };
}
