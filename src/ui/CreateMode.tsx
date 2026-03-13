import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import * as path from 'path';
import { Config } from '../config';
import { QualityLevel, QUALITY_TEMPLATES } from '../types';
import { FileBrowser } from './FileBrowser';

interface Props {
    saved: Partial<Config>;
    cwd: string;
    onDone: (config: Config) => void;
    onBack: () => void;
}

type Step = 'input' | 'audio_choice' | 'audio_browse' | 'audio_manual'
          | 'prompt' | 'duration' | 'lut_choice' | 'lut_browse' | 'lut_manual'
          | 'quality' | 'confirm';

interface Form {
    input: string; audio: string; prompt: string;
    duration: string; lut: string; quality: QualityLevel;
    model: string; output: string;
}

const STEPS: Step[] = ['input','audio_choice','prompt','duration','lut_choice','quality','confirm'];
const STEP_LABELS = ['Видео','Аудио','Промпт','Длит','LUT','Качество','Старт'];

const QUALITY_ITEMS = (Object.keys(QUALITY_TEMPLATES) as QualityLevel[]).map(k => ({
    label: `${QUALITY_TEMPLATES[k].label.padEnd(18)} ${QUALITY_TEMPLATES[k].description}`,
    value: k,
}));

// ─── Step breadcrumb ─────────────────────────────────────────────────────────

const Breadcrumb: React.FC<{ step: Step }> = ({ step }) => {
    const current = STEPS.indexOf(step);
    return (
        <Box marginBottom={1}>
            {STEP_LABELS.map((label, i) => (
                <Box key={i}>
                    {i > 0 && <Text dimColor> › </Text>}
                    <Text
                        bold={i === current}
                        color={i < current ? 'green' : i === current ? 'cyan' : undefined}
                        dimColor={i > current}
                    >
                        {i < current ? '✓' : i === current ? '▸' : `${i + 1}`}{' '}{label}
                    </Text>
                </Box>
            ))}
        </Box>
    );
};

// ─── Shared label/value row ───────────────────────────────────────────────────

function Row({ label, value, dim }: { label: string; value?: string; dim?: boolean }) {
    return (
        <Box>
            <Text dimColor>{('  ' + label + ':').padEnd(16)}</Text>
            <Text dimColor={dim ?? !value}>{value ?? '—'}</Text>
        </Box>
    );
}

// ─── Main component ───────────────────────────────────────────────────────────

