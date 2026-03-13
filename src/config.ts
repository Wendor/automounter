import * as fs from 'fs';
import * as path from 'path';
import { QualityLevel, RenderSession } from './types';

export interface Config {
    input: string;
    audio: string;
    duration: number;
    lut: string;
    prompt: string;
    model: string;
    output: string;
    bitrate: number;          // Mbps, 0 = авто-определение
    quality: QualityLevel;    // low | medium | high
    lastSession?: RenderSession;
}

function parseArgs(argv: string[]): Partial<Config> {
    const result: Partial<Config> = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === '--input'    && next) { result.input    = next; i++; }
        if (arg === '--audio'    && next) { result.audio    = next; i++; }
        if (arg === '--duration' && next) { result.duration = parseInt(next, 10); i++; }
        if (arg === '--lut'      && next) { result.lut      = next; i++; }
        if (arg === '--prompt'   && next) { result.prompt   = next; i++; }
        if (arg === '--model'    && next) { result.model    = next; i++; }
        if (arg === '--output'   && next) { result.output   = next; i++; }
        if (arg === '--bitrate'  && next) { result.bitrate  = parseInt(next, 10); i++; }
        if (arg === '--quality'  && next) { result.quality  = next as QualityLevel; i++; }
    }
    return result;
}

function loadConfigFile(): Partial<Config> {
    const configPath = path.join(process.cwd(), 'config.json');
    if (!fs.existsSync(configPath)) return {};
    try {
        return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Partial<Config>;
    } catch {
        console.warn('[Config] config.json is malformed, ignoring it.');
        return {};
    }
}

const CONFIG_PATH = path.join(process.cwd(), 'config.json');

export function saveConfig(config: Config): void {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function loadSavedConfig(): Partial<Config> {
    return loadConfigFile();
}

export function loadConfig(): Config {
    const cli  = parseArgs(process.argv.slice(2));
    const file = loadConfigFile();

    const merged: Config = {
        input:    cli.input    ?? file.input    ?? '',
        audio:    cli.audio    ?? file.audio    ?? '',
        duration: cli.duration ?? file.duration ?? 60,
        lut:      cli.lut      ?? file.lut      ?? path.join(process.cwd(), 'cinematic.cube'),
        prompt:   cli.prompt   ?? file.prompt   ?? '',
        model:    cli.model    ?? file.model    ?? 'llava:13b',
        output:   cli.output   ?? file.output   ?? path.join(process.cwd(), 'final_edit.mp4'),
        bitrate:  cli.bitrate  ?? file.bitrate  ?? 0,
        quality:  cli.quality  ?? file.quality  ?? 'medium',
    };

    if (!merged.input)  throw new Error('--input is required (path to video folder)');
    if (!merged.audio)  throw new Error('--audio is required (path to audio file)');
    if (!merged.prompt) throw new Error('--prompt is required (editing instruction)');

    return merged;
}
