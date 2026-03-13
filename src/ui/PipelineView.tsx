import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';

// ─── Public callback interface ────────────────────────────────────────────────

export interface PipelineCB {
    stage(n: number, total: number, label: string): void;
    info(msg: string): void;
    renderTick(segIdx: number, segPct: number, done: number, total: number): void;
    assemblyProgress(pct: number): void;
    done(outputPath: string): void;
    error(msg: string): void;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type StageStatus = 'pending' | 'active' | 'done' | 'error';

interface StageState {
    label:    string;
    status:   StageStatus;
    detail:   string;
    progress: number;   // -1 = none, 0-100 = show bar
    counter:  string;   // e.g. "18/28"
}

// Per-stage weight for overall progress (must sum to 100)
const STAGE_WEIGHTS = [3, 1, 5, 14, 9, 55, 13];

// ─── Progress bar ─────────────────────────────────────────────────────────────

const Bar: React.FC<{ value: number; width?: number }> = ({ value, width = 28 }) => {
    const v      = Math.max(0, Math.min(100, value));
    const filled = Math.round(v / 100 * width);
    return (
        <Text>
            <Text color="cyan">{'█'.repeat(filled)}</Text>
            <Text dimColor>{'░'.repeat(width - filled)}</Text>
        </Text>
    );
};

// ─── Stage row ────────────────────────────────────────────────────────────────

const ICONS: Record<StageStatus, string> = {
    done:    '✓',
    active:  '▸',
    error:   '✗',
    pending: '·',
};
const COLORS: Record<StageStatus, string | undefined> = {
    done:    'green',
    active:  'cyan',
    error:   'red',
    pending: undefined,
};

const StageRow: React.FC<{ stage: StageState }> = ({ stage: s }) => {
    const color = COLORS[s.status];
    return (
        <Box>
            <Text color={color as any}>{ICONS[s.status]}</Text>
            <Text>{'  '}</Text>
            <Text
                bold={s.status === 'active'}
                dimColor={s.status === 'pending'}
                color={s.status === 'active' ? 'white' : color as any}
            >
                {s.label.padEnd(20)}
            </Text>
            {s.status === 'active' && s.progress >= 0 ? (
                <Box>
                    <Bar value={s.progress} width={18} />
                    <Text dimColor>{'  '}{s.counter || `${s.progress.toFixed(0)}%`}</Text>
                </Box>
            ) : (
                <Text dimColor color={s.status === 'done' ? 'green' as any : undefined}>
                    {s.detail}
                </Text>
            )}
        </Box>
    );
};

// ─── Segment mini-grid (shown during rendering) ───────────────────────────────

const SegmentGrid: React.FC<{ segs: Map<number, number>; total: number }> = ({ segs, total }) => {
    // Show only active (in-progress) segments, up to 4
    const active = [...segs.entries()]
        .filter(([, pct]) => pct < 100 && pct > 0)
        .sort(([a], [b]) => a - b)
        .slice(0, 4);

    if (active.length === 0) return null;

    return (
        <Box flexDirection="column" marginLeft={4} marginTop={0}>
            {active.map(([idx, pct]) => (
                <Box key={idx}>
                    <Text dimColor>{`seg${String(idx + 1).padStart(3, '0')}  `}</Text>
                    <Bar value={pct} width={16} />
                    <Text dimColor>{'  '}{pct.toFixed(0).padStart(3)}%</Text>
                </Box>
            ))}
        </Box>
    );
};

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
    run:     (cb: PipelineCB) => Promise<void>;
    onDone:  () => void;
    onError: (msg: string) => void;
}

const STAGE_NAMES = [
    'Анализ аудио',
    'Сканирование',
    'AI фильтрация',
    'Индексация',
    'Монтаж',
    'Рендеринг',
    'Сборка',
];

