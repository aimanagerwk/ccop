import { NextResponse } from "next/server";
import { getBridge } from "../../../lib/bridge-singleton";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const bridge = getBridge();
  if (!bridge.isConnected()) {
    return NextResponse.json({ ok: false, error: "not connected" }, { status: 503 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  try {
    const res = await bridge.rpc(body);
    return NextResponse.json(res, { status: res.ok ? 200 : 400 });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error }, { status: 502 });
  }
}
