import React, { useState, useEffect } from "react";
import * as fs from "fs";
import * as path from "path";
import { THEME } from "./index";

interface Props {
  folder: string;
  extensions: string[];
  label: string;
  onSelect: (path: string) => void;
  onManual: () => void;
  onNone?: () => void;
}

export const FileBrowser = ({
  folder,
  extensions,
  label,
  onSelect,
  onManual,
  onNone,
}: Props) => {
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    try {
      if (!fs.existsSync(folder)) {
        setFiles([]);
        setLoading(false);
        return;
      }
      const items = fs
        .readdirSync(folder)
        .filter((f) => extensions.includes(path.extname(f).toLowerCase()))
        .sort();
      setFiles(items);
    } catch (e) {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [folder]);

  if (loading) return <text style={{ fg: THEME.dim }}>Loading files...</text>;

  const items = [
    ...files.map((f) => ({
      name: `📄 ${f}`,
      description: "Select this file",
      value: path.join(folder, f),
    })),
    { name: "✎ Manual input", description: "Enter full path", value: "manual" },
    ...(onNone
      ? [
          {
            name: "✕ No file",
            description: "Continue without file",
            value: "none",
          },
        ]
      : []),
  ];

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <text style={{ fg: THEME.accent, marginBottom: 1 }}>{label}:</text>
      <select
        options={items}
        onSelect={(idx) => {
          const val = items[idx].value;
          if (val === "manual") onManual();
          else if (val === "none") onNone?.();
          else onSelect(val as string);
        }}
        focused={true}
        selectedBackgroundColor={THEME.accent}
        selectedTextColor="#ffffff"
        textColor={THEME.text}
        descriptionColor={THEME.dim}
        selectedDescriptionColor="#e2e8f0"
        style={{ flexGrow: 1 }}
      />
    </box>
  );
};
