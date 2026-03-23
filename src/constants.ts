// ─── Ollama ───────────────────────────────────────────────────────────────────
export const OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_VISION_MODEL = "llava:13b";
export const DEFAULT_TEXT_MODEL = "qwen3-coder:latest";

// ─── Nominatim ────────────────────────────────────────────────────────────────
export const NOMINATIM_URL = "https://nominatim.openstreetmap.org";
export const NOMINATIM_USER_AGENT = "automounter-video-editor/1.0";
export const NOMINATIM_RATE_LIMIT_MS = 1100;

// ─── Cache ────────────────────────────────────────────────────────────────────
export const CACHE_VERSION = 8;

// ─── Color grading ────────────────────────────────────────────────────────────
export const EVAL_RES = 512;
export const CHROMA_WEIGHT = 0.85;
export const CURVE_SAMPLES = [0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 255];

// ─── Video ────────────────────────────────────────────────────────────────────
export const BASE_WIDTH = 1920;
export const BASE_HEIGHT = 1080;
export const VERTICAL_WIDTH = 1080;
export const VERTICAL_HEIGHT = 1920;
export const ZOOM_PERCENT = 8; // 8% increase → ~154px при 1920
export const ZOOM_DELTA = Math.round(BASE_WIDTH * ZOOM_PERCENT / 100); // 154

// ─── Director ─────────────────────────────────────────────────────────────────
export const PREFILTER_KM = 300;
export const ON_LOCATION_KM = 50;
export const LLM_TIMEOUT_MS = 290_000;
export const LLM_KEEP_ALIVE = "20m";

// ─── Audio ────────────────────────────────────────────────────────────────────
export const TRANSIENT_WINDOW_SEC = 0.05;
export const ENERGY_WINDOW_SEC = 2.0;
export const TRANSIENT_THRESHOLD = 0.25;
export const DROP_HIGH_THRESHOLD = 0.75;
export const DROP_LOW_THRESHOLD = 0.4;
