import React, { useState, useEffect, useRef } from "react";
import { useTerminalDimensions, useKeyboard } from "@opentui/react";
import { Config } from "../config";
import { THEME } from "./index";

export interface PipelineCB {
  stage(n: number, total: number, label: string): void;
  info(msg: string): void;
  log(msg: string): void;
  renderTick(segIdx: number, segPct: number, done: number, total: number): void;
  assemblyProgress(pct: number): void;
  done(outputPath: string): void;
  error(msg: string): void;
}

type StageStatus = "pending" | "active" | "done" | "error";

interface StageState {
  label: string;
  status: StageStatus;
  detail: string;
  progress: number;
  counter: string;
}

interface LogEntry {
  msg: string;
  startTime: number;
  duration?: number;
}

const truncate = (str: string, maxLen: number) => {
  if (str.length <= maxLen) return str;
  return "..." + str.slice(-(maxLen - 3));
};

const formatDuration = (ms: number) => {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

const ProgressBar = ({
  value,
  width,
  fg = THEME.accent,
}: {
  value: number;
  width: number;
  fg?: string;
}) => {
  const v = Math.max(0, Math.min(100, value));
  const barWidth = Math.max(2, width - 8);
  const filled = Math.round((v / 100) * barWidth);
  return (
    <box style={{ flexDirection: "row" }}>
      <text style={{ fg }}>{"█".repeat(filled)}</text>
      <text style={{ fg: THEME.border }}>
        {"░".repeat(Math.max(0, barWidth - filled))}
      </text>
      <text style={{ fg: THEME.text }}> {v.toFixed(0).padStart(3)}%</text>
    </box>
  );
};

interface Props {
  config: Config;
  run: (cb: PipelineCB) => Promise<void>;
  onDone: () => void;
  onError: (msg: string) => void;
}

export const PipelineView = ({ config, run, onDone, onError }: Props) => {
  const { width } = useTerminalDimensions();
  const scrollRef = useRef<any>(null);
  const [stages, setStages] = useState<StageState[]>([]);
  const [overallPct, setOverallPct] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const currentStageRef = useRef(0);
  const totalStagesRef = useRef(1);

  const addLog = (msg: string) => {
    const now = Date.now();
    setLogs((prev) => {
      const newLogs = [...prev];
      if (newLogs.length > 0) {
        const last = newLogs[newLogs.length - 1]!;
        if (!last.duration) last.duration = now - last.startTime;
      }
      return [...newLogs, { msg, startTime: now }];
    });
  };

  useKeyboard((key) => {
    if (
      errorMsg &&
      (key.name === "q" || key.name === "return" || key.name === "escape")
    )
      onError(errorMsg);
  });

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 99999;
  }, [logs]);

  useEffect(() => {
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = (...args: any[]) => {
      const m = args.map(String).join(" ").trim();
      if (m) addLog(m);
    };
    console.warn = (...args: any[]) => {
      const m = args.map(String).join(" ").trim();
      if (m) addLog(`! ${m}`);
    };

    const cb: PipelineCB = {
      stage(n, total, label) {
        currentStageRef.current = n;
        totalStagesRef.current = total;
        setStages((prev) => {
          let next =
            prev.length === 0
              ? Array.from({ length: total }, (_, i) => ({
                  label: i === n - 1 ? label : `Стадия ${i + 1}`,
                  status: "pending" as StageStatus,
                  detail: "",
                  progress: -1,
                  counter: "",
                }))
              : [...prev];
          return next.map((s, i) => {
            if (i < n - 1) return { ...s, status: "done" as StageStatus };
            if (i === n - 1)
              return { ...s, status: "active" as StageStatus, label };
            return s;
          });
        });
        addLog(`➜ Phase: ${label}`);
        const basePct = Math.round(((n - 1) / total) * 100);
        setOverallPct(basePct);
      },
      info(msg) {
        setStages((prev) =>
          prev.map((s) => (s.status === "active" ? { ...s, detail: msg } : s)),
        );
      },
      log(msg) {
        addLog(msg);
      },
      renderTick(segIdx, segPct, done, segTotal) {
        const stageProgress = Math.round((done / segTotal) * 100);
        setStages((prev) =>
          prev.map((s) =>
            s.status === "active"
              ? {
                  ...s,
                  progress: stageProgress,
                  counter: `${done}/${segTotal}`,
                }
              : s,
          ),
        );
        const n = currentStageRef.current;
        const total = totalStagesRef.current;
        const base = ((n - 1) / total) * 100;
        const contribution = (1 / total) * stageProgress;
        setOverallPct(Math.round(base + contribution));
      },
      assemblyProgress(pct) {
        setStages((prev) =>
          prev.map((s) =>
            s.status === "active"
              ? { ...s, progress: pct, counter: `${pct.toFixed(0)}%` }
              : s,
          ),
        );
        const n = currentStageRef.current;
        const total = totalStagesRef.current;
        const base = ((n - 1) / total) * 100;
        const contribution = (1 / total) * pct;
        setOverallPct(Math.round(base + contribution));
      },
      done(path) {
        setStages((prev) =>
          prev.map((s) => ({ ...s, status: "done", progress: 100 })),
        );
        setOverallPct(100);
        addLog(`✓ Success: ${path}`);
        console.log = origLog;
        console.warn = origWarn;
        setTimeout(onDone, 1500);
      },
      error(msg) {
        setStages((prev) =>
          prev.map((s) =>
            s.status === "active" ? { ...s, status: "error", detail: msg } : s,
          ),
        );
        addLog(`✗ Error: ${msg}`);
        setErrorMsg(msg);
      },
    };
    run(cb).catch((err) =>
      cb.error(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      console.log = origLog;
      console.warn = origWarn;
    };
  }, []);

  const leftColWidth = width - 37;
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
            height: 11,
            borderStyle: "rounded",
            borderColor: THEME.border,
            padding: 1,
            marginBottom: 1,
            flexDirection: "column",
          }}
        >
          <text style={{ fg: THEME.accent, attributes: 1 }}>
            {" "}
            PROJECT CONFIG{" "}
          </text>
          <box style={{ flexDirection: "column", marginTop: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <box style={{ width: 12 }}>
                <text style={{ fg: THEME.dim }}>Input: </text>
              </box>
              <text style={{ fg: THEME.highlight }}>
                {truncate(config.input, maxValLen)}
              </text>
            </box>
            <box style={{ flexDirection: "row" }}>
              <box style={{ width: 12 }}>
                <text style={{ fg: THEME.dim }}>Audio: </text>
              </box>
              <text style={{ fg: THEME.highlight }}>
                {truncate(config.audio, maxValLen)}
              </text>
            </box>
            <box style={{ flexDirection: "row" }}>
              <box style={{ width: 12 }}>
                <text style={{ fg: THEME.dim }}>Prompt: </text>
              </box>
              <text style={{ fg: THEME.highlight }}>
                {truncate(config.prompt, maxValLen)}
              </text>
            </box>
            <box style={{ flexDirection: "row", marginTop: 1 }}>
              <box style={{ width: 12 }}>
                <text style={{ fg: THEME.dim }}>Duration: </text>
              </box>
              <box style={{ width: 10 }}>
                <text style={{ fg: THEME.highlight }}>{config.duration}s</text>
              </box>
              <box style={{ width: 12, marginLeft: 2 }}>
                <text style={{ fg: THEME.dim }}>Quality: </text>
              </box>
              <text style={{ fg: THEME.highlight }}>{config.quality}</text>
            </box>
          </box>
        </box>
        <box
          style={{
            flexGrow: 1,
            borderStyle: "rounded",
            borderColor: errorMsg ? THEME.error : THEME.accent,
            padding: 1,
            marginBottom: 1,
            flexDirection: "column",
          }}
        >
          <text
            style={{ fg: errorMsg ? THEME.error : THEME.text, attributes: 1 }}
          >
            {" "}
            {errorMsg ? "FATAL ERROR (Press Q to exit)" : "ACTIVITY LOG"}{" "}
          </text>
          <box style={{ flexGrow: 1, marginTop: 1, flexDirection: "column" }}>
            <scrollbox
              ref={scrollRef}
              style={{ width: "100%", height: "100%" }}
              scrollY={true}
              stickyScroll={true}
              stickyStart="bottom"
            >
              {logs.map((log, i) => (
                <box
                  key={i}
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    width: "100%",
                  }}
                >
                  <text
                    style={{
                      fg: log.msg.startsWith("➜")
                        ? THEME.accent
                        : log.msg.startsWith("✓")
                          ? THEME.success
                          : log.msg.startsWith("✗")
                            ? THEME.error
                            : THEME.dim,
                      flexGrow: 1,
                    }}
                  >
                    {log.msg}
                  </text>
                  {log.duration ? (
                    <box style={{ marginRight: 1 }}>
                      <text style={{ fg: THEME.border }}>
                        {formatDuration(log.duration)}
                      </text>
                    </box>
                  ) : null}
                </box>
              ))}
            </scrollbox>
          </box>
        </box>
        <box
          style={{
            height: 5,
            borderStyle: "rounded",
            borderColor: THEME.border,
            padding: 1,
            flexDirection: "column",
          }}
        >
          <text style={{ fg: THEME.dim, attributes: 1 }}>
            {" "}
            OVERALL PROGRESS{" "}
          </text>
          <box style={{ marginTop: 1, flexGrow: 1 }}>
            <ProgressBar value={overallPct} width={leftColWidth - 4} />
          </box>
        </box>
      </box>
      <box
        style={{
          width: 35,
          borderStyle: "rounded",
          borderColor: THEME.border,
          padding: 1,
          flexDirection: "column",
        }}
      >
        <text style={{ fg: THEME.dim, attributes: 1 }}> PIPELINE </text>
        <box style={{ flexDirection: "column", marginTop: 1, flexGrow: 1 }}>
          {stages.map((s, i) => (
            <box key={i} style={{ marginBottom: 1, flexDirection: "column" }}>
              <box
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                }}
              >
                <text
                  style={{
                    fg:
                      s.status === "done"
                        ? THEME.success
                        : s.status === "active"
                          ? THEME.accent
                          : s.status === "error"
                            ? THEME.error
                            : THEME.dim,
                    attributes: s.status === "active" ? 1 : 0,
                  }}
                >
                  {s.status === "done"
                    ? "✓"
                    : s.status === "active"
                      ? "▸"
                      : s.status === "error"
                        ? "✗"
                        : "·"}{" "}
                  {s.label}
                </text>
                {s.status === "done" ? (
                  <text style={{ fg: THEME.success }}>done</text>
                ) : null}
              </box>
              {s.detail ? (
                <text style={{ fg: THEME.border, marginLeft: 2 }}>
                  {truncate(s.detail, 30)}
                </text>
              ) : null}
              {s.status === "active" && s.progress >= 0 ? (
                <box style={{ marginLeft: 2, marginTop: 0 }}>
                  <ProgressBar
                    value={s.progress}
                    width={28}
                    fg={THEME.highlight}
                  />
                </box>
              ) : null}
            </box>
          ))}
        </box>
      </box>
    </box>
  );
};
