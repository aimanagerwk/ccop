"use client";

import { useState } from "react";
import { rpc } from "../lib/client";

export function StartForm(props: { enabled: boolean; onStarted: (id: string) => void }) {
  const [cwd, setCwd] = useState("/workspace/hello-cc");
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    setErr("");
    const res = await rpc("start", {
      cwd,
      prompt,
      name: name || undefined,
      permission_mode: "auto",
    });
    setBusy(false);
    if (!res.ok) {
      setErr(String(res.error || "start failed"));
      return;
    }
    props.onStarted(String(res.id));
    setPrompt("");
  }

  return (
    <div>
      <h2>start</h2>
      <label>cwd</label>
      <input value={cwd} onChange={(e) => setCwd(e.target.value)} disabled={!props.enabled} />
      <label>name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} disabled={!props.enabled} />
      <label>prompt</label>
      <textarea
        rows={3}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={!props.enabled}
      />
      <div style={{ marginTop: 6 }}>
        <button className="primary" disabled={!props.enabled || busy || !prompt} onClick={() => void start()}>
          Start
        </button>
      </div>
      {err ? <div className="err">{err}</div> : null}
    </div>
  );
}
