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
  cwd: string;
  onDone: (res: { lut: string; quality: QualityLevel; output: string }) => void;
  onBack: () => void;
}

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
  cwd,
  onDone,
  onBack,
}: Props) => {
  const { width } = useTerminalDimensions();
  const [step, setStep] = useState<
    | "lut_choice"
    | "lut_browse"
    | "lut_manual"
    | "quality"
    | "output"
    | "confirm"
  >("lut_choice");
  const [lut, setLut] = useState(currentLut);
  const [quality, setQuality] = useState(currentQuality);
  const [output, setOutput] = useState(currentOutput);
  const [inputVal, setInputVal] = useState("");

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
          ...(lut
            ? [
                {
                  name: "Keep current",
                  description: path.basename(lut),
                  value: "keep",
                },
              ]
            : []),
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
                if (val === "keep") setStep("quality");
                else if (val === "none") {
                  setLut("");
                  setStep("quality");
                } else if (val === "browse") setStep("lut_browse");
                else setStep("lut_manual");
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
              setStep("quality");
            }}
            onManual={() => setStep("lut_manual")}
            onNone={() => {
              setLut("");
              setStep("quality");
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
              onSelect={(idx) => {
                setQuality(QUALITY_ITEMS[idx].value as QualityLevel);
                setStep("output");
              }}
              focused={true}
              {...selectStyles}
            />
          </box>
        );
      case "output":
        return (
          <box style={{ flexDirection: "column" }}>
            <text style={{ fg: THEME.accent, marginBottom: 1 }}>
              Output Path:
            </text>
            <input
              value={inputVal || output}
              onInput={setInputVal}
              onSubmit={(v: any) => {
                setOutput(String(v) || output);
                setStep("confirm");
              }}
              focused={true}
              style={{ textColor: THEME.text }}
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
              onSelect={(idx) => {
                if (confirmItems[idx].value === "back") {
                  onBack();
                  return;
                }
                onDone({ lut, quality, output });
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
