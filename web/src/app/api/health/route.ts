import { NextResponse } from "next/server";
import { getBridge } from "../../../lib/bridge-singleton";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const bridge = getBridge();
  const t = bridge.getTarget();
  return NextResponse.json({
    ok: true,
    connected: bridge.isConnected(),
    target: t ? { host: t.host, port: t.port } : null,
  });
}
