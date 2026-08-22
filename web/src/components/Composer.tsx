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
      setErr(String(sent.error || "文件已保存，但通知会话失败"));
      return;
    }
    setNote(uploadTempNote(res.path));
    setText("");
    if (fileRef.current) fileRef.current.value = "";
  }

  const blocked = !props.enabled || !props.id || props.held || !text || busy;
  return (
    <div className="bottom">
      {props.held ? <div className="err">已挂起，无法发送</div> : null}
      {note ? <div className="ok tiny">{note}</div> : null}
      <div className="composer">
        <label className="iconbtn" title="附加文件">
          <span aria-hidden>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M10.2 3.6 4.55 9.25a2.3 2.3 0 1 0 3.25 3.25l5.3-5.3a1.6 1.6 0 0 0-2.26-2.26l-5.3 5.3"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span className="sr-only">附加文件</span>
          <input
            ref={fileRef}
            type="file"
            aria-label="附加文件"
            disabled={!props.enabled || !props.id || props.held || busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
        </label>
        <textarea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!props.enabled || !props.id || props.held}
          placeholder="给这个会话发消息…"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !blocked) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="send" disabled={blocked} onClick={() => void send()}>
          {busy ? "…" : "发送"}
        </button>
      </div>
      {err ? <div className="err">{err}</div> : null}
    </div>
  );
}
