"use client";

import { useEffect, useMemo, useState } from "react";
import type { ClassifiedEvent, SessionRow } from "../lib/protocol";
import {
  buildMonitorSnapshot,
  clipDisplay,
  formatDuration,
  formatTokens,
  formatUsd,
  progressShares,
  sessionKindLabel,
  sharePercents,
  taskStatusLabel,
  tokenBarShares,
  type PctSeg,
} from "../lib/workflow-monitor";

function ShareBar(props: { segs: PctSeg[]; tone: "status" | "token"; live?: boolean }) {
  if (!props.segs.length) return <div className="share-bar empty" />;
  return (
    <div className="share-bar" role="img" aria-label={props.segs.map((s) => `${s.label} ${s.n}`).join("，")}>
      {props.segs.map((s) => (
        <span
          key={s.key}
          className={`share-seg ${props.tone}-${s.key}${props.live && s.key === "running" ? " is-live" : ""}`}
          style={{ width: `${s.pct}%` }}
        />
      ))}
    </div>
  );
}

export function WorkflowPanel(props: {
  session: SessionRow;
  info: Record<string, unknown> | null;
  tasks: unknown;
  subagents: unknown;
  workflows: Record<string, unknown> | null;
  events: ClassifiedEvent[];
}) {
  const [now, setNow] = useState(() => Date.now());
  const snap = useMemo(
    () =>
      buildMonitorSnapshot({
        session: props.session,
        info: props.info,
        tasks: props.tasks,
        subagents: props.subagents,
        workflows: props.workflows,
        events: props.events,
        now,
      }),
    [props.session, props.info, props.tasks, props.subagents, props.workflows, props.events, now],
  );
  const live = snap.progress.running > 0 || snap.progress.agents_running > 0 || snap.kind === "working";
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  const progress = sharePercents(progressShares(snap.progress));
  const tokens = sharePercents(tokenBarShares(snap.tokens));
  const kind = sessionKindLabel(snap.kind) || (snap.alive ? "在线" : "已结束");

  return (
    <section className="monitor" aria-label="执行监控">
      <header className="mon-head">
        <div className="mon-title">执行监控</div>
        <div className="mon-pills">
          <span className={`pill${live ? " live" : ""}`}>
            <span className={`dot${live ? " live pulse" : snap.alive ? " idle" : " ended"}`} />
            {kind}
          </span>
          {snap.enable_workflows === true ? <span className="pill">工作流开</span> : null}
          {snap.effort ? <span className="pill">{snap.effort}</span> : null}
          {snap.pending ? <span className="pill warn">待批准 {snap.pending}</span> : null}
        </div>
        <div className="mon-cost" title="cost_usd">
          {formatUsd(snap.tokens.cost_usd)}
        </div>
      </header>

      <div className="mon-grid">
        <div className="stat">
          <div className="stat-k">进度</div>
          <div className="stat-v">
            {snap.progress.total ? `${snap.progress.running} / ${snap.progress.total}` : "—"}
          </div>
          <ShareBar segs={progress} tone="status" live={live} />
          <div className="legend">
            {progress.map((s) => (
              <span key={s.key} className="leg">
                <i className={`swatch status-${s.key}`} />
                {s.label} {s.n}
              </span>
            ))}
            {!progress.length ? <span className="leg mute">还没有任务</span> : null}
          </div>
        </div>

        <div className="stat">
          <div className="stat-k">上下文</div>
          <div className="stat-v" title="input + cache_read + cache_creation">
            {formatTokens(snap.context.used)}
          </div>
          <ShareBar segs={tokens} tone="token" />
          <div className="legend">
            {tokens.map((s) => (
              <span key={s.key} className="leg">
                <i className={`swatch token-${s.key}`} />
                {s.label} {formatTokens(s.n)}
              </span>
            ))}
            {!tokens.length ? <span className="leg mute">还没有用量</span> : null}
          </div>
        </div>

        <div className="stat">
          <div className="stat-k">Token</div>
          <div className="stat-v">{formatTokens((snap.tokens.input_tokens || 0) + (snap.tokens.output_tokens || 0) || null)}</div>
          <dl className="kv">
            <div>
              <dt>输入</dt>
              <dd>{formatTokens(snap.tokens.input_tokens)}</dd>
            </div>
            <div>
              <dt>输出</dt>
              <dd>{formatTokens(snap.tokens.output_tokens)}</dd>
            </div>
            <div>
              <dt>缓存读</dt>
              <dd>{formatTokens(snap.tokens.cache_read_input_tokens)}</dd>
            </div>
            <div>
              <dt>缓存写</dt>
              <dd>{formatTokens(snap.tokens.cache_creation_input_tokens)}</dd>
            </div>
          </dl>
        </div>
      </div>

      {snap.models.length ? (
        <div className="mon-models">
          {snap.models.map((m) => (
            <span key={m.model} className="pill" title={`in ${m.input} / out ${m.output}`}>
              {clipDisplay(m.model, 28)} · {formatTokens(m.input + m.output)}
              {m.cost_usd != null ? ` · ${formatUsd(m.cost_usd)}` : ""}
            </span>
          ))}
        </div>
      ) : null}

      <div className="mon-lists">
        <div>
          <div className="stat-k">任务</div>
          {snap.tasks.length === 0 ? <div className="tiny">没有 tasks</div> : null}
          <ul className="mon-rows">
            {snap.tasks.map((t) => (
              <li key={t.task_id} className={t.live ? "live" : ""}>
                <span className={`dot${t.live ? " live pulse" : t.status === "completed" ? " idle" : " ended"}`} />
                <div className="mon-row-main">
                  <div className="mon-row-title">
                    {clipDisplay(t.workflow_name || t.summary || t.task_id, 64)}
                  </div>
                  <div className="mon-row-meta">
                    {taskStatusLabel(t.status)}
                    {t.task_type ? ` · ${t.task_type}` : ""}
                    {t.last_tool ? ` · ${clipDisplay(t.last_tool, 32)}` : ""}
                    {t.usage?.tool_uses != null ? ` · ${t.usage.tool_uses} 次工具` : ""}
                    {t.usage?.total_tokens != null ? ` · ${formatTokens(t.usage.total_tokens)} tok` : ""}
                  </div>
                </div>
                <div className="mon-dur" aria-live={t.live ? "polite" : undefined}>
                  {formatDuration(t.duration_ms)}
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="stat-k">
            子代理 {snap.progress.agents_total ? `${snap.progress.agents_running}/${snap.progress.agents_total}` : ""}
          </div>
          {snap.agents.length === 0 ? <div className="tiny">没有 subagents</div> : null}
          <ul className="mon-rows">
            {snap.agents.map((a) => (
              <li key={a.agent_id} className={a.live ? "live" : ""}>
                <span className={`dot${a.live ? " live pulse" : " ended"}`} />
                <div className="mon-row-main">
                  <div className="mon-row-title" title={a.agent_id}>
                    {clipDisplay(a.agent_id, 16)}
                  </div>
                  <div className="mon-row-meta">
                    {taskStatusLabel(a.status)}
                    {a.agent_type ? ` · ${a.agent_type}` : ""}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
