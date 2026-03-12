import * as readline from 'readline';
import * as path from 'path';
import { Config } from './config';

// ─── Progress bar ────────────────────────────────────────────────────────────

function drawBar(percent: number, width = 28): string {
    const filled = Math.round(Math.max(0, Math.min(100, percent)) / 100 * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function drawProgress(label: string, percent: number, suffix = ''): void {
    const bar    = drawBar(percent);
    const pctStr = percent.toFixed(0).padStart(3) + '%';
    const line   = `  ${label}  ${bar}  ${pctStr}${suffix ? '  ' + suffix : ''}`;
    process.stdout.write(`\r${line.padEnd(80)}`);
}

export function clearProgress(): void {
    process.stdout.write('\r' + ' '.repeat(80) + '\r');
}

// ─── Interactive setup ────────────────────────────────────────────────────────

function ask(rl: readline.Interface, question: string): Promise<string> {
    return new Promise(resolve => rl.question(question, ans => resolve(ans.trim())));
}

function dim(s: string): string  { return `\x1b[2m${s}\x1b[0m`; }
function red(s: string): string  { return `\x1b[31m${s}\x1b[0m`; }

function showDefault(val: string | number | undefined): string {
    const s = val !== undefined && val !== '' ? String(val) : '';
    return s ? dim(`[${s}]`) : dim('[not set]');
}

async function requiredField(
    rl: readline.Interface,
    label: string,
    current: string | undefined
): Promise<string> {
    console.log(`  ${label.padEnd(16)} ${showDefault(current)}`);
    while (true) {
        const ans = await ask(rl, '  > ');
        const val = ans || current || '';
        if (val) { console.log(''); return val; }
        console.log(`  ${red('✗ Required.')}`);
    }
}

async function optionalField(
    rl: readline.Interface,
    label: string,
    current: string | number | undefined
): Promise<string> {
    console.log(`  ${label.padEnd(16)} ${showDefault(current)}`);
    const ans = await ask(rl, '  > ');
    console.log('');
    return ans || (current !== undefined ? String(current) : '');
}

async function promptField(
    rl: readline.Interface,
    current: string | undefined
): Promise<string> {
    if (current) {
        console.log(`  ${'Editing prompt'.padEnd(16)} ${dim('(current):')}`);
        const preview = current.length > 90 ? current.slice(0, 90) + '…' : current;
        console.log(`  ${dim(preview)}`);
    } else {
        console.log(`  ${'Editing prompt'.padEnd(16)} ${dim('[not set]')}`);
    }
    while (true) {
        const ans = await ask(rl, '  > ');
        const val = ans || current || '';
        if (val) { console.log(''); return val; }
        console.log(`  ${red('✗ Required.')}`);
    }
}

export async function promptSetup(saved: Partial<Config>): Promise<Config> {
    console.log('');
    console.log('  ╔════════════════════════════════════════╗');
    console.log('  ║        A U T O M O U N T E R          ║');
    console.log('  ║           AI Video Editor              ║');
    console.log('  ╚════════════════════════════════════════╝');
    console.log('');
    console.log(`  ${dim('Press Enter to keep the current value.')}`);
    console.log('');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const input    = await requiredField(rl, 'Input folder',   saved.input);
    const audio    = await requiredField(rl, 'Audio track',    saved.audio);
    const prompt   = await promptField(rl, saved.prompt);
    const durStr     = await optionalField(rl, 'Duration (sec)', saved.duration ?? 60);
    const bitrateStr = await optionalField(rl, 'Bitrate (Mbps)', saved.bitrate || 'auto');
    const lut        = await optionalField(rl, 'LUT file',       saved.lut ?? 'cinematic.cube');
    const output     = await optionalField(rl, 'Output file',    saved.output ?? 'final_edit.mp4');
    const model      = await optionalField(rl, 'Ollama model',   saved.model ?? 'llava:13b');

    const config: Config = {
        input,
        audio,
        prompt,
        duration: parseInt(durStr, 10)     || (saved.duration ?? 60),
        bitrate:  parseInt(bitrateStr, 10) || 0,   // 0 = авто
        lut:      lut    || path.join(process.cwd(), 'cinematic.cube'),
        output:   output || path.join(process.cwd(), 'final_edit.mp4'),
        model:    model  || 'llava:13b',
    };

    // Summary
    console.log(`  ${dim('─'.repeat(44))}`);
    console.log('');
    console.log(`  Input:    ${config.input}`);
    console.log(`  Audio:    ${config.audio}`);
    const promptPreview = config.prompt.length > 72
        ? config.prompt.slice(0, 72) + '…'
        : config.prompt;
    console.log(`  Prompt:   "${promptPreview}"`);
    console.log(`  Duration: ${config.duration}s  |  Bitrate: ${config.bitrate > 0 ? config.bitrate + ' Mbps' : 'auto'}`);
    console.log(`  Output:   ${config.output}`);
    console.log('');

    const confirm = await ask(rl, `  Start? ${dim('[Y/n]')} `);
    rl.close();

    if (confirm.toLowerCase() === 'n') {
        console.log('\n  Aborted.\n');
        process.exit(0);
    }

    console.log('');
    return config;
}
