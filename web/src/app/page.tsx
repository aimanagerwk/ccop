"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectForm } from "../components/ConnectForm";
import { Composer } from "../components/Composer";
import { PendingBar } from "../components/PendingBar";
import { SessionList } from "../components/SessionList";
import { StartForm } from "../components/StartForm";
import { Toasts, type ToastItem } from "../components/Toasts";
import { Transcript } from "../components/Transcript";
import { rpc } from "../lib/client";
import type { ClassifiedEvent, SessionRow } from "../lib/protocol";
import { toastPriority } from "../lib/protocol";

function asSessions(raw: unknown): SessionRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s) => s && typeof s === "object" && typeof (s as SessionRow).id === "string") as SessionRow[];
}

function asEvents(raw: unknown): ClassifiedEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e) => e && typeof e === "object") as ClassifiedEvent[];
}

export default function Page() {
  const [connected, setConnected] = useState(false);
  const [target, setTarget] = useState<{ host: string; port: number } | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<ClassifiedEvent[]>([]);
  const [badges, setBadges] = useState<Record<string, number>>({});
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const selectedRef = useRef<string | null>(null);
  const toastN = useRef(0);
  selectedRef.current = selected;

  const refreshStatus = useCallback(async () => {
    const res = await rpc("status");
    if (!res.ok) return;
    setSessions(asSessions(res.sessions));
  }, []);

  const loadEvents = useCallback(async (id: string) => {
    const res = await rpc("events", { id, tail: 200 });
    if (!res.ok) return;
    setEvents(asEvents(res.events));
  }, []);

  const onSelect = useCallback(
    (id: string) => {
      setSelected(id);
      setBadges((b) => {
        const next = { ...b };
        delete next[id];
        return next;
      });
      void loadEvents(id);
    },
    [loadEvents],
  );

  const onConnected = useCallback(async () => {
    const h = await fetch("/api/health").then((r) => r.json());
    setConnected(Boolean(h.connected));
    setTarget(h.target ?? null);
    await refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    void fetch("/api/health")
      .then((r) => r.json())
      .then((h) => {
        setConnected(Boolean(h.connected));
        setTarget(h.target ?? null);
        if (h.connected) void refreshStatus();
      });
  }, [refreshStatus]);

  useEffect(() => {
    if (!connected) return;
    const t = setInterval(() => void refreshStatus(), 3000);
    return () => clearInterval(t);
  }, [connected, refreshStatus]);

  useEffect(() => {
    if (!connected) return;
    const es = new EventSource("/api/events");
    es.onmessage = (ev) => {
      let msg: { type?: string; id?: string; event?: ClassifiedEvent };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type !== "event" || !msg.id || !msg.event) return;
      const rec = { ...msg.event, id: msg.event.id || msg.id };
      const kind = String(rec.kind || "");
      const pri = toastPriority(kind);
      if (pri === "interrupt") {
        toastN.current += 1;
        const key = `t${toastN.current}`;
        setToasts((xs) => [...xs, { key, id: msg.id!, kind, summary: String(rec.summary || "") }]);
      }
      if (selectedRef.current !== msg.id && (pri === "interrupt" || pri === "badge")) {
        setBadges((b) => ({ ...b, [msg.id!]: (b[msg.id!] || 0) + 1 }));
      }
      if (selectedRef.current === msg.id) {
        setEvents((xs) => [...xs, rec as ClassifiedEvent]);
      }
      void refreshStatus();
    };
    return () => es.close();
  }, [connected, refreshStatus]);

  const current = sessions.find((s) => s.id === selected) || null;

  return (
    <div className="app">
      <div className="top">
        <ConnectForm connected={connected} target={target} onConnected={() => void onConnected()} />
      </div>
      <div className="side">
        <SessionList sessions={sessions} selected={selected} badges={badges} onSelect={onSelect} />
        <StartForm
          enabled={connected}
          onStarted={(id) => {
            void refreshStatus();
            onSelect(id);
          }}
        />
      </div>
      <div className="main">
        {current ? (
          <PendingBar id={current.id} pending={current.pending || []} onDone={() => void refreshStatus()} />
        ) : null}
        <Transcript events={events} />
        <Composer id={selected} held={current?.lock === "operator"} enabled={connected && Boolean(current?.alive)} />
      </div>
      <Toasts items={toasts} onDismiss={(k) => setToasts((xs) => xs.filter((t) => t.key !== k))} />
    </div>
  );
}
