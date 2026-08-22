"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Composer } from "../components/Composer";
import { PathTree, type TreeSel } from "../components/PathTree";
import { PendingBar } from "../components/PendingBar";
import { Toasts, type ToastItem } from "../components/Toasts";
import { Transcript } from "../components/Transcript";
import { fetchHealth, postJson, rpc } from "../lib/client";
import {
  emptyDepot,
  loadDepot,
  pinCwd,
  saveDepot,
  serverKey,
  type DepotServer,
  type DepotState,
} from "../lib/depot-store";
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
  const [depot, setDepot] = useState<DepotState>(emptyDepot);
  const [live, setLive] = useState<Record<string, boolean>>({});
  const [sessionsByServer, setSessionsByServer] = useState<Record<string, SessionRow[]>>({});
  const [sel, setSel] = useState<TreeSel>({ serverId: null, cwd: null, sessionId: null });
  const [events, setEvents] = useState<ClassifiedEvent[]>([]);
  const [badges, setBadges] = useState<Record<string, number>>({});
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const selRef = useRef(sel);
  const toastN = useRef(0);
  selRef.current = sel;

  const persist = useCallback((next: DepotState) => {
    setDepot(next);
    saveDepot(next);
  }, []);

  const refreshOne = useCallback(async (serverId: string) => {
    const res = await rpc("status", {}, serverId);
    if (!res.ok) return;
    setSessionsByServer((m) => ({ ...m, [serverId]: asSessions(res.sessions) }));
  }, []);

  const refreshAll = useCallback(async () => {
    const h = await fetchHealth();
    const liveMap: Record<string, boolean> = {};
    for (const s of h.servers) liveMap[s.id] = s.connected;
    setLive(liveMap);
    await Promise.all(h.servers.filter((s) => s.connected).map((s) => refreshOne(s.id)));
  }, [refreshOne]);

  const loadEvents = useCallback(async (serverId: string, id: string) => {
    const res = await rpc("events", { id, tail: 200 }, serverId);
    if (!res.ok) return;
    setEvents(asEvents(res.events));
  }, []);

  const onSelectSession = useCallback(
    (serverId: string, cwd: string | undefined, id: string) => {
      setSel({ serverId, cwd: cwd || null, sessionId: id });
      setBadges((b) => {
        const next = { ...b };
        delete next[id];
        return next;
      });
      void loadEvents(serverId, id);
    },
    [loadEvents],
  );

  const connectServer = useCallback(
    async (s: DepotServer) => {
      const res = await postJson("/api/connect", {
        id: s.id,
        host: s.host,
        port: s.port,
        token: s.token,
      });
      if (!res.ok) return String(res.error || "连接失败");
      setLive((m) => ({ ...m, [s.id]: true }));
      await refreshOne(s.id);
      return "";
    },
    [refreshOne],
  );

  useEffect(() => {
    const stored = loadDepot();
    setDepot(stored);
    void (async () => {
      const h = await fetchHealth();
      const liveMap: Record<string, boolean> = {};
      for (const s of h.servers) liveMap[s.id] = s.connected;
      setLive(liveMap);
      let next = stored;
      if (h.target && !next.servers.some((s) => s.host === h.target!.host && s.port === h.target!.port)) {
        const id = h.activeId || serverKey(h.target.host, h.target.port);
        next = {
          ...next,
          servers: [
            ...next.servers,
            { id, label: "本机", host: h.target.host, port: h.target.port, token: "" },
          ],
        };
        persist(next);
      }
      if (h.connected) {
        await Promise.all(h.servers.filter((s) => s.connected).map((s) => refreshOne(s.id)));
      }
      for (const s of next.servers) {
        if (s.token && !liveMap[s.id]) void connectServer(s);
      }
    })();
  }, [connectServer, persist, refreshOne]);

  const anyLive = Object.values(live).some(Boolean);

  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => void refreshAll(), 3000);
    return () => clearInterval(t);
  }, [anyLive, refreshAll]);

  useEffect(() => {
    if (!anyLive) return;
    const es = new EventSource("/api/events");
    es.onmessage = (ev) => {
      let msg: { type?: string; id?: string; serverId?: string; event?: ClassifiedEvent };
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
      const same =
        selRef.current.sessionId === msg.id &&
        (!msg.serverId || selRef.current.serverId === msg.serverId);
      if (!same && (pri === "interrupt" || pri === "badge")) {
        setBadges((b) => ({ ...b, [msg.id!]: (b[msg.id!] || 0) + 1 }));
      }
      if (same) {
        setEvents((xs) => [...xs, rec as ClassifiedEvent]);
      }
      void refreshAll();
    };
    return () => es.close();
  }, [anyLive, refreshAll]);

  const current =
    (sel.serverId && (sessionsByServer[sel.serverId] || []).find((s) => s.id === sel.sessionId)) || null;
  const connected = Boolean(sel.serverId && live[sel.serverId]);

  return (
    <div className={`app${depot.collapsed ? " collapsed" : ""}`}>
      <PathTree
        depot={depot}
        sessionsByServer={sessionsByServer}
        live={live}
        selected={sel}
        badges={badges}
        collapsed={depot.collapsed}
        onToggleCollapsed={() => persist({ ...depot, collapsed: !depot.collapsed })}
        onSelectServer={(id) => {
          setSel({ serverId: id, cwd: null, sessionId: null });
          setEvents([]);
          const s = depot.servers.find((x) => x.id === id);
          if (s && s.token && !live[id]) void connectServer(s);
          else void refreshOne(id);
        }}
        onSelectCwd={(serverId, cwd) => {
          setSel({ serverId, cwd, sessionId: null });
          setEvents([]);
        }}
        onSelectSession={onSelectSession}
        onSaveServer={(s) => {
          const servers = depot.servers.some((x) => x.id === s.id)
            ? depot.servers.map((x) => (x.id === s.id ? s : x))
            : [...depot.servers, s];
          persist({ ...depot, servers });
          setSel({ serverId: s.id, cwd: null, sessionId: null });
          void connectServer(s);
        }}
        onDropServer={(id) => {
          persist({ ...depot, servers: depot.servers.filter((s) => s.id !== id) });
          if (sel.serverId === id) {
            setSel({ serverId: null, cwd: null, sessionId: null });
            setEvents([]);
          }
        }}
        onPinCwd={(serverId, cwd) => persist(pinCwd(depot, serverId, cwd))}
        onStart={async (serverId, cwd, prompt, name) => {
          const res = await rpc(
            "start",
            { cwd, prompt, name: name || undefined, permission_mode: "auto" },
            serverId,
          );
          if (!res.ok) throw new Error(String(res.error || "新建会话失败"));
          await refreshOne(serverId);
          onSelectSession(serverId, cwd, String(res.id));
        }}
        onStop={async (serverId, id) => {
          await rpc("stop", { id }, serverId);
          await refreshOne(serverId);
          if (sel.sessionId === id) {
            setSel({ serverId, cwd: sel.cwd, sessionId: null });
            setEvents([]);
          }
        }}
      />
      <div className="main">
        {current ? (
          <>
            <div className="pathcrumb">
              {sel.serverId} · {current.cwd || sel.cwd || "—"} · {current.id}
            </div>
            <PendingBar
              id={current.id}
              serverId={sel.serverId}
              pending={current.pending || []}
              onDone={() => void refreshAll()}
            />
          </>
        ) : null}
        {current ? <Transcript events={events} /> : <div className="empty">选择一个会话</div>}
        <Composer
          id={sel.sessionId}
          serverId={sel.serverId}
          held={current?.lock === "operator"}
          enabled={connected && Boolean(current?.alive)}
        />
      </div>
      <Toasts items={toasts} onDismiss={(k) => setToasts((xs) => xs.filter((t) => t.key !== k))} />
    </div>
  );
}
