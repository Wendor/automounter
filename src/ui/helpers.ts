import * as fs from "fs";
import * as path from "path";

export function scanFiles(folder: string, extensions: string[]): string[] {
  if (!fs.existsSync(folder)) return [];
  const results: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (extensions.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
        results.push(full);
      }
    }
  };
  walk(folder);
  return results.sort();
}

export function formatSize(bytes: number): string {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + " MB";
  return (bytes / 1e3).toFixed(0) + " KB";
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `~${m} мин ${s} сек` : `~${s} сек`;
}

export interface FolderStats {
  total: number;
  cached: number;
  totalBytes: number;
}

export function getFolderStats(folder: string): FolderStats {
  if (!fs.existsSync(folder)) return { total: 0, cached: 0, totalBytes: 0 };
  const files = fs
    .readdirSync(folder)
    .filter((f) => /\.(mp4|mov)$/i.test(f) && !f.startsWith("."));
  let totalBytes = 0;
  let cached = 0;
  for (const f of files) {
    const fp = path.join(folder, f);
    totalBytes += fs.statSync(fp).size;
    if (fs.existsSync(`${fp}.json`)) cached++;
  }
  return { total: files.length, cached, totalBytes };
}
