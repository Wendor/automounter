import React, { useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import * as path from "path";
import { QualityLevel, QUALITY_TEMPLATES, RenderSession } from "../types";
import { FileBrowser } from "./FileBrowser";
import { THEME } from "./index";

interface Props {
  session: RenderSession;
  currentLut: string;
  currentQuality: QualityLevel;
  currentOutput: string;
  currentColorRef: string;
  cwd: string;
  onDone: (res: {
    lut: string;
    quality: QualityLevel;
    output: string;
    colorRef?: string;
  }) => void;
  onBack: () => void;
}

type Step =
  | "lut_choice"
  | "lut_browse"
  | "lut_manual"
  | "color_ref_choice"
  | "color_ref_youtube"
  | "color_ref_images"
  | "color_ref_local"
  | "quality"
  | "confirm";

const QUALITY_ITEMS = (Object.keys(QUALITY_TEMPLATES) as QualityLevel[]).map(
  (k) => ({
    name: QUALITY_TEMPLATES[k].label,
    description: QUALITY_TEMPLATES[k].description,
    value: k,
  }),
);

const truncate = (str: string, maxLen: number) => {
  if (str.length <= maxLen) return str;
  return "..." + str.slice(-(maxLen - 3));
};

export const EditMode = ({
  session,
  currentLut,
  currentQuality,
  currentOutput,
  currentColorRef,
  cwd,
  onDone,
  onBack,
}: Props) => {
  const { width } = useTerminalDimensions();
  const [step, setStep] = useState<Step>("lut_choice");
  const [lut, setLut] = useState(currentLut);
  const [quality, setQuality] = useState(currentQuality);

  const [colorRef, setColorRef] = useState(currentColorRef);
  const [inputVal, setInputVal] = useState("");

  const goToStep = (s: Step, prefill = "") => {
    setInputVal(prefill);
    setStep(s);
  };

  const selectStyles = {
    selectedBackgroundColor: THEME.accent,
    selectedTextColor: "#ffffff",
    textColor: THEME.text,
    descriptionColor: THEME.dim,
    selectedDescriptionColor: "#e2e8f0",
    style: { flexGrow: 1 },
  };

  const renderInput = () => {
    switch (step) {
      case "lut_choice":
        const lutItems = [
          {
            name: "Keep current",
            description: lut ? path.basename(lut) : "без LUT",
            value: "keep",
          },
          {
            name: "◈ Browse luts/",
            description: "Select file",
            value: "browse",
          },
          {
            name: "✕ No LUT",
            description: "Disable color grade",
            value: "none",
          },
          {
            name: "✎ Manual path",
            description: "Path to .cube",
            value: "manual",
          },
        ];
        return (
          <box style={{ flexDirection: "column", flexGrow: 1 }}>
            <text style={{ fg: THEME.accent, marginBottom: 1 }}>
              LUT Grading:
            </text>
            <select
              options={lutItems}
              onSelect={(idx) => {
                const val = lutItems[idx].value;
                if (val === "keep") goToStep("color_ref_choice");
                else if (val === "none") {
                  setLut("");
                  goToStep("color_ref_choice");
                } else if (val === "browse") goToStep("lut_browse");
                else goToStep("lut_manual", lut);
              }}
              focused={true}
              {...selectStyles}
            />
          </box>
        );
      case "lut_browse":
        return (
          <FileBrowser
            folder={path.join(cwd, "luts")}
            extensions={[".cube", ".3dl"]}
            label="Select LUT file"
            onSelect={(p) => {
              setLut(p);
              setStep("color_ref_choice");
            }}
            onManual={() => goToStep("lut_manual")}
            onNone={() => {
              setLut("");
              goToStep("color_ref_choice");
            }}
          />
        );
      case "lut_manual":
        return (
          <box style={{ flexDirection: "column" }}>
            <text style={{ fg: THEME.accent, marginBottom: 1 }}>
              Path to LUT (.cube):
            </text>
            <input
              value={inputVal}
              onInput={setInputVal}
              onSubmit={(v: any) => {
                setLut(String(v).trim() || lut);
                goToStep("color_ref_choice");
              }}
              focused={true}
              style={{ textColor: THEME.text }}
            />
          </box>
        );
      case "color_ref_choice":
        const colorRefItems = [
          {
            name: "Оставить текущий",
            description: colorRef
              ? colorRef.startsWith("http")
                ? colorRef.slice(0, 50)
                : path.basename(colorRef)
              : "без референса",
            value: "keep",
          },
          {
            name: "✕ Без референса",
            description: "Только LUT цветокоррекция",
            value: "none",
          },
          {
            name: "◧ Папка с изображениями",
            description: "jpg/png/webp референсные кадры",
            value: "images",
          },
          {
            name: "▶ YouTube URL",
            description: "Ввести ссылку на видео",
            value: "youtube",
          },
          {
            name: "✎ Локальный видеофайл",
            description: "mp4/mov на диске",
            value: "local",
          },
        ];
        return (
          <box style={{ flexDirection: "column", flexGrow: 1 }}>
            <text style={{ fg: THEME.accent, marginBottom: 1 }}>
              Цветовой референс:
            </text>
            <select
              options={colorRefItems}
              onSelect={(idx) => {
                const val = colorRefItems[idx]!.value;
                if (val === "keep") goToStep("quality");
                else if (val === "none") {
                  setColorRef("");
                  goToStep("quality");
                } else if (val === "youtube") goToStep("color_ref_youtube", colorRef.startsWith("http") ? colorRef : "");
                else if (val === "images") goToStep("color_ref_images", !colorRef.startsWith("http") ? colorRef : "");
                else goToStep("color_ref_local");
              }}
              focused={true}
              {...selectStyles}
            />
          </box>
        );
      case "color_ref_youtube":
        return (
          <box style={{ flexDirection: "column" }}>
            <text style={{ fg: THEME.accent, marginBottom: 1 }}>
              YouTube URL:
            </text>
            <input
              value={inputVal}
              placeholder="https://youtube.com/watch?v=..."
              onInput={setInputVal}
              onSubmit={(v: any) => {
                const val = String(v).trim();
                if (!val) return;
                setColorRef(val);
                goToStep("quality");
              }}
              focused={true}
              style={{ textColor: THEME.text }}
            />
          </box>
        );
      case "color_ref_images":
        return (
          <box style={{ flexDirection: "column" }}>
            <text style={{ fg: THEME.accent, marginBottom: 1 }}>
              Путь к папке с изображениями:
            </text>
            <input
              value={inputVal}
              placeholder="./reference"
              onInput={setInputVal}
              onSubmit={(v: any) => {
                const val = String(v).trim();
                if (!val) return;
                setColorRef(val);
                goToStep("quality");
              }}
              focused={true}
              style={{ textColor: THEME.text }}
            />
          </box>
        );
      case "color_ref_local":
        return (
          <FileBrowser
            folder={cwd}
            extensions={[".mp4", ".mov", ".mkv"]}
            label="Выберите видео-референс"
            onSelect={(p) => {
              setColorRef(p);
              setStep("quality");
            }}
            onManual={() => goToStep("color_ref_youtube")}
            onNone={() => {
              setColorRef("");
              goToStep("quality");
            }}
          />
        );
      case "quality":
        return (
          <box style={{ flexDirection: "column", flexGrow: 1 }}>
            <text style={{ fg: THEME.accent, marginBottom: 1 }}>
              Render Quality:
            </text>
            <select
              options={QUALITY_ITEMS}
              selectedIndex={Math.max(0, QUALITY_ITEMS.findIndex((q) => q.value === quality))}
              onSelect={(idx) => {
                setQuality(QUALITY_ITEMS[idx].value as QualityLevel);
                setStep("confirm");
              }}
              focused={true}
              {...selectStyles}
            />
          </box>
        );
      case "confirm":
        const confirmItems = [
          { name: "▶ Re-render", description: "Start export", value: "go" },
          { name: "↩ Back", description: "Main menu", value: "back" },
        ];
        return (
          <box style={{ flexDirection: "column", flexGrow: 1 }}>
            <text style={{ fg: THEME.success, attributes: 1, marginBottom: 1 }}>
              Ready to re-render!
            </text>
            <select
              options={confirmItems}
              selectedIndex={0}
              onSelect={(idx) => {
                if (confirmItems[idx].value === "back") {
                  onBack();
                  return;
                }
                onDone({ lut, quality, output: currentOutput, colorRef: colorRef || undefined });
              }}
              focused={true}
              {...selectStyles}
            />
          </box>
        );
      default:
        return null;
    }
  };

  const maxValLen = width - 20;

  return (
    <box
      style={{
        flexDirection: "column",
        borderStyle: "rounded",
        borderColor: THEME.accent,
        padding: 1,
        margin: 1,
        backgroundColor: THEME.background,
        width: "100%",
        height: "100%",
      }}
    >
      <text style={{ fg: THEME.accent, attributes: 1, marginBottom: 1 }}>
        {" "}
        ✎ EDIT SESSION{" "}
      </text>
      <box
        style={{
          flexDirection: "column",
          marginBottom: 1,
          borderStyle: "rounded",
          borderColor: THEME.border,
          padding: 1,
        }}
      >
        <box style={{ flexDirection: "row" }}>
          <box style={{ width: 12 }}>
            <text style={{ fg: THEME.dim }}>Session: </text>
          </box>
          <text style={{ fg: THEME.text }}>{session.renderedAt}</text>
        </box>
        <box style={{ flexDirection: "row" }}>
          <box style={{ width: 12 }}>
            <text style={{ fg: THEME.dim }}>LUT: </text>
          </box>
          <text style={{ fg: THEME.highlight }}>
            {truncate(lut ? path.basename(lut) : "—", maxValLen)}
          </text>
        </box>
        <box style={{ flexDirection: "row" }}>
          <box style={{ width: 12 }}>
            <text style={{ fg: THEME.dim }}>Color ref: </text>
          </box>
          <text style={{ fg: THEME.highlight }}>
            {truncate(
              colorRef
                ? colorRef.startsWith("http")
                  ? colorRef.slice(0, 40)
                  : path.basename(colorRef)
                : "—",
              maxValLen,
            )}
          </text>
        </box>
        <box style={{ flexDirection: "row" }}>
          <box style={{ width: 12 }}>
            <text style={{ fg: THEME.dim }}>Quality: </text>
          </box>
          <text style={{ fg: THEME.highlight }}>{quality}</text>
        </box>
      </box>
      <box
        style={{
          flexGrow: 1,
          marginTop: 1,
          borderStyle: "rounded",
          borderColor: THEME.border,
          padding: 1,
        }}
      >
        {renderInput()}
      </box>
    </box>
  );
};
