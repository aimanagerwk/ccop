/** Resolve a write target that stays under a given root (never the session cwd). */

import path from "node:path";

const MAX_NAME = 180;

export const UPLOAD_TMP_ROOT = "/tmp/ccop-uploads";

export function safeBasename(name: string): string | null {
  const base = path.basename(name.replaceAll("\\", "/")).trim();
  if (!base || base === "." || base === "..") return null;
  if (base.includes("\0")) return null;
  if (base.length > MAX_NAME) return null;
  return base;
}

export function safeSessionSegment(sessionId: string): string | null {
  const id = sessionId.trim();
  if (!id || id === "." || id === "..") return null;
  if (id.includes("\0") || id.includes("/") || id.includes("\\") || id.includes("..")) return null;
  if (id.length > MAX_NAME) return null;
  return id;
}

/** Absolute dest under root, or null if it would escape. */
export function resolveUnderRoot(rootDir: string, filename: string): string | null {
  if (!rootDir || !path.isAbsolute(rootDir)) return null;
  const base = safeBasename(filename);
  if (!base) return null;
  const root = path.resolve(rootDir);
  const dest = path.resolve(root, base);
  const rel = path.relative(root, dest);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return dest;
}

/** Temp dest: /tmp/ccop-uploads/<sessionId>/<basename>. Never uses session cwd. */
export function resolveTempUpload(sessionId: string, filename: string): string | null {
  const id = safeSessionSegment(sessionId);
  if (!id) return null;
  return resolveUnderRoot(path.join(UPLOAD_TMP_ROOT, id), filename);
}

/** @deprecated session cwd must not be an upload dest. */
export function resolveUnderCwd(cwd: string, filename: string): string | null {
  return resolveUnderRoot(cwd, filename);
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
