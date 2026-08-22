"use client";

import { useState } from "react";
import type { SessionRow } from "../lib/protocol";
import type { DepotServer, DepotState } from "../lib/depot-store";
import { serverKey } from "../lib/depot-store";

export type TreeSel = {
  serverId: string | null;
  cwd: string | null;
  sessionId: string | null;
};

function groupByCwd(sessions: SessionRow[], pinned: string[]): string[] {
  const set = new Set<string>(pinned);
  for (const s of sessions) {
    if (s.cwd) set.add(s.cwd);
  }
  return [...set].sort();
}

function sessLabel(s: SessionRow): string {
  return s.title || s.name || s.id.slice(0, 8);
}

export function PathTree(props: {
  depot: DepotState;
  sessionsByServer: Record<string, SessionRow[]>;
  live: Record<string, boolean>;
  selected: TreeSel;
  badges: Record<string, number>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelectServer: (id: string) => void;
  onSelectCwd: (serverId: string, cwd: string) => void;
  onSelectSession: (serverId: string, cwd: string | undefined, id: string) => void;
  onSaveServer: (s: DepotServer) => void;
  onDropServer: (id: string) => void;
  onPinCwd: (serverId: string, cwd: string) => void;
  onStart: (serverId: string, cwd: string, prompt: string, name: string) => Promise<void>;
  onStop: (serverId: string, id: string) => Promise<void>;
}) {
  const [addingSrv, setAddingSrv] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [openSrv, setOpenSrv] = useState<Record<string, boolean>>({});
  const [openCwd, setOpenCwd] = useState<Record<string, boolean>>({});
  const [startFor, setStartFor] = useState<string | null>(null);

  if (props.collapsed) {
    return (
      <aside className="depot">
        <div className="collapsed-rail">
          <button className="ghost" aria-label="展开车场" onClick={props.onToggleCollapsed}>
            »
          </button>
          {props.depot.servers.map((s) => (
            <button
              key={s.id}
              className="ghost"
              title={s.label}
              aria-label={s.label}
              onClick={() => props.onSelectServer(s.id)}
            >
              <span className={`lamp ${props.live[s.id] ? "live" : ""}`} />
            </button>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className="depot">
      <div className="depot-head">
        <span className="depot-mark" aria-hidden />
        <h1 className="depot-title">车场</h1>
        <button className="ghost" aria-label="收起车场" onClick={props.onToggleCollapsed}>
          «
        </button>
      </div>
      <div className="depot-tree">
        {props.depot.servers.length === 0 ? <div className="tiny">还没有机。先挂一台。</div> : null}
        {props.depot.servers.map((srv) => {
          const open = openSrv[srv.id] !== false;
          const sessions = props.sessionsByServer[srv.id] || [];
          const cwds = groupByCwd(sessions, props.depot.pinnedCwds[srv.id] || []);
          const live = Boolean(props.live[srv.id]);
          return (
            <div key={srv.id}>
              <button
                type="button"
                className={`tag ${props.selected.serverId === srv.id && !props.selected.sessionId ? "on" : ""}`}
                onClick={() => {
                  setOpenSrv((m) => ({ ...m, [srv.id]: !open }));
                  props.onSelectServer(srv.id);
                }}
              >
                <div className="row2">
                  <span className={`lamp ${live ? "live" : "halt"}`} />
                  <span className="name">{open ? "▾" : "▸"} {srv.label || srv.host}</span>
                </div>
                <div className="meta">
                  {srv.host}:{srv.port} {live ? "在线" : "离线"}
                </div>
              </button>
              {open ? (
                <div className="kids">
                  <div className="actions">
                    <button type="button" className="ghost" onClick={() => setEditId(editId === srv.id ? null : srv.id)}>
                      改机
                    </button>
                    <button type="button" className="deny" onClick={() => props.onDropServer(srv.id)}>
                      卸机
                    </button>
                  </div>
                  {editId === srv.id ? (
                    <ServerFields
                      initial={srv}
                      onSave={(next) => {
                        props.onSaveServer(next);
                        setEditId(null);
                      }}
                      onCancel={() => setEditId(null)}
                    />
                  ) : null}
                  {cwds.map((cwd) => {
                    const ck = `${srv.id}|${cwd}`;
                    const cOpen = openCwd[ck] !== false;
                    const here = sessions.filter((s) => (s.cwd || "") === cwd);
                    return (
                      <div key={ck} className="indent">
                        <button
                          type="button"
                          className={`tag ${props.selected.cwd === cwd && props.selected.serverId === srv.id && !props.selected.sessionId ? "on" : ""}`}
                          onClick={() => {
                            setOpenCwd((m) => ({ ...m, [ck]: !cOpen }));
                            props.onSelectCwd(srv.id, cwd);
                          }}
                        >
                          <div className="name">{cOpen ? "▾" : "▸"} 目录</div>
                          <div className="meta">{cwd}</div>
                        </button>
                        {cOpen ? (
                          <div className="kids">
                            {here.map((s) => {
                              const pending = s.pending?.length ?? 0;
                              return (
                                <div key={s.id} className="indent-2">
                                  <button
                                    type="button"
                                    className={`tag ${props.selected.sessionId === s.id ? "on" : ""}`}
                                    onClick={() => props.onSelectSession(srv.id, s.cwd, s.id)}
                                  >
                                    <div className="row2">
                                      <span className={`lamp ${s.alive ? "live" : "halt"} ${pending ? "warn" : ""}`} />
                                      <span className="name">{sessLabel(s)}</span>
                                      {props.badges[s.id] && props.selected.sessionId !== s.id ? (
                                        <span className="badge" />
                                      ) : null}
                                    </div>
                                    <div className="meta">
                                      {s.alive ? "活着" : "已停"}
                                      {s.lock ? ` · 锁 ${s.lock}` : ""}
                                      {pending ? ` · 待决 ${pending}` : ""}
                                      <div>{s.id}</div>
                                    </div>
                                  </button>
                                  <div className="actions">
                                    <button type="button" className="deny" onClick={() => void props.onStop(srv.id, s.id)}>
                                      停掉
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                            <button
                              type="button"
                              className="ghost"
                              onClick={() => setStartFor(startFor === ck ? null : ck)}
                            >
                              + 会话
                            </button>
                            {startFor === ck ? (
                              <StartFields
                                cwd={cwd}
                                onStart={async (prompt, name) => {
                                  await props.onStart(srv.id, cwd, prompt, name);
                                  setStartFor(null);
                                }}
                              />
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                  <PinCwd onPin={(cwd) => props.onPinCwd(srv.id, cwd)} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="depot-foot">
        <button type="button" className="primary" onClick={() => setAddingSrv((v) => !v)}>
          + 挂机
        </button>
        {addingSrv ? (
          <ServerFields
            initial={null}
            onSave={(next) => {
              props.onSaveServer(next);
              setAddingSrv(false);
            }}
            onCancel={() => setAddingSrv(false)}
          />
        ) : null}
      </div>
    </aside>
  );
}

function ServerFields(props: {
  initial: DepotServer | null;
  onSave: (s: DepotServer) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(props.initial?.label || "本机");
  const [host, setHost] = useState(props.initial?.host || "127.0.0.1");
  const [port, setPort] = useState(String(props.initial?.port || 8787));
  const [token, setToken] = useState(props.initial?.token || "");
  return (
    <form
      className="sheet"
      onSubmit={(e) => {
        e.preventDefault();
        const p = Number(port);
        if (!Number.isFinite(p) || !token) return;
        const id = props.initial?.id || serverKey(host, p);
        props.onSave({ id, label: label || host, host, port: p, token });
      }}
    >
      <label htmlFor="srv-label">名牌</label>
      <input id="srv-label" value={label} onChange={(e) => setLabel(e.target.value)} />
      <label htmlFor="srv-host">主机</label>
      <input id="srv-host" value={host} onChange={(e) => setHost(e.target.value)} />
      <label htmlFor="srv-port">端口</label>
      <input id="srv-port" value={port} onChange={(e) => setPort(e.target.value)} />
      <label htmlFor="srv-token">令牌</label>
      <input
        id="srv-token"
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="CCOP_TOKEN"
        autoComplete="off"
      />
      <div className="actions">
        <button type="submit" className="primary">
          {props.initial ? "保存并接通" : "挂上并接通"}
        </button>
        <button type="button" className="ghost" onClick={props.onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

function StartFields(props: { cwd: string; onStart: (prompt: string, name: string) => Promise<void> }) {
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <form
      className="sheet"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setErr("");
        void props
          .onStart(prompt, name)
          .then(() => setPrompt(""))
          .catch((ex: unknown) => setErr(ex instanceof Error ? ex.message : String(ex)))
          .finally(() => setBusy(false));
      }}
    >
      <div className="tiny">{props.cwd}</div>
      <label htmlFor="st-name">会话名</label>
      <input id="st-name" value={name} onChange={(e) => setName(e.target.value)} />
      <label htmlFor="st-prompt">第一句</label>
      <textarea id="st-prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} required />
      <div className="actions">
        <button type="submit" className="primary" disabled={busy || !prompt}>
          {busy ? "…" : "开会话"}
        </button>
      </div>
      {err ? <div className="err">{err}</div> : null}
    </form>
  );
}

function PinCwd(props: { onPin: (cwd: string) => void }) {
  const [cwd, setCwd] = useState("/workspace");
  return (
    <form
      className="sheet"
      onSubmit={(e) => {
        e.preventDefault();
        if (cwd.startsWith("/")) props.onPin(cwd);
      }}
    >
      <label htmlFor="pin-cwd">钉住目录</label>
      <div className="row">
        <input id="pin-cwd" className="grow" value={cwd} onChange={(e) => setCwd(e.target.value)} />
        <button type="submit" className="ghost">
          钉住
        </button>
      </div>
    </form>
  );
}
