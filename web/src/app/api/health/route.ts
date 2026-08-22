import { NextResponse } from "next/server";
import { getHub } from "../../../lib/bridge-singleton";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const hub = getHub();
  const rows = hub.list();
  const activeId = hub.primaryConnectedId();
  const active = rows.find((r) => r.id === activeId);
  return NextResponse.json({
    ok: true,
    connected: hub.anyConnected(),
    target: active && active.host ? { host: active.host, port: active.port } : null,
    activeId,
    servers: rows,
  });
}