export const PipelineView: React.FC<Props> = ({ run, onDone, onError }) => {
    const total = STAGE_NAMES.length;

    const [stages, setStages] = useState<StageState[]>(
        STAGE_NAMES.map(label => ({ label, status: 'pending', detail: '', progress: -1, counter: '' }))
    );
    const [segProgress, setSegProgress] = useState<Map<number, number>>(new Map());
    const [overallPct,  setOverallPct]  = useState(0);
    const [outputPath,  setOutputPath]  = useState('');
    const [isDone,      setIsDone]      = useState(false);
    const [errorMsg,    setErrorMsg]    = useState('');

    const currentIdxRef = useRef(-1);

    const recalcOverall = (idx: number, stagePct: number) => {
        const base    = STAGE_WEIGHTS.slice(0, idx).reduce((a, b) => a + b, 0);
        const contrib = (STAGE_WEIGHTS[idx] ?? 0) * stagePct / 100;
        setOverallPct(Math.min(99, Math.round(base + contrib)));
    };

    useEffect(() => {
        // Перехватываем console.log из внутренних модулей (indexer, director…)
        const origLog  = console.log;
        const origWarn = console.warn;
        const patchLog = (...args: unknown[]) => {
            const msg = args.map(String).join(' ').replace(/^\s+/, '');
            const idx = currentIdxRef.current;
            if (idx >= 0) {
                setStages(prev => prev.map((s, i) =>
                    i === idx ? { ...s, detail: msg.slice(0, 60) } : s
                ));
            }
        };
        console.log  = patchLog;
        console.warn = patchLog;

        const cb: PipelineCB = {
            stage(n, _total, label) {
                const idx = n - 1;
                currentIdxRef.current = idx;
                setStages(prev => prev.map((s, i) => {
                    if (i < idx) return { ...s, status: 'done' };
                    if (i === idx) return { ...s, status: 'active', label };
                    return s;
                }));
                recalcOverall(idx, 0);
            },

            info(msg) {
                const idx = currentIdxRef.current;
                if (idx < 0) return;
                setStages(prev => prev.map((s, i) =>
                    i === idx ? { ...s, detail: msg.slice(0, 60), progress: -1 } : s
                ));
            },

            renderTick(segIdx, segPct, done, segTotal) {
                setSegProgress(prev => {
                    const next = new Map(prev);
                    next.set(segIdx, segPct);
                    return next;
                });
                const idx     = currentIdxRef.current;
                const overall = Math.round([...Array.from(segProgress.values()), segPct]
                    .reduce((s, v) => s + Math.min(100, v), 0) / Math.max(1, segTotal));
                setStages(prev => prev.map((s, i) =>
                    i === idx
                        ? { ...s, progress: overall, counter: `${done}/${segTotal}` }
                        : s
                ));
                recalcOverall(idx, overall);
            },

            assemblyProgress(pct) {
                const idx = currentIdxRef.current;
                setStages(prev => prev.map((s, i) =>
                    i === idx ? { ...s, progress: pct, counter: `${pct.toFixed(0)}%` } : s
                ));
                recalcOverall(idx, pct);
            },

            done(path) {
                setStages(prev => prev.map(s => ({
                    ...s, status: 'done' as StageStatus, progress: 100,
                })));
                setOverallPct(100);
                setOutputPath(path);
                setIsDone(true);
                console.log  = origLog;
                console.warn = origWarn;
                setTimeout(() => onDone(), 800);
            },

            error(msg) {
                const idx = currentIdxRef.current;
                setStages(prev => prev.map((s, i) =>
                    i === idx ? { ...s, status: 'error' as StageStatus, detail: msg.slice(0, 60) } : s
                ));
                setErrorMsg(msg);
                console.log  = origLog;
                console.warn = origWarn;
                setTimeout(() => onError(msg), 400);
            },
        };

        run(cb).catch(err => {
            cb.error(err instanceof Error ? err.message : String(err));
        });

        return () => {
            console.log  = origLog;
            console.warn = origWarn;
        };
    }, []);

    const currentIdx = currentIdxRef.current;

    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={errorMsg ? 'red' : isDone ? 'green' : 'cyan'}
            paddingX={2}
            paddingY={1}
            marginX={1}
            marginY={1}
        >
            {/* Header */}
            <Box justifyContent="space-between" marginBottom={1}>
                <Text bold color="cyan">  A U T O M O U N T E R</Text>
                <Text dimColor>
                    {currentIdx >= 0 ? `[${currentIdx + 1}/${total}]` : ''}{'  '}
                </Text>
            </Box>

            {/* Stage list */}
            {stages.map((s, i) => (
                <Box key={i} flexDirection="column">
                    <StageRow stage={s} />
                    {/* Active segment grid during rendering */}
                    {s.status === 'active' && segProgress.size > 0 && (
                        <SegmentGrid segs={segProgress} total={stages[5]?.counter
                            ? parseInt(stages[5].counter.split('/')[1] ?? '0') : 0} />
                    )}
                </Box>
            ))}

            {/* Overall progress */}
            <Box marginTop={1}>
                <Text dimColor>  Итого   </Text>
                <Bar value={overallPct} width={32} />
                <Text>{'  '}</Text>
                <Text bold color={overallPct === 100 ? 'green' : 'white'}>
                    {overallPct}%
                </Text>
            </Box>

            {/* Done */}
            {isDone && (
                <Box marginTop={1}>
                    <Text bold color="green">{'  '}✓ Готово → </Text>
                    <Text dimColor>{outputPath}</Text>
                </Box>
            )}

            {/* Error */}
            {errorMsg && (
                <Box marginTop={1}>
                    <Text color="red">{'  '}✗ </Text>
                    <Text color="red">{errorMsg}</Text>
                </Box>
            )}
        </Box>
    );
};
