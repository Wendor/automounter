import React, { useState } from 'react';
import { THEME } from './index';

interface Props {
    defaultInput: string;
    defaultModel: string;
    onDone:       (res: { input: string; model: string; reindex: boolean }) => void;
    onBack:       () => void;
}

export const IndexMode = ({ defaultInput, defaultModel, onDone, onBack }: Props) => {
    const [step, setStep] = useState<'input' | 'model' | 'reindex' | 'confirm'>('input');
    const [input, setInput] = useState(defaultInput);
    const [model, setModel] = useState(defaultModel);
    const [reindex, setReindex] = useState(false);
    const [inputVal, setInputVal] = useState('');

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
                    <box style={{ flexDirection: 'column' }}><text style={{ fg: THEME.accent, marginBottom: 1 }}>Indexing Folder:</text><input value={inputVal || input} onInput={setInputVal} onSubmit={(v: any) => { setInput(String(v) || input); setStep('model'); }} focused={true} style={{ textColor: THEME.text }} /></box>
                );
            case 'model':
                return (
                    <box style={{ flexDirection: 'column' }}><text style={{ fg: THEME.accent, marginBottom: 1 }}>AI Model (ollama):</text><input value={inputVal || model} onInput={setInputVal} onSubmit={(v: any) => { setModel(String(v) || model); setStep('reindex'); }} focused={true} style={{ textColor: THEME.text }} /></box>
                );
            case 'reindex':
                const reindexItems = [
                    { name: '✕ No', description: 'Index only new files', value: false },
                    { name: '✓ Yes', description: 'Re-index everything', value: true },
                ];
                return (
                    <box style={{ flexDirection: 'column', flexGrow: 1 }}><text style={{ fg: THEME.accent, marginBottom: 1 }}>Force full re-index?</text><select options={reindexItems} onSelect={(idx) => { setReindex(reindexItems[idx].value as boolean); setStep('confirm'); }} focused={true} {...selectStyles} /></box>
                );
            case 'confirm':
                const confirmItems = [
                    { name: '▶ Start Indexing', description: 'Run scanner', value: 'go'   },
                    { name: '↩ Back', description: 'Main menu', value: 'back' },
                ];
                return (
                    <box style={{ flexDirection: 'column', flexGrow: 1 }}><text style={{ fg: THEME.success, attributes: 1, marginBottom: 1 }}>Ready to scan!</text><select options={confirmItems} onSelect={(idx) => { if (confirmItems[idx].value === 'back') { onBack(); return; } onDone({ input, model, reindex }); }} focused={true} {...selectStyles} /></box>
                );
            default: return null;
        }
    };

    return (
        <box style={{ flexDirection: 'column', borderStyle: 'rounded', borderColor: THEME.accent, padding: 1, margin: 1, backgroundColor: THEME.background, width: '100%', height: '100%' }}><text style={{ fg: THEME.accent, attributes: 1, marginBottom: 1 }}> ⟳ INDEXER </text><box style={{ flexDirection: 'column', marginBottom: 1, borderStyle: 'rounded', borderColor: THEME.border, padding: 1 }}><box style={{ flexDirection: 'row' }}><box style={{ width: 12 }}><text style={{ fg: THEME.dim }}>Path: </text></box><text style={{ fg: THEME.highlight }}>{input}</text></box><box style={{ flexDirection: 'row' }}><box style={{ width: 12 }}><text style={{ fg: THEME.dim }}>Model: </text></box><text style={{ fg: THEME.highlight }}>{model}</text></box></box><box style={{ flexGrow: 1, marginTop: 1, borderStyle: 'rounded', borderColor: THEME.border, padding: 1 }}>{renderInput()}</box></box>
    );
};