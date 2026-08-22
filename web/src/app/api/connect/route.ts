import { NextResponse } from "next/server";
import { getHub } from "../../../lib/bridge-singleton";
import { serverKey } from "../../../lib/depot-store";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token : "";
  if (!token) return NextResponse.json({ ok: false, error: "token required" }, { status: 400 });
  const host = typeof body.host === "string" && body.host ? body.host : "127.0.0.1";
  const port = typeof body.port === "number" ? body.port : Number(body.port || 8787);
  if (!Number.isFinite(port)) {
    return NextResponse.json({ ok: false, error: "bad port" }, { status: 400 });
  }
  const id =
    typeof body.id === "string" && body.id.trim()
      ? body.id.trim()
      : serverKey(host, port);
  const res = await getHub().connect(id, { token, host, port });
  if (!res.ok) return NextResponse.json(res, { status: 502 });
  return NextResponse.json({ ok: true, ping: res.ping, id });
}
