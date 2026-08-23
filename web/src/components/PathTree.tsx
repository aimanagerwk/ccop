"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { SessionRow } from "../lib/protocol";
import type { DepotServer, DepotState } from "../lib/depot-store";
import { lastPathSeg, serverKey, sessLabel } from "../lib/depot-store";
import { sessionDotClass } from "../lib/session-dot";
import {
  formatActiveAgo,
  isSessionHot,
  partitionTreeNodes,
  sessionActiveTs,
  type CwdPartition,
} from "../lib/session-active";

export type TreeSel = {
  serverId: string | null;
  cwd: string | null;
  sessionId: string | null;
};

export function PathTree(props: {
  depot: DepotState;
  sessionsByServer: Record<string, SessionRow[]>;
  live: Record<string, boolean>;
  selected: TreeSel;
  badges: Record<string, number>;
  collapsed: boolean;
  inboxCount?: number;
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
  const [openIdle, setOpenIdle] = useState<Record<string, boolean>>({});
  const [startFor, setStartFor] = useState<string | null>(null);
  const [pinFor, setPinFor] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number | null>(null);
  const nowSec = (nowMs ?? 0) / 1000;
  const inboxN = props.inboxCount ?? 0;

  useEffect(() => {
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const sid = props.selected.sessionId;
    const serverId = props.selected.serverId;
    if (!sid || !serverId) return;
    const sessions = props.sessionsByServer[serverId] || [];
    const hit = sessions.find((s) => s.id === sid);
    if (!hit) return;
    if (isSessionHot(hit, Date.now() / 1000)) return;
    const ck = `${serverId}|${hit.cwd || ""}`;
    setOpenSrv((m) => (m[serverId] === false ? { ...m, [serverId]: true } : m));
    setOpenCwd((m) => (m[ck] === false ? { ...m, [ck]: true } : m));
    setOpenIdle((m) => (m[ck] ? m : { ...m, [ck]: true }));
    const pinned = new Set(props.depot.pinnedCwds[serverId] || []);
    const { idleCwds } = partitionTreeNodes(sessions, [...pinned], Date.now() / 1000, sid);
    if (idleCwds.some((p) => p.cwd === (hit.cwd || ""))) {
      const sk = `${serverId}|idle-cwds`;
      setOpenIdle((m) => (m[sk] ? m : { ...m, [sk]: true }));
    }
  }, [props.selected.sessionId, props.selected.serverId, props.sessionsByServer, props.depot.pinnedCwds]);

  if (props.collapsed) {
    return (
      <aside className="rail">
        <div className="collapsed-rail">
          <button
            className="ghost rail-icon"
            aria-label={inboxN ? `展开侧栏，待批准 ${inboxN}` : "展开侧栏"}
            title={inboxN ? `待批准 ${inboxN}` : "展开侧栏"}
            onClick={props.onToggleCollapsed}
          >
            »
            {inboxN ? <span className="badge" /> : null}
          </button>
          {props.depot.servers.map((s) => (
            <button
              key={s.id}
              className="ghost rail-icon"
              title={s.label}
              aria-label={s.label}
              onClick={() => props.onSelectServer(s.id)}
            >
              <span className={`dot ${props.live[s.id] ? "live" : "ended"}`} />
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
        <button
          type="button"
          className="iconbtn"
          title="添加服务器"
          aria-label="添加服务器"
          onClick={() => setAddingSrv((v) => !v)}
        >
          +
        </button>
        <button className="ghost rail-icon" aria-label="收起侧栏" onClick={props.onToggleCollapsed}>
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
          let { visible, idleCwds } = partitionTreeNodes(
            sessions,
            props.depot.pinnedCwds[srv.id] || [],
            nowSec,
            props.selected.serverId === srv.id ? props.selected.sessionId : null,
          );
          if (nowMs === null) {
            visible = [...visible, ...idleCwds].map((p) => ({
              ...p,
              hot: [...p.hot, ...p.idle],
              idle: [],
            }));
            idleCwds = [];
          }
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
                  <span className={`dot ${live ? "live" : "ended"}`} />
                  <span className="trow-name">{srv.label || srv.host}</span>
                  <span className="trow-meta">
                    {srv.host}:{srv.port} {live ? "已连接" : "未连接"}
                  </span>
                </button>
                <div className="trow-acts">
                  <button
                    type="button"
                    className="plus-act"
                    title="新建会话"
                    aria-label="新建会话"
                    onClick={(e) => {
                      e.stopPropagation();
                      const key = `${srv.id}|`;
                      setStartFor(startFor === key ? null : key);
                    }}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="icon-act"
                    title="编辑服务器"
                    aria-label="编辑服务器"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditId(editId === srv.id ? null : srv.id);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="danger icon-act"
                    title="移除服务器"
                    aria-label="移除服务器"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onDropServer(srv.id);
                    }}
                  >
                    ×
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
                  {startFor === `${srv.id}|` ? (
                    <StartFields
                      cwd={props.depot.pinnedCwds[srv.id]?.[0] || "/workspace"}
                      cwdEditable
                      onStart={async (prompt, name, cwd) => {
                        await props.onStart(srv.id, cwd, prompt, name);
                        setStartFor(null);
                      }}
                      onCancel={() => setStartFor(null)}
                    />
                  ) : null}
                  {visible.map((part) => (
                    <CwdBlock
                      key={`${srv.id}|${part.cwd}`}
                      srvId={srv.id}
                      part={part}
                      selected={props.selected}
                      badges={props.badges}
                      nowMs={nowMs}
                      open={openCwd[`${srv.id}|${part.cwd}`] !== false}
                      idleOpen={openIdle[`${srv.id}|${part.cwd}`] === true}
                      startFor={startFor}
                      onToggleOpen={() => {
                        const ck = `${srv.id}|${part.cwd}`;
                        setOpenCwd((m) => ({ ...m, [ck]: !(m[ck] !== false) }));
                        props.onSelectCwd(srv.id, part.cwd);
                      }}
                      onToggleIdle={() => {
                        const ck = `${srv.id}|${part.cwd}`;
                        setOpenIdle((m) => ({ ...m, [ck]: !m[ck] }));
                      }}
                      onSelectSession={props.onSelectSession}
                      onStop={props.onStop}
                      onToggleStart={() => {
                        const ck = `${srv.id}|${part.cwd}`;
                        setStartFor(startFor === ck ? null : ck);
                      }}
                      onStarted={async (prompt, name, startCwd) => {
                        await props.onStart(srv.id, startCwd, prompt, name);
                        setStartFor(null);
                      }}
                      onCancelStart={() => setStartFor(null)}
                    />
                  ))}
                  {idleCwds.length > 0 ? (
                    <IdleFold
                      indent={1}
                      n={idleCwds.reduce((a, p) => a + p.idle.length, 0)}
                      open={openIdle[`${srv.id}|idle-cwds`] === true}
                      extra={`${idleCwds.length} 个目录`}
                      onToggle={() =>
                        setOpenIdle((m) => ({ ...m, [`${srv.id}|idle-cwds`]: !m[`${srv.id}|idle-cwds`] }))
                      }
                    >
                      {idleCwds.map((part) => (
                        <CwdBlock
                          key={`${srv.id}|idle|${part.cwd}`}
                          srvId={srv.id}
                          part={{ ...part, hot: [], idle: part.idle }}
                          selected={props.selected}
                          badges={props.badges}
                          nowMs={nowMs}
                          open={openCwd[`${srv.id}|${part.cwd}`] !== false}
                          idleOpen
                          hideIdleFold
                          startFor={startFor}
                          onToggleOpen={() => {
                            const ck = `${srv.id}|${part.cwd}`;
                            setOpenCwd((m) => ({ ...m, [ck]: !(m[ck] !== false) }));
                            props.onSelectCwd(srv.id, part.cwd);
                          }}
                          onToggleIdle={() => undefined}
                          onSelectSession={props.onSelectSession}
                          onStop={props.onStop}
                          onToggleStart={() => {
                            const ck = `${srv.id}|${part.cwd}`;
                            setStartFor(startFor === ck ? null : ck);
                          }}
                          onStarted={async (prompt, name, startCwd) => {
                            await props.onStart(srv.id, startCwd, prompt, name);
                            setStartFor(null);
                          }}
                          onCancelStart={() => setStartFor(null)}
                        />
                      ))}
                    </IdleFold>
                  ) : null}
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
      {addingSrv ? (
        <div className="rail-overlay" role="dialog" aria-label="添加服务器">
          <ServerFields
            initial={null}
            onSave={(next) => {
              props.onSaveServer(next);
              setAddingSrv(false);
            }}
            onCancel={() => setAddingSrv(false)}
          />
        </div>
      ) : null}
    </aside>
  );
}

function CwdBlock(props: {
  srvId: string;
  part: CwdPartition;
  selected: TreeSel;
  badges: Record<string, number>;
  nowMs: number | null;
  open: boolean;
  idleOpen: boolean;
  hideIdleFold?: boolean;
  startFor: string | null;
  onToggleOpen: () => void;
  onToggleIdle: () => void;
  onSelectSession: (serverId: string, cwd: string | undefined, id: string) => void;
  onStop: (serverId: string, id: string) => Promise<void>;
  onToggleStart: () => void;
  onStarted: (prompt: string, name: string, cwd: string) => Promise<void>;
  onCancelStart: () => void;
}) {
  const { part } = props;
  const ck = `${props.srvId}|${part.cwd}`;
  const cwdOn =
    props.selected.cwd === part.cwd && props.selected.serverId === props.srvId && !props.selected.sessionId;
  const listed = props.hideIdleFold ? part.idle : part.hot;
  return (
    <div>
      <div className={`trow indent-1 ${cwdOn ? "on" : ""}`}>
        <button type="button" className="trow-main" title={part.cwd} onClick={props.onToggleOpen}>
          <span className="chev">{props.open ? "▾" : "▸"}</span>
          <span className="trow-name path">{lastPathSeg(part.cwd)}</span>
          <span className="trow-meta" title={part.cwd}>
            {part.cwd}
          </span>
        </button>
        <div className="trow-acts">
          <button
            type="button"
            className="plus-act"
            title="新建会话"
            aria-label="新建会话"
            onClick={(e) => {
              e.stopPropagation();
              props.onToggleStart();
            }}
          >
            +
          </button>
        </div>
      </div>
      {props.open ? (
        <>
          {listed.map((s) => (
            <SessionTrow
              key={s.id}
              s={s}
              serverId={props.srvId}
              selected={props.selected.sessionId === s.id}
              badge={Boolean(props.badges[s.id] && props.selected.sessionId !== s.id)}
              nowMs={props.nowMs}
              indent={2}
              onSelect={() => props.onSelectSession(props.srvId, s.cwd, s.id)}
              onStop={() => void props.onStop(props.srvId, s.id)}
            />
          ))}
          {!props.hideIdleFold && part.idle.length > 0 ? (
            <IdleFold indent={2} n={part.idle.length} open={props.idleOpen} onToggle={props.onToggleIdle}>
              {part.idle.map((s) => (
                <SessionTrow
                  key={s.id}
                  s={s}
                  serverId={props.srvId}
                  selected={props.selected.sessionId === s.id}
                  badge={Boolean(props.badges[s.id] && props.selected.sessionId !== s.id)}
                  nowMs={props.nowMs}
                  indent={3}
                  onSelect={() => props.onSelectSession(props.srvId, s.cwd, s.id)}
                  onStop={() => void props.onStop(props.srvId, s.id)}
                />
              ))}
            </IdleFold>
          ) : null}
          {props.startFor === ck ? (
            <StartFields cwd={part.cwd} onStart={props.onStarted} onCancel={props.onCancelStart} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function SessionTrow(props: {
  s: SessionRow;
  serverId: string;
  selected: boolean;
  badge: boolean;
  nowMs: number | null;
  indent: 2 | 3;
  onSelect: () => void;
  onStop: () => void;
}) {
  const ago = props.nowMs === null ? { text: "", title: "" } : formatActiveAgo(sessionActiveTs(props.s), props.nowMs);
  return (
    <div className={`trow indent-${props.indent} ${props.selected ? "on" : ""}`}>
      <button type="button" className="trow-main" onClick={props.onSelect}>
        <span className="chev" />
        <span className={`dot ${sessionDotClass(props.s)}`} />
        <span className="trow-name">{sessLabel(props.s)}</span>
        {ago.text ? (
          <span className="trow-ago" title={ago.title}>
            {ago.text}
          </span>
        ) : null}
        {props.badge ? <span className="badge" /> : null}
      </button>
      <div className="trow-acts">
        <button
          type="button"
          className="danger icon-act"
          title="停止会话"
          aria-label="停止会话"
          onClick={(e) => {
            e.stopPropagation();
            props.onStop();
          }}
        >
          ■
        </button>
      </div>
    </div>
  );
}

function IdleFold(props: {
  indent: 1 | 2;
  n: number;
  open: boolean;
  extra?: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <div className={`trow indent-${props.indent}`}>
        <button type="button" className="trow-main" onClick={props.onToggle}>
          <span className="chev">{props.open ? "▾" : "▸"}</span>
          <span className="trow-name" style={{ color: "var(--mute)" }}>
            暂无活动
          </span>
          <span className="trow-ago">
            {props.n}
            {props.extra ? ` · ${props.extra}` : ""}
          </span>
        </button>
      </div>
      {props.open ? props.children : null}
    </>
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
        placeholder="令牌"
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
  cwdEditable?: boolean;
  onStart: (prompt: string, name: string, cwd: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState(props.cwd);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <form
      className="sheet"
      onSubmit={(e) => {
        e.preventDefault();
        if (!cwd.startsWith("/")) {
          setErr("目录须以 / 开头");
          return;
        }
        setBusy(true);
        setErr("");
        void props
          .onStart(prompt, name, cwd)
          .then(() => setPrompt(""))
          .catch((ex: unknown) => setErr(ex instanceof Error ? ex.message : String(ex)))
          .finally(() => setBusy(false));
      }}
    >
      {props.cwdEditable ? (
        <>
          <label htmlFor="st-cwd">目录</label>
          <input id="st-cwd" value={cwd} onChange={(e) => setCwd(e.target.value)} />
        </>
      ) : (
        <div className="tiny" style={{ padding: 0 }}>
          {props.cwd}
        </div>
      )}
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
