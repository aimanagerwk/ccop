import { NextResponse } from "next/server";
import { getHub } from "../../../lib/bridge-singleton";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const hub = getHub();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const serverId = typeof body.serverId === "string" ? body.serverId : undefined;
  const { serverId: _drop, ...rest } = body;
  void _drop;
  const bridge = hub.pick(serverId);
  if (!bridge || !bridge.isConnected()) {
    return NextResponse.json({ ok: false, error: "not connected" }, { status: 503 });
  }
  try {
    const res = await bridge.rpc(rest);
    return NextResponse.json(res, { status: res.ok ? 200 : 400 });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error }, { status: 502 });
  }
}
