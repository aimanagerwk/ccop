"use client";

import { useState } from "react";
import { rpc } from "../lib/client";

export function Composer(props: { id: string | null; held: boolean; enabled: boolean }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState("");

  async function send() {
    if (!props.id) return;
    setErr("");
    const res = await rpc("send", { id: props.id, text });
    if (!res.ok) {
      setErr(String(res.error || "send failed"));
      return;
    }
    setText("");
  }

  const blocked = !props.enabled || !props.id || props.held || !text;
  return (
    <div className="bottom">
      {props.held ? <div className="err">held — send blocked</div> : null}
      <div className="row">
        <textarea
          className="grow"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!props.enabled || !props.id || props.held}
        />
        <button className="primary" disabled={blocked} onClick={() => void send()}>
          Send
        </button>
      </div>
      {err ? <div className="err">{err}</div> : null}
    </div>
  );
}
