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

function cwdLabel(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
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
  const [pinFor, setPinFor] = useState<string | null>(null);

  if (props.collapsed) {
    return (
      <aside className="rail">
        <div className="collapsed-rail">
          <button className="ghost" aria-label="展开侧栏" onClick={props.onToggleCollapsed}>
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
              <span className={`dot ${props.live[s.id] ? "live" : ""}`} />
            </button>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className="rail">
      <div className="rail-head">
        <h1 className="rail-title">会话</h1>
        <button className="ghost" aria-label="收起侧栏" onClick={props.onToggleCollapsed}>
          «
        </button>
      </div>
      <div className="rail-tree">
        {props.depot.servers.length === 0 ? (
          <div className="tiny">还没有服务器，先添加一台。</div>
        ) : null}
        {props.depot.servers.map((srv) => {
          const open = openSrv[srv.id] !== false;
          const sessions = props.sessionsByServer[srv.id] || [];
          const cwds = groupByCwd(sessions, props.depot.pinnedCwds[srv.id] || []);
          const live = Boolean(props.live[srv.id]);
          const srvOn = props.selected.serverId === srv.id && !props.selected.sessionId && !props.selected.cwd;
          return (
            <div key={srv.id}>
              <div className={`trow ${srvOn ? "on" : ""}`}>
                <button
                  type="button"
                  className="trow-main"
                  onClick={() => {
                    setOpenSrv((m) => ({ ...m, [srv.id]: !open }));
                    props.onSelectServer(srv.id);
                  }}
                >
                  <span className="chev">{open ? "▾" : "▸"}</span>
                  <span className={`dot ${live ? "live" : "halt"}`} />
                  <span className="trow-name">{srv.label || srv.host}</span>
                  <span className="trow-id">
                    {srv.host}:{srv.port} {live ? "已连接" : "未连接"}
                  </span>
                </button>
                <div className="trow-acts">
                  <button
                    type="button"
                    title="编辑服务器"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditId(editId === srv.id ? null : srv.id);
                    }}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="danger"
                    title="移除服务器"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onDropServer(srv.id);
                    }}
                  >
                    移除
                  </button>
                </div>
              </div>
              {open ? (
                <>
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
                    const cwdOn =
                      props.selected.cwd === cwd &&
                      props.selected.serverId === srv.id &&
                      !props.selected.sessionId;
                    return (
                      <div key={ck}>
                        <div className={`trow indent-1 ${cwdOn ? "on" : ""}`}>
                          <button
                            type="button"
                            className="trow-main"
                            title={cwd}
                            onClick={() => {
                              setOpenCwd((m) => ({ ...m, [ck]: !cOpen }));
                              props.onSelectCwd(srv.id, cwd);
                            }}
                          >
                            <span className="chev">{cOpen ? "▾" : "▸"}</span>
                            <span className="trow-name path">{cwdLabel(cwd)}</span>
                            <span className="trow-id">{cwd}</span>
                          </button>
                          <div className="trow-acts">
                            <button
                              type="button"
                              title="新建会话"
                              onClick={(e) => {
                                e.stopPropagation();
                                setStartFor(startFor === ck ? null : ck);
                              }}
                            >
                              新建
                            </button>
                          </div>
                        </div>
                        {cOpen ? (
                          <>
                            {here.map((s) => {
                              const pending = s.pending?.length ?? 0;
                              const on = props.selected.sessionId === s.id;
                              return (
                                <div key={s.id} className={`trow indent-2 ${on ? "on" : ""}`}>
                                  <button
                                    type="button"
                                    className="trow-main"
                                    onClick={() => props.onSelectSession(srv.id, s.cwd, s.id)}
                                  >
                                    <span className="chev" />
                                    <span className={`dot ${s.alive ? "live" : "halt"} ${pending ? "warn" : ""}`} />
                                    <span className="trow-name">{sessLabel(s)}</span>
                                    {props.badges[s.id] && props.selected.sessionId !== s.id ? (
                                      <span className="badge" />
                                    ) : null}
                                    <span className="trow-id">{s.id}</span>
                                  </button>
                                  <div className="trow-acts">
                                    <button
                                      type="button"
                                      className="danger"
                                      title="停止会话"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void props.onStop(srv.id, s.id);
                                      }}
                                    >
                                      停止
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                            {startFor === ck ? (
                              <StartFields
                                cwd={cwd}
                                onStart={async (prompt, name) => {
                                  await props.onStart(srv.id, cwd, prompt, name);
                                  setStartFor(null);
                                }}
                                onCancel={() => setStartFor(null)}
                              />
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    );
                  })}
                  <div className={`trow indent-1`}>
                    <button
                      type="button"
                      className="trow-main"
                      onClick={() => setPinFor(pinFor === srv.id ? null : srv.id)}
                    >
                      <span className="chev" />
                      <span className="trow-name" style={{ color: "var(--mute)" }}>
                        添加目录
                      </span>
                    </button>
                  </div>
                  {pinFor === srv.id ? <PinCwd onPin={(cwd) => props.onPinCwd(srv.id, cwd)} /> : null}
                </>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="rail-foot">
        <button type="button" className="quiet-add" onClick={() => setAddingSrv((v) => !v)}>
          添加服务器
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
      <label htmlFor="srv-label">名称</label>
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
          {props.initial ? "保存并连接" : "添加并连接"}
        </button>
        <button type="button" className="ghost" onClick={props.onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

function StartFields(props: {
  cwd: string;
  onStart: (prompt: string, name: string) => Promise<void>;
  onCancel: () => void;
}) {
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
      <div className="tiny" style={{ padding: 0 }}>
        {props.cwd}
      </div>
      <label htmlFor="st-name">名称</label>
      <input id="st-name" value={name} onChange={(e) => setName(e.target.value)} />
      <label htmlFor="st-prompt">初始消息</label>
      <textarea id="st-prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} required />
      <div className="actions">
        <button type="submit" className="primary" disabled={busy || !prompt}>
          {busy ? "…" : "新建会话"}
        </button>
        <button type="button" className="ghost" onClick={props.onCancel}>
          取消
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
      <label htmlFor="pin-cwd">目录</label>
      <div className="row">
        <input id="pin-cwd" className="grow" value={cwd} onChange={(e) => setCwd(e.target.value)} />
        <button type="submit" className="ghost">
          添加
        </button>
      </div>
    </form>
  );
}
