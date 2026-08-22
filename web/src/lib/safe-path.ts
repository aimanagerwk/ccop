/** Resolve a write target that must stay under session cwd. */

import path from "node:path";

const MAX_NAME = 180;

export function safeBasename(name: string): string | null {
  const base = path.basename(name.replaceAll("\\", "/")).trim();
  if (!base || base === "." || base === "..") return null;
  if (base.includes("\0")) return null;
  if (base.length > MAX_NAME) return null;
  return base;
}

/** Absolute dest under root, or null if it would escape. */
export function resolveUnderCwd(cwd: string, filename: string): string | null {
  if (!cwd || !path.isAbsolute(cwd)) return null;
  const base = safeBasename(filename);
  if (!base) return null;
  const root = path.resolve(cwd);
  const dest = path.resolve(root, base);
  const rel = path.relative(root, dest);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return dest;
}

export function uniqueDest(dest: string, exists: (p: string) => boolean): string {
  if (!exists(dest)) return dest;
  const ext = path.extname(dest);
  const stem = dest.slice(0, dest.length - ext.length);
  for (let i = 2; i < 1000; i += 1) {
    const cand = `${stem}-${i}${ext}`;
    if (!exists(cand)) return cand;
  }
  return dest;
}
