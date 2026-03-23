import * as fs from "fs";

/**
 * Удаляет JSON-обёртки markdown из ответов LLM.
 * Используется в director.ts и indexer.ts.
 */
export function cleanJSONString(rawStr: string): string {
  const mdMatch = rawStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (mdMatch) return mdMatch[1] ?? rawStr;
  const objMatch = rawStr.match(/\{[\s\S]*\}/);
  if (objMatch) return objMatch[0];
  return rawStr;
}

/**
 * Форматирует путь к LUT-файлу для использования в FFmpeg-фильтрах.
 * Используется в render.ts и color_grading.ts.
 */
export function formatLutPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^([a-zA-Z]):/, "$1\\:");
}

/**
 * Безопасно удаляет файл, если он существует.
 * Не выбрасывает исключений.
 */
export function safeDelete(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}
