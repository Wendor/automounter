import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import * as path from 'path';
import { QualityLevel, QUALITY_TEMPLATES, RenderSession } from '../types';
import { FileBrowser } from './FileBrowser';

interface EditResult { lut: string; quality: QualityLevel; output: string; }

interface Props {
    session:        RenderSession;
    currentLut:     string;
    currentQuality: QualityLevel;
    currentOutput:  string;
    cwd:            string;
    onDone:  (result: EditResult) => void;
    onBack:  () => void;
}

type Step = 'info' | 'lut_choice' | 'lut_browse' | 'lut_manual' | 'quality' | 'output' | 'confirm';

const QUALITY_ITEMS = (Object.keys(QUALITY_TEMPLATES) as QualityLevel[]).map(k => ({
    label: `${QUALITY_TEMPLATES[k].label.padEnd(18)} ${QUALITY_TEMPLATES[k].description}`,
    value: k,
}));

export const EditMode: React.FC<Props> = ({
    session, currentLut, currentQuality, currentOutput, cwd, onDone, onBack,
}) => {
    const [step,     setStep]     = useState<Step>('info');
    const [lut,      setLut]      = useState(currentLut);
    const [quality,  setQuality]  = useState<QualityLevel>(currentQuality);
    const [output,   setOutput]   = useState(currentOutput);
    const [inputVal, setInputVal] = useState('');

    const lutsDir      = path.join(cwd, 'luts');
    const renderedAt   = new Date(session.renderedAt).toLocaleString('ru-RU');
    const defaultOutput = currentOutput.replace(/(\.\w+)$/, `_edit_${Date.now().toString(36)}$1`);

    useEffect(() => {
        if (step === 'lut_manual') setInputVal(lut);
        else if (step === 'output') setInputVal(defaultOutput);
        else setInputVal('');
    }, [step]);

    switch (step) {
        case 'info':
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
                    <Text bold color="cyan">  Правка последнего ролика</Text>
                    <Box flexDirection="column">
                        <Box><Text dimColor>  {'Дата рендера:'.padEnd(18)}</Text><Text>{renderedAt}</Text></Box>
                        <Box><Text dimColor>  {'Сегментов:'.padEnd(18)}</Text><Text>{session.segments.length}</Text></Box>
                        <Box><Text dimColor>  {'Длительность:'.padEnd(18)}</Text><Text>{session.totalDuration.toFixed(1)}s</Text></Box>
                        <Box><Text dimColor>  {'Аудио:'.padEnd(18)}</Text><Text dimColor>{path.basename(session.audio)}</Text></Box>
                    </Box>
                    <Text dimColor>  Сегменты будут перерендерены с новыми настройками.</Text>
                    <SelectInput
                        items={[
                            { label: '▶  Продолжить',   value: 'go'   },
                            { label: '↩  Назад в меню', value: 'back' },
                        ]}
                        onSelect={(item: { value: string }) => {
                            if (item.value === 'back') onBack();
                            else setStep('lut_choice');
                        }}
                    />
                </Box>
            );

        case 'lut_choice':
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
                    <Text bold color="cyan">  LUT цветокоррекция</Text>
                    <SelectInput
                        items={[
                            ...(lut ? [{ label: `↩  ${path.basename(lut)}`, value: 'keep' }] : []),
                            { label: '◈  Выбрать из папки luts/', value: 'browse' },
                            { label: '✕  Без LUT',                value: 'none'   },
                            { label: '✎  Ввести вручную',         value: 'manual' },
                        ]}
                        onSelect={(item: { value: string }) => {
                            if (item.value === 'keep')        setStep('quality');
                            else if (item.value === 'none')   { setLut(''); setStep('quality'); }
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
                    onSelect={(p) => { setLut(p); setStep('quality'); }}
                    onManual={() => setStep('lut_manual')}
                    onNone={() => { setLut(''); setStep('quality'); }}
                />
            );

        case 'lut_manual':
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
                    <Text bold color="cyan">  Путь к LUT (.cube)</Text>
                    <Box><Text dimColor>  {'> '}</Text>
                        <TextInput
                            value={inputVal}
                            placeholder={lut || './cinematic.cube'}
                            onChange={setInputVal}
                            onSubmit={(v) => { setLut(v.trim() || lut); setStep('quality'); }}
                        />
                    </Box>
                </Box>
            );

        case 'quality':
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
                    <Text bold color="cyan">  Качество рендера</Text>
                    <SelectInput
                        items={QUALITY_ITEMS}
                        initialIndex={QUALITY_ITEMS.findIndex(i => i.value === quality)}
                        onSelect={(item: { value: string }) => { setQuality(item.value as QualityLevel); setStep('output'); }}
                    />
                </Box>
            );

        case 'output':
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
                    <Text bold color="cyan">  Выходной файл</Text>
                    <Text dimColor>  Enter = новый файл с суффиксом _edit</Text>
                    <Box><Text dimColor>  {'> '}</Text>
                        <TextInput
                            value={inputVal}
                            placeholder={defaultOutput}
                            onChange={setInputVal}
                            onSubmit={(v) => { setOutput(v.trim() || defaultOutput); setStep('confirm'); }}
                        />
                    </Box>
                </Box>
            );

        case 'confirm': {
            const q = QUALITY_TEMPLATES[quality];
            return (
                <Box
                    flexDirection="column"
                    borderStyle="round"
                    borderColor="green"
                    paddingX={2}
                    paddingY={1}
                    marginX={1}
                    marginY={1}
                    gap={1}
                >
                    <Text bold color="green">  Параметры ре-рендера</Text>
                    <Box flexDirection="column">
                        <Box><Text dimColor>  {'LUT:'.padEnd(16)}</Text><Text>{lut ? path.basename(lut) : '—'}</Text></Box>
                        <Box><Text dimColor>  {'Качество:'.padEnd(16)}</Text><Text>{q.label} — {q.description}</Text></Box>
                        <Box><Text dimColor>  {'Выход:'.padEnd(16)}</Text><Text dimColor>{output}</Text></Box>
                    </Box>
                    <SelectInput
                        items={[
                            { label: '▶  Рендерить', value: 'go'   },
                            { label: '↩  Назад',     value: 'back' },
                        ]}
                        onSelect={(item: { value: string }) => {
                            if (item.value === 'back') onBack();
                            else onDone({ lut, quality, output });
                        }}
                    />
                </Box>
            );
        }

        default: return null;
    }
};
