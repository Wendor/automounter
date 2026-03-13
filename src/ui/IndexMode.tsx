import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import { getFolderStats, formatSize, formatDuration } from './helpers';

interface IndexResult {
    input: string;
    model: string;
    reindex: boolean;
}

interface Props {
    defaultInput: string;
    defaultModel: string;
    onDone: (result: IndexResult) => void;
    onBack: () => void;
}

export const IndexMode: React.FC<Props> = ({ defaultInput, defaultModel, onDone, onBack }) => {
    const [step, setStep] = useState<'input' | 'confirm'>('input');
    const [input, setInput] = useState(defaultInput);
    const [inputVal, setInputVal] = useState('');
    const [reindex, setReindex] = useState(false);

    if (step === 'input') {
        return (
            <Box flexDirection="column" paddingX={1} paddingY={1}>
                <Text color="cyan">  Папка с видео для индексации</Text>
                <Text dimColor>  {input || 'не задана'}</Text>
                <Box><Text dimColor>  {'> '}</Text>
                    <TextInput
                        value={inputVal}
                        placeholder={input || '/Volumes/...'}
                        onChange={setInputVal}
                        onSubmit={(v) => {
                            const val = v.trim() || input;
                            if (!val) return;
                            setInput(val);
                            setInputVal('');
                            setStep('confirm');
                        }}
                    />
                </Box>
            </Box>
        );
    }

    const stats    = getFolderStats(input);
    const uncached = stats.total - stats.cached;
    const estimateSec = uncached * 60;

    return (
        <Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>
            <Text color="cyan" bold>  Индексация</Text>
            <Box flexDirection="column">
                <Box><Text dimColor>  {'Папка:'.padEnd(22)}</Text><Text dimColor>{input}</Text></Box>
                <Box><Text dimColor>  {'Всего файлов:'.padEnd(22)}</Text><Text>{stats.total}</Text></Box>
                <Box><Text dimColor>  {'В кэше:'.padEnd(22)}</Text><Text color="green">{stats.cached}</Text></Box>
                <Box><Text dimColor>  {'Нужно обработать:'.padEnd(22)}</Text><Text color={uncached > 0 ? 'yellow' : 'green'}>{uncached}</Text></Box>
                <Box><Text dimColor>  {'Объём:'.padEnd(22)}</Text><Text>{formatSize(stats.totalBytes)}</Text></Box>
                {uncached > 0 && (
                    <Box><Text dimColor>  {'Оценка времени:'.padEnd(22)}</Text><Text>{formatDuration(estimateSec)}</Text></Box>
                )}
            </Box>
            <Box flexDirection="column">
                <SelectInput
                    items={[
                        { label: reindex ? '● Да — удалить кэш и переиндексировать' : '○ Нет — только новые файлы', value: 'toggle' },
                        { label: '▶  Запустить индексацию', value: 'go'   },
                        { label: '↩  Назад в меню',         value: 'back' },
                    ]}
                    onSelect={(item) => {
                        if (item.value === 'toggle') setReindex(r => !r);
                        else if (item.value === 'back') onBack();
                        else onDone({ input, model: defaultModel, reindex });
                    }}
                />
            </Box>
        </Box>
    );
};
