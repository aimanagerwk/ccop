/** sessions.json (keyed by id) + events/<id>.jsonl. Files the assistant Reads. */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { EVENTS, SESSIONS_PATH, ensureData } from "./paths.js";

export type SessionRef = { id: string; name?: string; title?: string };

export type ResolveOk = { ok: true; id: string };
export type ResolveFail = { ok: false; error: string; ids?: string[] };
export type ResolveResult = ResolveOk | ResolveFail;

/** Prefer exact Claude session UUID. Else unique operator label or Claude title (MAY). */
export function resolveSessionId(key: string | undefined, sessions: SessionRef[]): ResolveResult {
  if (!key) return { ok: false, error: "id required" };
  if (sessions.some((s) => s.id === key)) return { ok: true, id: key };
  const byLabel = sessions.filter((s) => s.name && s.name === key);
  if (byLabel.length === 1) return { ok: true, id: byLabel[0].id };
  if (byLabel.length > 1) return { ok: false, error: "ambiguous name", ids: byLabel.map((s) => s.id) };
  const byTitle = sessions.filter((s) => s.title && s.title === key);
  if (byTitle.length === 1) return { ok: true, id: byTitle[0].id };
  if (byTitle.length > 1) return { ok: false, error: "ambiguous name", ids: byTitle.map((s) => s.id) };
  return { ok: false, error: `unknown session ${key}` };
}

function lockPath(path: string): string {
  return `${path}.lock`;
}

function withLock<T>(path: string, fn: () => T): T {
  ensureData();
  mkdirSync(dirname(path), { recursive: true });
  const lp = lockPath(path);
  const deadline = Date.now() + 5000;
  let fd: number | undefined;
  while (Date.now() < deadline) {
    try {
      fd = openSync(lp, "wx");
      break;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  if (fd === undefined) fd = openSync(lp, "w");
  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(lp);
    } catch {
      /* ignore */
    }
  }
}

export function loadSessions(): { sessions: Record<string, Record<string, unknown>> } {
  ensureData();
  if (!existsSync(SESSIONS_PATH)) return { sessions: {} };
  try {
    return JSON.parse(readFileSync(SESSIONS_PATH, "utf8") || '{"sessions":{}}');
  } catch {
    return { sessions: {} };
  }
}

export function upsertSession(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return withLock(SESSIONS_PATH, () => {
    let data: { sessions: Record<string, Record<string, unknown>> };
    try {
      data = existsSync(SESSIONS_PATH)
        ? JSON.parse(readFileSync(SESSIONS_PATH, "utf8") || '{"sessions":{}}')
        : { sessions: {} };
    } catch {
      data = { sessions: {} };
    }
    if (!data.sessions) data.sessions = {};
    const sess = data.sessions[id] || { id };
    Object.assign(sess, fields);
    sess.id = id;
    sess.updated_ts = Date.now() / 1000;
    data.sessions[id] = sess;
    writeFileSync(SESSIONS_PATH, JSON.stringify(data, null, 2) + "\n");
    return { ...sess };
  });
}

export function listSessions(): Record<string, unknown>[] {
  const data = loadSessions();
  const out: Record<string, unknown>[] = [];
  for (const [key, rec] of Object.entries(data.sessions || {})) {
    const row = { ...rec };
    if (row.id == null) row.id = key;
    out.push(row);
  }
  return out;
}

export function appendEvent(
  id: string,
  kind: string,
  summary: string,
  extra?: Record<string, unknown> | null,
  name?: string,
): Record<string, unknown> {
  ensureData();
  const ev = {
    ts: Date.now() / 1000,
    id,
    name: name ?? "",
    kind,
    summary,
    extra: extra || {},
  };
  const path = join(EVENTS, `${id}.jsonl`);
  appendFileSync(path, JSON.stringify(ev) + "\n");
  const patch: Record<string, unknown> = { state: kind, last_kind: kind };
  const rec = { kind, ts: ev.ts, summary };
  if (kind === "turn_done") patch.last_turn = rec;
  else if (kind === "task_done") patch.last_task = rec;
  else if (kind === "failed") patch.last_error = rec;
  upsertSession(id, patch);
  return ev;
}

export function readEvents(id: string, tail?: number | null): Record<string, unknown>[] {
  const path = join(EVENTS, `${id}.jsonl`);
  if (!existsSync(path)) return [];
  let lines = readFileSync(path, "utf8").split("\n");
  if (tail != null) lines = lines.slice(-Number(tail));
  const out: Record<string, unknown>[] = [];
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return out;
}
