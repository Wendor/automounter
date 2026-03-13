import React, { useState } from 'react';
import { createRoot } from '@opentui/react';
import { createCliRenderer } from '@opentui/core';
import { Config } from '../config';
import { QualityLevel, RenderSession } from '../types';
import { CreateMode } from './CreateMode';
import { EditMode } from './EditMode';
import { IndexMode } from './IndexMode';
import { PipelineView, PipelineCB } from './PipelineView';

export type { PipelineCB };

export type AppResult =
    | { mode: 'create'; config: Config }
    | { mode: 'edit';   lut: string; quality: QualityLevel; output: string }
    | { mode: 'index';  input: string; model: string; reindex: boolean };

export const THEME = {
    background: '#0a0a0c',
    border: '#2a2a2e',
    accent: '#8b5cf6', // Violet
    text: '#d1d5db',
    dim: '#6b7280',
    success: '#10b981',
    error: '#ef4444',
    highlight: '#a78bfa',
};

let activeRenderer: any = null;

function cleanupTerminal() {
    if (activeRenderer) {
        try {
            activeRenderer.destroy();
        } catch (e) {}
        activeRenderer = null;
    }
    process.stdout.write('\x1bc\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?25h\x1b[?1049l\x1b[0m');
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
    }
}

process.on('SIGINT', () => { cleanupTerminal(); process.exit(0); });
process.on('SIGTERM', () => { cleanupTerminal(); process.exit(0); });
process.on('uncaughtException', (e) => { cleanupTerminal(); console.error(e); process.exit(1); });

interface MenuProps {
    hasSession: boolean;
    onSelect: (mode: 'create' | 'edit' | 'index') => void;
}

const MainMenu = ({ hasSession, onSelect }: MenuProps) => {
    const items = [
        { name: '  ✦  Создать ролик',                        description: 'Начать новый проект монтажа', value: 'create' },
        ...(hasSession ? [{ name: '  ✎  Правка последнего ролика', description: 'Изменить LUT или качество', value: 'edit' }] : []),
        { name: '  ⟳  Переиндексация папки',                 description: 'Обновить базу данных видео', value: 'index'  },
    ];
    return (
        <box style={{ flexDirection: 'column', borderStyle: 'rounded', borderColor: THEME.border, padding: 1, margin: 1, width: '100%', height: '100%', backgroundColor: THEME.background }}><box style={{ justifyContent: 'space-between', marginBottom: 1 }}><text style={{ fg: THEME.accent, attributes: 1 }}>  A U T O M O U N T E R</text><text style={{ fg: THEME.dim }}>CLI Edition  </text></box><text style={{ fg: THEME.border, marginBottom: 1 }}>{'─'.repeat(42)}</text><box style={{ flexGrow: 1, padding: 1 }}><select options={items} onSelect={(index) => onSelect(items[index].value as any)} focused={true} selectedBackgroundColor={THEME.accent} selectedTextColor="#ffffff" textColor={THEME.text} descriptionColor={THEME.dim} selectedDescriptionColor="#e2e8f0" style={{ flexGrow: 1 }} /></box></box>
    );
};

interface AppProps {
    saved: Partial<Config>;
    session: RenderSession | null;
    cwd: string;
    onDone: (result: AppResult) => void;
}

const App = ({ saved, session, cwd, onDone }: AppProps) => {
    const [mode, setMode] = useState<'menu' | 'create' | 'edit' | 'index'>('menu');
    return (
        <box style={{ flexDirection: 'column', width: '100%', height: '100%', backgroundColor: THEME.background }}>{mode === 'menu' ? <MainMenu hasSession={session !== null} onSelect={setMode} /> : null}{mode === 'create' ? <CreateMode saved={saved} cwd={cwd} onDone={(config) => onDone({ mode: 'create', config })} onBack={() => setMode('menu')} /> : null}{mode === 'edit' && session ? <EditMode session={session} currentLut={saved.lut ?? ''} currentQuality={saved.quality ?? 'medium'} currentOutput={saved.output ?? ''} cwd={cwd} onDone={(r) => onDone({ mode: 'edit', ...r })} onBack={() => setMode('menu')} /> : null}{mode === 'index' ? <IndexMode defaultInput={saved.input ?? ''} defaultModel={saved.model ?? 'llava:13b'} onDone={(r) => onDone({ mode: 'index', ...r })} onBack={() => setMode('menu')} /> : null}</box>
    );
};

export async function showPipelineUI(config: Config, runner: (cb: PipelineCB) => Promise<void>): Promise<void> {
    const renderer = await createCliRenderer({ exitOnCtrlC: true });
    activeRenderer = renderer;
    const root = createRoot(renderer);
    return new Promise<void>((resolve, reject) => {
        root.render(<PipelineView config={config} run={runner} onDone={() => { root.unmount(); cleanupTerminal(); setTimeout(resolve, 50); }} onError={(msg) => { root.unmount(); cleanupTerminal(); setTimeout(() => reject(new Error(msg)), 50); }} />);
    });
}

export async function showInkUI(saved: Partial<Config>, cwd: string): Promise<AppResult> {
    const renderer = await createCliRenderer({ exitOnCtrlC: true });
    activeRenderer = renderer;
    const root = createRoot(renderer);
    return new Promise<AppResult>((resolve) => {
        root.render(<App saved={saved} session={(saved.lastSession as RenderSession | undefined) ?? null} cwd={cwd} onDone={(result) => { root.unmount(); cleanupTerminal(); setTimeout(() => resolve(result), 50); }} />);
    });
}