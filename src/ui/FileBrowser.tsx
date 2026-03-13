import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import * as path from 'path';
import { scanFiles } from './helpers';

interface Props {
    folder: string;
    extensions: string[];
    label: string;
    onSelect: (absolutePath: string) => void;
    onManual: () => void;
    onNone?: () => void;  // опциональная опция "Без файла"
}

export const FileBrowser: React.FC<Props> = ({ folder, extensions, label, onSelect, onManual, onNone }) => {
    const files = scanFiles(folder, extensions);

    const items = [
        ...(onNone ? [{ label: '✕  Без файла', value: '__none__' }] : []),
        ...files.map(f => ({ label: path.relative(folder, f), value: f })),
        { label: '✎  Ввести вручную', value: '__manual__' },
    ];

    if (files.length === 0) {
        // Папка пуста — сразу предлагаем ручной ввод
        const emptyItems = [
            ...(onNone ? [{ label: '✕  Без файла', value: '__none__' }] : []),
            { label: '✎  Ввести вручную', value: '__manual__' },
        ];
        return (
            <Box flexDirection="column">
                <Text dimColor>  Папка {folder} пуста</Text>
                <SelectInput items={emptyItems} onSelect={(item) => {
                    if (item.value === '__none__') onNone?.();
                    else onManual();
                }} />
            </Box>
        );
    }

    return (
        <Box flexDirection="column">
            <Text color="cyan">  {label}</Text>
            <SelectInput
                items={items}
                limit={12}
                onSelect={(item) => {
                    if (item.value === '__manual__') onManual();
                    else if (item.value === '__none__') onNone?.();
                    else onSelect(item.value);
                }}
            />
        </Box>
    );
};
