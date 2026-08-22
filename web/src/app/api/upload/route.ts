import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getHub } from "../../../lib/bridge-singleton";
import { resolveTempUpload, uniqueDest } from "../../../lib/safe-path";
import type { SessionRow } from "../../../lib/protocol";

export const dynamic = "force-dynamic";

const MAX = 32 * 1024 * 1024;

function asSessions(raw: unknown): SessionRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s) => s && typeof s === "object" && typeof (s as SessionRow).id === "string") as SessionRow[];
}

export async function POST(req: Request): Promise<Response> {
  const hub = getHub();
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "bad form" }, { status: 400 });
  }
  const file = form.get("file");
  const sessionId = typeof form.get("sessionId") === "string" ? String(form.get("sessionId")) : "";
  const serverId = typeof form.get("serverId") === "string" ? String(form.get("serverId")) : "";
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "file required" }, { status: 400 });
  }
  if (!sessionId) {
    return NextResponse.json({ ok: false, error: "sessionId required" }, { status: 400 });
  }
  if (file.size > MAX) {
    return NextResponse.json({ ok: false, error: "file too large" }, { status: 413 });
  }
  const bridge = hub.pick(serverId || undefined);
  if (!bridge || !bridge.isConnected()) {
    return NextResponse.json({ ok: false, error: "not connected" }, { status: 503 });
  }
  let status: Record<string, unknown>;
  try {
    status = await bridge.rpc({ cmd: "status" });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error }, { status: 502 });
  }
  const row = asSessions(status.sessions).find((s) => s.id === sessionId);
  if (!row) return NextResponse.json({ ok: false, error: "session not found" }, { status: 404 });
  const dest0 = resolveTempUpload(sessionId, file.name || "upload.bin");
  if (!dest0) {
    return NextResponse.json({ ok: false, error: "path rejected" }, { status: 400 });
  }
  const dest = uniqueDest(dest0, existsSync);
  try {
    await mkdir(path.dirname(dest), { recursive: true });
    const buf = Buffer.from(await file.arrayBuffer());
    await writeFile(dest, buf);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, path: dest });
}
