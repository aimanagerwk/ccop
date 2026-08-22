"use client";

import { useState } from "react";
import { postJson } from "../lib/client";

export function ConnectForm(props: {
  connected: boolean;
  target: { host: string; port: number } | null;
  onConnected: () => void;
}) {
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("8787");
  const [token, setToken] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true);
    setErr("");
    const res = await postJson("/api/connect", { host, port: Number(port), token });
    setBusy(false);
    if (!res.ok) {
      setErr(String(res.error || "connect failed"));
      return;
    }
    setToken("");
    props.onConnected();
  }

  return (
    <div>
      <h1>ccop web</h1>
      <div className="row">
        <div>
          <label>host</label>
          <input value={host} onChange={(e) => setHost(e.target.value)} />
        </div>
        <div>
          <label>port</label>
          <input value={port} onChange={(e) => setPort(e.target.value)} style={{ width: 80 }} />
        </div>
        <div className="grow">
          <label>token</label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="CCOP_TOKEN"
          />
        </div>
        <button className="primary" disabled={busy} onClick={() => void connect()}>
          {busy ? "…" : "Connect"}
        </button>
        <div>
          {props.connected ? (
            <span className="ok">
              connected {props.target ? `${props.target.host}:${props.target.port}` : ""}
            </span>
          ) : (
            <span className="err">disconnected</span>
          )}
        </div>
      </div>
      {err ? <div className="err">{err}</div> : null}
    </div>
  );
}
