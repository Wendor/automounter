import React, { useState, useEffect } from "react";
import { useTerminalDimensions } from "@opentui/react";
import * as path from "path";
import { Config } from "../config";
import { QualityLevel, Orientation, QUALITY_TEMPLATES } from "../types";
import { FileBrowser } from "./FileBrowser";
import { THEME } from "./index";

interface Props {
  saved: Partial<Config>;
  cwd: string;
  onDone: (config: Config) => void;
  onBack: () => void;
}

type Step =
  | "input"
  | "audio_choice"
  | "audio_browse"
  | "audio_manual"
  | "prompt"
  | "duration"
  | "lut_choice"
  | "lut_browse"
  | "lut_manual"
  | "color_ref_choice"
  | "color_ref_youtube"
  | "color_ref_images"
  | "color_ref_local"
  | "quality"
  | "orientation"
  | "confirm";

interface Form {
  input: string;
  audio: string;
  prompt: string;
  duration: string;
  lut: string;
  colorRef: string;
  quality: QualityLevel;
  orientation: Orientation;
  model: string;
  output: string;
}

const STEPS: Step[] = [
  "input",
  "audio_choice",
  "prompt",
  "duration",
  "lut_choice",
  "color_ref_choice",
  "quality",
  "orientation",
  "confirm",
];
const STEP_LABELS = [
  "Видео",
  "Аудио",
  "Промпт",
  "Длит",
  "LUT",
  "Цвет",
  "Качество",
  "Формат",
  "Старт",
];

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

