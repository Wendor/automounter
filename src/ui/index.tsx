import React, { useState } from 'react';
import { render, Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import { Config } from '../config';
import { QualityLevel, RenderSession } from '../types';
import { CreateMode } from './CreateMode';
import { EditMode } from './EditMode';
import { IndexMode } from './IndexMode';
import { PipelineView, PipelineCB } from './PipelineView';

export type { PipelineCB };

// ─── Типы результатов ─────────────────────────────────────────────────────────

export type AppResult =
    | { mode: 'create'; config: Config }
    | { mode: 'edit';   lut: string; quality: QualityLevel; output: string }
    | { mode: 'index';  input: string; model: string; reindex: boolean };

// ─── Главное меню ─────────────────────────────────────────────────────────────

interface MenuProps {
    hasSession: boolean;
    onSelect: (mode: 'create' | 'edit' | 'index') => void;
}

const MainMenu: React.FC<MenuProps> = ({ hasSession, onSelect }) => {
    const items = [
        { label: '  ✦  Создать ролик',                        value: 'create' },
        ...(hasSession ? [{ label: '  ✎  Правка последнего ролика', value: 'edit' }] : []),
        { label: '  ⟳  Переиндексация папки',                 value: 'index'  },
    ];
    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="cyan"
            paddingX={2}
            paddingY={1}
            marginX={1}
            marginY={1}
            gap={1}
        >
            <Box justifyContent="space-between">
                <Text bold color="cyan">  A U T O M O U N T E R</Text>
                <Text dimColor>AI Video Editor  </Text>
            </Box>
            <Box>
                <Text dimColor>{'─'.repeat(42)}</Text>
            </Box>
            <SelectInput
                items={items}
                onSelect={(item: { value: string }) => onSelect(item.value as 'create' | 'edit' | 'index')}
            />
        </Box>
    );
};

// ─── Root app ─────────────────────────────────────────────────────────────────

interface AppProps {
    saved: Partial<Config>;
    session: RenderSession | null;
    cwd: string;
    onDone: (result: AppResult) => void;
}

const App: React.FC<AppProps> = ({ saved, session, cwd, onDone }) => {
    const [mode, setMode] = useState<'menu' | 'create' | 'edit' | 'index'>('menu');

    return (
        <Box flexDirection="column">
            {mode === 'menu' && (
                <MainMenu
                    hasSession={session !== null}
                    onSelect={setMode}
                />
            )}
            {mode === 'create' && (
                <CreateMode
                    saved={saved}
                    cwd={cwd}
                    onDone={(config) => onDone({ mode: 'create', config })}
                    onBack={() => setMode('menu')}
                />
            )}
            {mode === 'edit' && session && (
                <EditMode
                    session={session}
                    currentLut={saved.lut ?? ''}
                    currentQuality={saved.quality ?? 'medium'}
                    currentOutput={saved.output ?? ''}
                    cwd={cwd}
                    onDone={(r) => onDone({ mode: 'edit', ...r })}
                    onBack={() => setMode('menu')}
                />
            )}
            {mode === 'index' && (
                <IndexMode
                    defaultInput={saved.input ?? ''}
                    defaultModel={saved.model ?? 'llava:13b'}
                    onDone={(r) => onDone({ mode: 'index', ...r })}
                    onBack={() => setMode('menu')}
                />
            )}
        </Box>
    );
};

// ─── Точка входа ──────────────────────────────────────────────────────────────

export async function showPipelineUI(
    runner: (cb: PipelineCB) => Promise<void>
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const { unmount } = render(
            <PipelineView
                run={runner}
                onDone={() => { unmount(); resolve(); }}
                onError={(msg) => { unmount(); reject(new Error(msg)); }}
            />
        );
    });
}

export async function showInkUI(saved: Partial<Config>, cwd: string): Promise<AppResult> {
    const session = (saved.lastSession as RenderSession | undefined) ?? null;

    return new Promise<AppResult>((resolve) => {
        const { unmount } = render(
            <App
                saved={saved}
                session={session}
                cwd={cwd}
                onDone={(result) => { unmount(); resolve(result); }}
            />
        );
    });
}
