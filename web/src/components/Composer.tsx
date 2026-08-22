"use client";

import { useRef, useState } from "react";
import { rpc } from "../lib/client";
import { composeAttachMessage, uploadTempNote } from "../lib/upload-message";

export function Composer(props: {
  id: string | null;
  serverId: string | null;
  held: boolean;
  enabled: boolean;
}) {
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function send() {
    if (!props.id) return;
    setErr("");
    const res = await rpc("send", { id: props.id, text }, props.serverId || undefined);
    if (!res.ok) {
      setErr(String(res.error || "发送失败"));
      return;
    }
    setText("");
  }

  async function upload(file: File) {
    if (!props.id || !props.serverId) return;
    setErr("");
    setNote("");
    setBusy(true);
    const fd = new FormData();
    fd.set("file", file);
    fd.set("sessionId", props.id);
    fd.set("serverId", props.serverId);
    const r = await fetch("/api/upload", { method: "POST", body: fd });
    const res = (await r.json()) as { ok?: boolean; error?: string; path?: string };
    if (!res.ok || !res.path) {
      setBusy(false);
      setErr(String(res.error || "上传失败"));
      return;
    }
    const payload = composeAttachMessage(text, res.path);
    const sent = await rpc("send", { id: props.id, text: payload }, props.serverId);
    setBusy(false);
    if (!sent.ok) {
      setErr(String(sent.error || "已落盘但通知失败"));
      return;
    }
    setNote(uploadTempNote(res.path));
    setText("");
    if (fileRef.current) fileRef.current.value = "";
  }

  const blocked = !props.enabled || !props.id || props.held || !text || busy;
  return (
    <div className="bottom">
      {props.held ? <div className="err">已挂起 — 不能发送</div> : null}
      {note ? <div className="ok tiny">{note}</div> : null}
      <div className="row">
        <label className="filebtn">
          <span>夹文件</span>
          <input
            ref={fileRef}
            type="file"
            disabled={!props.enabled || !props.id || props.held || busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
        </label>
        <textarea
          className="grow"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!props.enabled || !props.id || props.held}
          placeholder="对这一路说…"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !blocked) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="primary" disabled={blocked} onClick={() => void send()}>
          {busy ? "…" : "发送"}
        </button>
      </div>
      {err ? <div className="err">{err}</div> : null}
    </div>
  );
}