export const CreateMode = ({ saved, cwd, onDone, onBack }: Props) => {
  const { width } = useTerminalDimensions();
  const [step, setStep] = useState<Step>("input");
  const [form, setForm] = useState<Form>({
    input: saved.input ?? "",
    audio: saved.audio ?? "",
    prompt: saved.prompt ?? "",
    duration: String(saved.duration ?? 60),
    lut: saved.lut ?? "",
    colorRef: saved.colorRef ?? "",
    quality: saved.quality ?? "medium",
    orientation: saved.orientation ?? "horizontal",
    model: saved.model ?? "llava:13b",
    output: saved.output ?? path.join(cwd, "final_edit.mp4"),
  });
  const [inputVal, setInputVal] = useState("");
  const [error, setError] = useState("");

  const currentStepIdx = STEPS.indexOf(
    step === "audio_browse" || step === "audio_manual"
      ? "audio_choice"
      : step === "lut_browse" || step === "lut_manual"
        ? "lut_choice"
        : step === "color_ref_youtube" || step === "color_ref_local" || step === "color_ref_images"
          ? "color_ref_choice"
          : step,
  );

  const set = (field: keyof Form, value: string) =>
    setForm((f) => ({ ...f, [field]: value }));

  useEffect(() => {
    const prefill: Partial<Record<Step, () => string>> = {
      input: () => form.input,
      audio_manual: () => form.audio,
      lut_manual: () => form.lut,
      color_ref_youtube: () => form.colorRef,
      color_ref_images: () => form.colorRef,
      prompt: () => form.prompt,
      duration: () => form.duration,
    };
    setInputVal(prefill[step]?.() ?? "");
    setError("");
  }, [step]);

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
      case "input":
        return (
          <box style={{ flexDirection: "column" }}>
            <text style={{ fg: THEME.accent, marginBottom: 1 }}>
              Укажите папку с видео:
            </text>
            <input
              value={inputVal}
              placeholder={form.input || "/path/to/video"}
              onInput={setInputVal}
              onSubmit={(v: any) => {
                const val = String(v).trim() || form.input;
                if (!val) {
                  setError("Укажи папку");
                  return;
                }
                set("input", val);
                setStep("audio_choice");
              }}
              focused={true}
              style={{ textColor: THEME.text }}
            />
          </box>
        );
      case "audio_choice":
        const audioItems = [
          ...(form.audio
            ? [
                {
                  name: "Оставить текущий",
                  description: path.basename(form.audio),
                  value: "keep",
                },
              ]
            : []),
          {
            name: "♪ Из папки music/",
            description: "Выбрать файл",
            value: "browse",
          },
          {
            name: "✎ Ввести вручную",
            description: "Полный путь",
            value: "manual",
          },
        ];
        return (
          <box style={{ flexDirection: "column", flexGrow: 1 }}>
            <text style={{ fg: THEME.accent, marginBottom: 1 }}>
              Аудиодорожка:
            </text>
            <select
              options={audioItems}
              onSelect={(idx) => {
                const val = audioItems[idx].value;
                if (val === "keep") setStep("prompt");
                else if (val === "browse") setStep("audio_browse");
                else setStep("audio_manual");
              }}
              focused={true}
              {...selectStyles}
            />
          </box>
        );
      case "audio_browse":
        return (
          <FileBrowser
            folder={path.join(cwd, "music")}
            extensions={[".mp3", ".wav", ".aac", ".m4a"]}
            label="Выберите аудиофайл"
            onSelect={(p) => {
              set("audio", p);
              setStep("prompt");
            }}
            onManual={() => setStep("audio_manual")}
          />
        );
      case "audio_manual":
        return (
          <box style={{ flexDirection: "column" }}>
            <text style={{ fg: THEME.accent, marginBottom: 1 }}>
              Путь к аудио:
            </text>
            <input
              value={inputVal}
              placeholder={form.audio || "./track.mp3"}
              onInput={setInputVal}
              onSubmit={(v: any) => {
                const val = String(v).trim() || form.audio;
                if (!val) {
                  setError("Укажи файл");
                  return;
                }
                set("audio", val);
                setStep("prompt");
              }}
              focused={true}
              style={{ textColor: THEME.text }}
            />
          </box>
        );
      case "prompt":
        return (
          <box style={{ flexDirection: "column" }}>
            <text style={{ fg: THEME.accent, marginBottom: 1 }}>
              Промпт для монтажа:
            </text>
            <input
              value={inputVal}
              placeholder={form.prompt || "Эпичный ролик..."}
              onInput={setInputVal}
              onSubmit={(v: any) => {
                const val = String(v).trim() || form.prompt;
                if (!val) {
                  setError("Укажи промпт");
                  return;
                }
                set("prompt", val);
                setStep("duration");
              }}
              focused={true}
              style={{ textColor: THEME.text }}
            />
          </box>
        );
      case "duration":
        return (
          <box style={{ flexDirection: "column" }}>
            <text style={{ fg: THEME.accent, marginBottom: 1 }}>
              Длительность (сек):
            </text>
            <input
              value={inputVal}
              placeholder={form.duration}
              onInput={setInputVal}
              onSubmit={(v: any) => {
                set("duration", String(v).trim() || form.duration);
                setStep("lut_choice");
              }}
              focused={true}
              style={{ textColor: THEME.text }}
            />
          </box>
        );
      case "lut_choice":
        const lutItems = [
          {
            name: "Оставить текущий",
            description: form.lut ? path.basename(form.lut) : "без LUT",
            value: "keep",
          },
          {
            name: "◈ Из папки luts/",
            description: "Выбрать файл",
            value: "browse",
          },
          {
            name: "✕ Без LUT",
            description: "Отключить цветокор",
            value: "none",
          },
          {
            name: "✎ Ввести вручную",
            description: "Путь к .cube",
            value: "manual",
          },
        ];
        return (
          <box style={{ flexDirection: "column", flexGrow: 1 }}>
            <text style={{ fg: THEME.accent, marginBottom: 1 }}>
              LUT цветокоррекция:
            </text>
            <select
              options={lutItems}
              onSelect={(idx) => {
                const val = lutItems[idx].value;
                if (val === "keep") setStep("color_ref_choice");
                else if (val === "none") {
                  set("lut", "");
                  setStep("color_ref_choice");
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
            label="Выберите LUT файл"
            onSelect={(p) => {
              set("lut", p);
              setStep("color_ref_choice");
            }}
            onManual={() => setStep("lut_manual")}
            onNone={() => {
              set("lut", "");
              setStep("color_ref_choice");
            }}
          />
        );
      case "lut_manual":
        return (
          <box style={{ flexDirection: "column" }}>
            <text style={{ fg: THEME.accent, marginBottom: 1 }}>
              Путь к LUT (.cube):
            </text>
            <input
              value={inputVal}
              placeholder={form.lut || "./cinematic.cube"}
              onInput={setInputVal}
              onSubmit={(v: any) => {
                set("lut", String(v).trim() || form.lut);
                setStep("color_ref_choice");
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
            description: form.colorRef
              ? form.colorRef.startsWith("http")
                ? form.colorRef.slice(0, 50)
                : path.basename(form.colorRef)
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
                if (val === "keep") setStep("quality");
                else if (val === "none") {
                  set("colorRef", "");
                  setStep("quality");
                } else if (val === "youtube") setStep("color_ref_youtube");
                else if (val === "images") setStep("color_ref_images");
                else setStep("color_ref_local");
              }}
              focused={true}
              {...selectStyles}
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
              placeholder={form.colorRef || "./reference"}
              onInput={setInputVal}
              onSubmit={(v: any) => {
                const val = String(v).trim() || form.colorRef;
                if (!val) {
                  setError("Укажи папку");
                  return;
                }
                set("colorRef", val);
                setStep("quality");
              }}
              focused={true}
              style={{ textColor: THEME.text }}
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
              placeholder={form.colorRef || "https://youtube.com/watch?v=..."}
              onInput={setInputVal}
              onSubmit={(v: any) => {
                const val = String(v).trim() || form.colorRef;
                if (!val) {
                  setError("Укажи URL");
                  return;
                }
                set("colorRef", val);
                setStep("quality");
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
              set("colorRef", p);
              setStep("quality");
            }}
            onManual={() => setStep("color_ref_youtube")}
            onNone={() => {
              set("colorRef", "");
              setStep("quality");
            }}
          />
        );
      case "quality":
        return (
          <box style={{ flexDirection: "column", flexGrow: 1 }}>
            <text style={{ fg: THEME.accent, marginBottom: 1 }}>
              Качество рендера:
            </text>
            <select
              options={QUALITY_ITEMS}
              selectedIndex={Math.max(0, QUALITY_ITEMS.findIndex((q) => q.value === form.quality))}
              onSelect={(idx) => {
                set("quality", QUALITY_ITEMS[idx].value);
                setStep("orientation");
              }}
              focused={true}
              {...selectStyles}
            />
          </box>
        );
      case "orientation":
        const orientationItems = [
          { name: "⬛ Горизонтальное 16:9", description: "1920×1080 — YouTube, ПК", value: "horizontal" },
          { name: "▮ Вертикальное 9:16", description: "1080×1920 — Reels, TikTok, Shorts", value: "vertical" },
        ];
        return (
          <box style={{ flexDirection: "column", flexGrow: 1 }}>
            <text style={{ fg: THEME.accent, marginBottom: 1 }}>
              Формат видео:
            </text>
            <select
              options={orientationItems}
              selectedIndex={form.orientation === "vertical" ? 1 : 0}
              onSelect={(idx) => {
                set("orientation", orientationItems[idx].value);
                setStep("confirm");
              }}
              focused={true}
              {...selectStyles}
            />
          </box>
        );
      case "confirm":
        const confirmItems = [
          { name: "▶ Запустить", description: "Начать рендеринг", value: "go" },
          { name: "↩ Назад", description: "В главное меню", value: "back" },
        ];
        return (
          <box style={{ flexDirection: "column", flexGrow: 1 }}>
            <text style={{ fg: THEME.success, attributes: 1, marginBottom: 1 }}>
              Готово к запуску!
            </text>
            <select
              options={confirmItems}
              selectedIndex={0}
              onSelect={(idx) => {
                const val = confirmItems[idx].value;
                if (val === "back") {
                  onBack();
                  return;
                }
                onDone({
                  input: form.input,
                  audio: form.audio,
                  prompt: form.prompt,
                  duration: parseInt(form.duration, 10) || 60,
                  lut: form.lut,
                  model: form.model,
                  output: form.output,
                  bitrate: 0,
                  quality: form.quality,
                  orientation: form.orientation,
                  colorRef: form.colorRef || undefined,
                });
              }}
              focused={true}
              {...selectStyles}
            />
          </box>
        );
      default:
        return <text>Шаг {step} еще не реализован</text>;
    }
  };

  const leftColWidth = width - 32;
  const maxValLen = leftColWidth - 16;

  return (
    <box
      style={{
        flexDirection: "row",
        width: "100%",
        height: "100%",
        padding: 1,
        backgroundColor: THEME.background,
      }}
    >
      <box style={{ flexDirection: "column", flexGrow: 1, marginRight: 1 }}>
        <box
          style={{
            height: 9,
            borderStyle: "rounded",
            borderColor: THEME.border,
            paddingLeft: 1,
            paddingRight: 1,
            flexDirection: "column",
          }}
        >
          <text style={{ fg: THEME.text, attributes: 1 }}>
            {" "}
            PROJECT CONFIG{" "}
          </text>
          <box style={{ flexDirection: "column", marginTop: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <box style={{ width: 12 }}>
                <text style={{ fg: THEME.text }}>Video: </text>
              </box>
              <text style={{ fg: THEME.highlight }}>
                {truncate(form.input || "—", maxValLen)}
              </text>
            </box>
            <box style={{ flexDirection: "row" }}>
              <box style={{ width: 12 }}>
                <text style={{ fg: THEME.text }}>Audio: </text>
              </box>
              <text style={{ fg: THEME.highlight }}>
                {truncate(path.basename(form.audio) || "—", maxValLen)}
              </text>
            </box>
            <box style={{ flexDirection: "row" }}>
              <box style={{ width: 12 }}>
                <text style={{ fg: THEME.text }}>Duration: </text>
              </box>
              <text style={{ fg: THEME.highlight }}>
                {truncate(form.duration || "—", maxValLen)}s
              </text>
            </box>
            <box style={{ flexDirection: "row" }}>
              <box style={{ width: 12 }}>
                <text style={{ fg: THEME.text }}>Quality: </text>
              </box>
              <text style={{ fg: THEME.highlight }}>
                {truncate(form.quality || "—", maxValLen)}
              </text>
            </box>
            <box style={{ flexDirection: "row" }}>
              <box style={{ width: 12 }}>
                <text style={{ fg: THEME.text }}>Prompt: </text>
              </box>
              <text style={{ fg: THEME.highlight }}>
                {truncate(form.prompt || "—", maxValLen)}
              </text>
            </box>
          </box>
        </box>
        <box
          style={{
            flexGrow: 1,
            borderStyle: "rounded",
            borderColor: THEME.accent,
            paddingLeft: 1,
            paddingRight: 1,
            flexDirection: "column",
          }}
        >
          <text style={{ fg: THEME.text, attributes: 1 }}> DATA INPUT </text>
          <box style={{ marginTop: 1, flexGrow: 1, flexDirection: "column" }}>
            {renderInput()}
          </box>
          {error ? (
            <text style={{ fg: THEME.error, marginTop: 1 }}>✗ {error}</text>
          ) : null}
        </box>
        <box
          style={{
            height: 5,
            borderStyle: "rounded",
            borderColor: THEME.border,
            paddingLeft: 1,
            paddingRight: 1,
            flexDirection: "column",
          }}
        >
          <text style={{ fg: THEME.text, attributes: 1 }}> PROGRESS </text>
          <box style={{ marginTop: 1, flexGrow: 1, flexDirection: "row" }}>
            <text style={{ fg: THEME.accent }}>
              {"█".repeat(
                Math.round(
                  ((currentStepIdx + 1) / STEPS.length) * (leftColWidth - 20),
                ),
              )}
            </text>
            <text style={{ fg: THEME.border }}>
              {"░".repeat(
                Math.max(
                  0,
                  leftColWidth -
                    20 -
                    Math.round(
                      ((currentStepIdx + 1) / STEPS.length) *
                        (leftColWidth - 20),
                    ),
                ),
              )}
            </text>
            <text style={{ fg: THEME.text }}>
              {" "}
              {Math.round(((currentStepIdx + 1) / STEPS.length) * 100)}%
            </text>
          </box>
        </box>
      </box>
      <box
        style={{
          width: 40,
          borderStyle: "rounded",
          borderColor: THEME.border,
          paddingLeft: 1,
          paddingRight: 1,
          flexDirection: "column",
        }}
      >
        <text style={{ fg: THEME.dim, attributes: 1 }}> STEPS </text>
        <box style={{ flexDirection: "column", marginTop: 1, flexGrow: 1 }}>
          {STEP_LABELS.map((label, i) => (
            <box key={i} style={{ marginBottom: 1, flexDirection: "row" }}>
              <text
                style={{
                  fg:
                    i < currentStepIdx
                      ? THEME.success
                      : i === currentStepIdx
                        ? THEME.accent
                        : THEME.dim,
                  attributes: i === currentStepIdx ? 1 : 0,
                }}
              >
                {i < currentStepIdx ? "✓" : i === currentStepIdx ? "▸" : "·"}{" "}
                {label}
              </text>
            </box>
          ))}
        </box>
      </box>
    </box>
  );
};