export const CreateMode: React.FC<Props> = ({ saved, cwd, onDone, onBack }) => {
    const [step, setStep] = useState<Step>('input');
    const [form, setForm] = useState<Form>({
        input:    saved.input    ?? '',
        audio:    saved.audio    ?? '',
        prompt:   saved.prompt   ?? '',
        duration: String(saved.duration ?? 60),
        lut:      saved.lut      ?? '',
        quality:  saved.quality  ?? 'medium',
        model:    saved.model    ?? 'llava:13b',
        output:   saved.output   ?? path.join(cwd, 'final_edit.mp4'),
    });
    const [inputVal, setInputVal] = useState('');
    const [error, setError] = useState('');

    const lutsDir  = path.join(cwd, 'luts');
    const musicDir = path.join(cwd, 'music');
    const set = (field: keyof Form, value: string) => setForm(f => ({ ...f, [field]: value }));

    // Пре-fill: при переходе на шаг с текстовым вводом подставляем текущее значение
    useEffect(() => {
        const prefill: Partial<Record<Step, () => string>> = {
            input:        () => form.input,
            audio_manual: () => form.audio,
            lut_manual:   () => form.lut,
            prompt:       () => form.prompt,
            duration:     () => form.duration,
        };
        setInputVal(prefill[step]?.() ?? '');
        setError('');
    }, [step]);

    const renderStep = () => {
        switch (step) {

            // ── Папка с видео ─────────────────────────────────────────────────
            case 'input':
                return (
                    <Box flexDirection="column" gap={1}>
                        <Text color="cyan" bold>  Папка с видео</Text>
                        <Box>
                            <Text dimColor>  {'> '}</Text>
                            <TextInput
                                value={inputVal}
                                placeholder={form.input || '/Volumes/...'}
                                onChange={setInputVal}
                                onSubmit={(v) => {
                                    const val = v.trim() || form.input;
                                    if (!val) { setError('Укажи папку'); return; }
                                    set('input', val); setStep('audio_choice');
                                }}
                            />
                        </Box>
                        {error && <Text color="red">  {error}</Text>}
                    </Box>
                );

            // ── Аудио ─────────────────────────────────────────────────────────
            case 'audio_choice':
                return (
                    <Box flexDirection="column" gap={1}>
                        <Text color="cyan" bold>  Аудиодорожка</Text>
                        <SelectInput
                            items={[
                                ...(form.audio ? [{ label: `↩  ${path.basename(form.audio)}`, value: 'keep' }] : []),
                                { label: '♪  Выбрать из папки music/', value: 'browse' },
                                { label: '✎  Ввести вручную',          value: 'manual' },
                            ]}
                            onSelect={(item: { value: string }) => {
                                if (item.value === 'keep')   setStep('prompt');
                                else if (item.value === 'browse') setStep('audio_browse');
                                else setStep('audio_manual');
                            }}
                        />
                    </Box>
                );

            case 'audio_browse':
                return (
                    <FileBrowser
                        folder={musicDir}
                        extensions={['.mp3', '.wav', '.aac', '.m4a']}
                        label="Аудиодорожка"
                        onSelect={(p) => { set('audio', p); setStep('prompt'); }}
                        onManual={() => setStep('audio_manual')}
                    />
                );

            case 'audio_manual':
                return (
                    <Box flexDirection="column" gap={1}>
                        <Text color="cyan" bold>  Путь к аудио</Text>
                        <Box>
                            <Text dimColor>  {'> '}</Text>
                            <TextInput
                                value={inputVal}
                                placeholder={form.audio || './track.mp3'}
                                onChange={setInputVal}
                                onSubmit={(v) => {
                                    const val = v.trim() || form.audio;
                                    if (!val) { setError('Укажи файл'); return; }
                                    set('audio', val); setStep('prompt');
                                }}
                            />
                        </Box>
                        {error && <Text color="red">  {error}</Text>}
                    </Box>
                );

            // ── Промпт ────────────────────────────────────────────────────────
            case 'prompt':
                return (
                    <Box flexDirection="column" gap={1}>
                        <Text color="cyan" bold>  Промпт для монтажа</Text>
                        <Box>
                            <Text dimColor>  {'> '}</Text>
                            <TextInput
                                value={inputVal}
                                placeholder={form.prompt || 'Эпичный ролик с природой...'}
                                onChange={setInputVal}
                                onSubmit={(v) => {
                                    const val = v.trim() || form.prompt;
                                    if (!val) { setError('Укажи промпт'); return; }
                                    set('prompt', val); setStep('duration');
                                }}
                            />
                        </Box>
                        {error && <Text color="red">  {error}</Text>}
                    </Box>
                );

            // ── Длительность ──────────────────────────────────────────────────
            case 'duration':
                return (
                    <Box flexDirection="column" gap={1}>
                        <Text color="cyan" bold>  Длительность (секунды)</Text>
                        <Box>
                            <Text dimColor>  {'> '}</Text>
                            <TextInput
                                value={inputVal}
                                placeholder={form.duration}
                                onChange={setInputVal}
                                onSubmit={(v) => {
                                    set('duration', v.trim() || form.duration);
                                    setStep('lut_choice');
                                }}
                            />
                        </Box>
                    </Box>
                );

            // ── LUT ───────────────────────────────────────────────────────────
            case 'lut_choice':
                return (
                    <Box flexDirection="column" gap={1}>
                        <Text color="cyan" bold>  LUT цветокоррекция</Text>
                        <SelectInput
                            items={[
                                ...(form.lut ? [{ label: `↩  ${path.basename(form.lut)}`, value: 'keep' }] : []),
                                { label: '◈  Выбрать из папки luts/', value: 'browse' },
                                { label: '✕  Без LUT',                value: 'none'   },
                                { label: '✎  Ввести вручную',         value: 'manual' },
                            ]}
                            onSelect={(item: { value: string }) => {
                                if (item.value === 'keep')   setStep('quality');
                                else if (item.value === 'none')   { set('lut', ''); setStep('quality'); }
                                else if (item.value === 'browse') setStep('lut_browse');
                                else setStep('lut_manual');
                            }}
                        />
                    </Box>
                );

            case 'lut_browse':
                return (
                    <FileBrowser
                        folder={lutsDir}
                        extensions={['.cube', '.3dl']}
                        label="LUT файл"
                        onSelect={(p) => { set('lut', p); setStep('quality'); }}
                        onManual={() => setStep('lut_manual')}
                        onNone={() => { set('lut', ''); setStep('quality'); }}
                    />
                );

            case 'lut_manual':
                return (
                    <Box flexDirection="column" gap={1}>
                        <Text color="cyan" bold>  Путь к LUT (.cube)</Text>
                        <Box>
                            <Text dimColor>  {'> '}</Text>
                            <TextInput
                                value={inputVal}
                                placeholder={form.lut || './cinematic.cube'}
                                onChange={setInputVal}
                                onSubmit={(v) => { set('lut', v.trim() || form.lut); setStep('quality'); }}
                            />
                        </Box>
                    </Box>
                );

            // ── Качество ──────────────────────────────────────────────────────
            case 'quality':
                return (
                    <Box flexDirection="column" gap={1}>
                        <Text color="cyan" bold>  Качество рендера</Text>
                        <SelectInput
                            items={QUALITY_ITEMS}
                            initialIndex={QUALITY_ITEMS.findIndex(i => i.value === form.quality)}
                            onSelect={(item: { value: string }) => { set('quality', item.value); setStep('confirm'); }}
                        />
                    </Box>
                );

            // ── Подтверждение ─────────────────────────────────────────────────
            case 'confirm': {
                const q = QUALITY_TEMPLATES[form.quality];
                return (
                    <Box flexDirection="column" gap={1}>
                        <Text bold color="green">  Готово к запуску</Text>
                        <Box flexDirection="column">
                            <Row label="Видео"        value={form.input} />
                            <Row label="Аудио"        value={path.basename(form.audio)} />
                            <Row label="Промпт"       value={form.prompt.slice(0, 50) + (form.prompt.length > 50 ? '…' : '')} />
                            <Row label="Длительность" value={form.duration + 's'} />
                            <Row label="LUT"          value={form.lut ? path.basename(form.lut) : '—'} dim={!form.lut} />
                            <Row label="Качество"     value={`${q.label} — ${q.description}`} />
                        </Box>
                        <SelectInput
                            items={[
                                { label: '▶  Запустить', value: 'go'   },
                                { label: '↩  Назад',     value: 'back' },
                            ]}
                            onSelect={(item: { value: string }) => {
                                if (item.value === 'back') { onBack(); return; }
                                onDone({
                                    input:    form.input,
                                    audio:    form.audio,
                                    prompt:   form.prompt,
                                    duration: parseInt(form.duration, 10) || 60,
                                    lut:      form.lut || path.join(cwd, 'cinematic.cube'),
                                    model:    form.model,
                                    output:   form.output,
                                    bitrate:  0,
                                    quality:  form.quality,
                                });
                            }}
                        />
                    </Box>
                );
            }
        }
    };

    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="cyan"
            paddingX={2}
            paddingY={1}
            marginX={1}
            marginY={1}
        >
            <Breadcrumb step={step} />
            {renderStep()}
        </Box>
    );
};
