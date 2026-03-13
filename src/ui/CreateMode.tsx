import React, { useState, useEffect } from 'react';
import { useTerminalDimensions } from '@opentui/react';
import * as path from 'path';
import { Config } from '../config';
import { QualityLevel, QUALITY_TEMPLATES } from '../types';
import { FileBrowser } from './FileBrowser';
import { THEME } from './index';

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
    name: QUALITY_TEMPLATES[k].label,
    description: QUALITY_TEMPLATES[k].description,
    value: k,
}));

const truncate = (str: string, maxLen: number) => {
    if (str.length <= maxLen) return str;
    return '...' + str.slice(-(maxLen - 3));
};

export const CreateMode: React.FC<Props> = ({ saved, cwd, onDone, onBack }) => {
    const { width } = useTerminalDimensions();
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

    const currentStepIdx = STEPS.indexOf(step === 'audio_browse' || step === 'audio_manual' ? 'audio_choice' : 
                                       step === 'lut_browse' || step === 'lut_manual' ? 'lut_choice' : step);

    const set = (field: keyof Form, value: string) => setForm(f => ({ ...f, [field]: value }));

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

    const selectStyles = {
        selectedBackgroundColor: THEME.accent,
        selectedTextColor: "#ffffff",
        textColor: THEME.text,
        descriptionColor: THEME.dim,
        selectedDescriptionColor: "#e2e8f0",
        style: { flexGrow: 1 }
    };

    const renderInput = () => {
        switch (step) {
            case 'input':
                return (
                    <box style={{ flexDirection: 'column' }}><text style={{ color: THEME.accent, marginBottom: 1 }}>Укажите папку с видео:</text><input value={inputVal} placeholder={form.input || '/path/to/video'} onInput={setInputVal} onSubmit={(v) => { const val = v.trim() || form.input; if (!val) { setError('Укажи папку'); return; } set('input', val); setStep('audio_choice'); }} focused={true} style={{ textColor: THEME.text }} /></box>
                );
            case 'audio_choice':
                const audioItems = [
                    ...(form.audio ? [{ name: 'Оставить текущий', description: path.basename(form.audio), value: 'keep' }] : []),
                    { name: '♪ Из папки music/', description: 'Выбрать файл', value: 'browse' },
                    { name: '✎ Ввести вручную', description: 'Полный путь', value: 'manual' },
                ];
                return (
                    <box style={{ flexDirection: 'column', flexGrow: 1 }}><text style={{ color: THEME.accent, marginBottom: 1 }}>Аудиодорожка:</text><select options={audioItems} onSelect={(idx) => { const val = audioItems[idx].value; if (val === 'keep') setStep('prompt'); else if (val === 'browse') setStep('audio_browse'); else setStep('audio_manual'); }} focused={true} {...selectStyles} /></box>
                );
            case 'audio_browse':
                return (
                    <FileBrowser folder={path.join(cwd, 'music')} extensions={['.mp3', '.wav', '.aac', '.m4a']} label="Выберите аудиофайл" onSelect={(p) => { set('audio', p); setStep('prompt'); }} onManual={() => setStep('audio_manual')} />
                );
            case 'audio_manual':
                return (
                    <box style={{ flexDirection: 'column' }}><text style={{ color: THEME.accent, marginBottom: 1 }}>Путь к аудио:</text><input value={inputVal} placeholder={form.audio || './track.mp3'} onInput={setInputVal} onSubmit={(v) => { const val = v.trim() || form.audio; if (!val) { setError('Укажи файл'); return; } set('audio', val); setStep('prompt'); }} focused={true} style={{ textColor: THEME.text }} /></box>
                );
            case 'prompt':
                return (
                    <box style={{ flexDirection: 'column' }}><text style={{ color: THEME.accent, marginBottom: 1 }}>Промпт для монтажа:</text><input value={inputVal} placeholder={form.prompt || 'Эпичный ролик...'} onInput={setInputVal} onSubmit={(v) => { const val = v.trim() || form.prompt; if (!val) { setError('Укажи промпт'); return; } set('prompt', val); setStep('duration'); }} focused={true} style={{ textColor: THEME.text }} /></box>
                );
            case 'duration':
                 return (
                    <box style={{ flexDirection: 'column' }}><text style={{ color: THEME.accent, marginBottom: 1 }}>Длительность (сек):</text><input value={inputVal} placeholder={form.duration} onInput={setInputVal} onSubmit={(v) => { set('duration', v.trim() || form.duration); setStep('lut_choice'); }} focused={true} style={{ textColor: THEME.text }} /></box>
                );
            case 'lut_choice':
                const lutItems = [
                    ...(form.lut ? [{ name: 'Оставить текущий', description: path.basename(form.lut), value: 'keep' }] : []),
                    { name: '◈ Из папки luts/', description: 'Выбрать файл', value: 'browse' },
                    { name: '✕ Без LUT', description: 'Отключить цветокор', value: 'none'   },
                    { name: '✎ Ввести вручную', description: 'Путь к .cube', value: 'manual' },
                ];
                return (
                    <box style={{ flexDirection: 'column', flexGrow: 1 }}><text style={{ color: THEME.accent, marginBottom: 1 }}>LUT цветокоррекция:</text><select options={lutItems} onSelect={(idx) => { const val = lutItems[idx].value; if (val === 'keep') setStep('quality'); else if (val === 'none') { set('lut', ''); setStep('quality'); } else if (val === 'browse') setStep('lut_browse'); else setStep('lut_manual'); }} focused={true} {...selectStyles} /></box>
                );
            case 'lut_browse':
                return (
                    <FileBrowser folder={path.join(cwd, 'luts')} extensions={['.cube', '.3dl']} label="Выберите LUT файл" onSelect={(p) => { set('lut', p); setStep('quality'); }} onManual={() => setStep('lut_manual')} onNone={() => { set('lut', ''); setStep('quality'); }} />
                );
            case 'lut_manual':
                return (
                    <box style={{ flexDirection: 'column' }}><text style={{ color: THEME.accent, marginBottom: 1 }}>Путь к LUT (.cube):</text><input value={inputVal} placeholder={form.lut || './cinematic.cube'} onInput={setInputVal} onSubmit={(v) => { set('lut', v.trim() || form.lut); setStep('quality'); }} focused={true} style={{ textColor: THEME.text }} /></box>
                );
            case 'quality':
                return (
                    <box style={{ flexDirection: 'column', flexGrow: 1 }}><text style={{ color: THEME.accent, marginBottom: 1 }}>Качество рендера:</text><select options={QUALITY_ITEMS} onSelect={(idx) => { set('quality', QUALITY_ITEMS[idx].value); setStep('confirm'); }} focused={true} {...selectStyles} /></box>
                );
            case 'confirm':
                const confirmItems = [
                    { name: '▶ Запустить', description: 'Начать рендеринг', value: 'go'   },
                    { name: '↩ Назад', description: 'В главное меню', value: 'back' },
                ];
                return (
                    <box style={{ flexDirection: 'column', flexGrow: 1 }}><text style={{ color: THEME.success, bold: true, marginBottom: 1 }}>Готово к запуску!</text><select options={confirmItems} selectedIndex={0} onSelect={(idx) => { const val = confirmItems[idx].value; if (val === 'back') { onBack(); return; } onDone({ input: form.input, audio: form.audio, prompt: form.prompt, duration: parseInt(form.duration, 10) || 60, lut: form.lut || path.join(cwd, 'cinematic.cube'), model: form.model, output: form.output, bitrate: 0, quality: form.quality }); }} focused={true} {...selectStyles} /></box>
                );
            default:
                return <text>Шаг {step} еще не реализован</text>;
        }
    };

    const leftColWidth = width - 32;
    const maxValLen = leftColWidth - 16;

    return (
        <box style={{ flexDirection: 'row', width: '100%', height: '100%', padding: 1, backgroundColor: THEME.background }}><box style={{ flexDirection: 'column', flexGrow: 1, marginRight: 1 }}><box style={{ height: 11, borderStyle: 'round', borderColor: THEME.border, padding: 1, marginBottom: 1, flexDirection: 'column' }}><text style={{ bold: true, color: THEME.accent }}> PROJECT CONFIG </text><box style={{ flexDirection: 'column', marginTop: 1 }}><box style={{ flexDirection: 'row' }}><box style={{ width: 12 }}><text style={{ color: THEME.dim }}>Video: </text></box><text style={{ color: THEME.highlight }}>{truncate(form.input || '—', maxValLen)}</text></box><box style={{ flexDirection: 'row' }}><box style={{ width: 12 }}><text style={{ color: THEME.dim }}>Audio: </text></box><text style={{ color: THEME.highlight }}>{truncate(path.basename(form.audio) || '—', maxValLen)}</text></box><box style={{ flexDirection: 'row' }}><box style={{ width: 12 }}><text style={{ color: THEME.dim }}>Prompt: </text></box><text style={{ color: THEME.highlight }}>{truncate(form.prompt || '—', maxValLen)}</text></box><box style={{ flexDirection: 'row', marginTop: 1 }}><box style={{ width: 12 }}><text style={{ color: THEME.dim }}>Duration: </text></box><box style={{ width: 10 }}><text style={{ color: THEME.highlight }}>{form.duration}s</text></box><box style={{ width: 12, marginLeft: 2 }}><text style={{ color: THEME.dim }}>Quality: </text></box><text style={{ color: THEME.highlight }}>{form.quality}</text></box></box></box><box style={{ flexGrow: 1, borderStyle: 'round', borderColor: THEME.accent, padding: 1, marginBottom: 1, flexDirection: 'column' }}><text style={{ bold: true, color: THEME.text }}> DATA INPUT </text><box style={{ marginTop: 1, flexGrow: 1, flexDirection: 'column' }}>{renderInput()}</box>{error ? <text style={{ color: THEME.error, marginTop: 1 }}>✗ {error}</text> : null}</box><box style={{ height: 5, borderStyle: 'round', borderColor: THEME.border, padding: 1, flexDirection: 'column' }}><text style={{ bold: true, color: THEME.dim }}> PROGRESS </text><box style={{ marginTop: 1, flexGrow: 1, flexDirection: 'row' }}><text style={{ color: THEME.accent }}>{'█'.repeat(Math.round(((currentStepIdx + 1) / STEPS.length) * (leftColWidth - 10)))}</text><text style={{ color: THEME.border }}>{'░'.repeat(Math.max(0, (leftColWidth - 10) - Math.round(((currentStepIdx + 1) / STEPS.length) * (leftColWidth - 10))))}</text><text style={{ color: THEME.text }}> {Math.round(((currentStepIdx + 1) / STEPS.length) * 100)}%</text></box></box></box><box style={{ width: 30, borderStyle: 'round', borderColor: THEME.border, padding: 1, flexDirection: 'column' }}><text style={{ bold: true, color: THEME.dim }}> STEPS </text><box style={{ flexDirection: 'column', marginTop: 1, flexGrow: 1 }}>{STEP_LABELS.map((label, i) => (<box key={i} style={{ marginBottom: 1, flexDirection: 'row' }}><text style={{ color: i < currentStepIdx ? THEME.success : i === currentStepIdx ? THEME.accent : THEME.dim, bold: i === currentStepIdx }}>{i < currentStepIdx ? '✓' : i === currentStepIdx ? '▸' : '·'} {label}</text></box>))}</box></box></box>
    );
};
