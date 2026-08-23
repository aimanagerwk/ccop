"use client";

import { useEffect, useMemo, useState } from "react";
import type { ClassifiedEvent, SessionRow } from "../lib/protocol";
import {
  buildDagDomain,
  buildDagGraph,
  clockTicks,
  groupTracksByWorkflow,
  xOf,
  type DagBoard,
  type DagDomainScale,
  type DagLane,
  type DagSeries,
  type DagStatusTone,
  type DagTrack,
} from "../lib/workflow-dag";
import {
  buildMonitorSnapshot,
  clipDisplay,
  formatClock,
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

const SERIES_OK = new Set<DagSeries>(["series-1", "series-2", "series-3", "other"]);
const TONE_OK = new Set<DagStatusTone>(["running", "done", "failed"]);

function seriesClass(s?: DagSeries): string {
  return s && SERIES_OK.has(s) ? s : "other";
}

function toneClass(t?: DagStatusTone): string {
  return t && TONE_OK.has(t) ? t : "";
}

function pct(domain: DagDomainScale, ts?: number): number | undefined {
  const x = xOf(domain, ts);
  return x === undefined ? undefined : x * 100;
}

function barStyle(domain: DagDomainScale, start?: number, end?: number, nowSec?: number): { left: string; width: string } | null {
  const a = start;
  const b = end ?? nowSec;
  const left = pct(domain, a);
  const right = pct(domain, b);
  if (left === undefined || right === undefined || right < left) return null;
  const width = Math.max(right - left, 0.6);
  return { left: `${left}%`, width: `${width}%` };
}

function DagClock(props: { domain: DagDomainScale; ticks: { ts: number; label: string }[]; nowSec?: number; live: boolean }) {
  if (props.domain.empty) return null;
  const nowX = props.live && props.nowSec !== undefined ? pct(props.domain, props.nowSec) : undefined;
  return (
    <div className="dag-clock" aria-hidden="true">
      {props.ticks.map((t) => {
        const left = pct(props.domain, t.ts);
        if (left === undefined) return null;
        return (
          <span key={t.ts} className="dag-tick" style={{ left: `${left}%` }}>
            {t.label}
          </span>
        );
      })}
      {nowX !== undefined ? (
        <span className="dag-now" style={{ left: `${nowX}%` }} title={formatClock(props.nowSec)}>
          <span className="dag-now-label">{formatClock(props.nowSec)}</span>
        </span>
      ) : null}
    </div>
  );
}

function TrackPlot(props: {
  track: DagTrack;
  lanes: DagLane[];
  domain: DagDomainScale;
  nowSec?: number;
  colorJob: "track" | "lane";
}) {
  const wfBar = barStyle(props.domain, props.track.start_ts, props.track.end_ts, props.track.live ? props.nowSec : undefined);
  const tone = toneClass(props.track.live ? "running" : props.track.status === "completed" ? "done" : props.track.status === "failed" || props.track.status === "killed" || props.track.status === "stopped" ? "failed" : undefined);
  return (
    <div className="dag-track">
      <div className="dag-track-head">
        {props.colorJob === "track" ? <i className={`swatch ${seriesClass(props.track.series)}`} /> : null}
        <span className={`dot${props.track.live ? " live pulse" : props.track.status === "completed" ? " idle" : " ended"}`} />
        <div className="mon-row-main">
          <div className="mon-row-title" title={props.track.track_id}>
            {clipDisplay(props.track.workflow_name || props.track.track_id, 48)}
          </div>
          <div className="mon-row-meta">
            {taskStatusLabel(props.track.status)}
            {props.track.tool_use_id ? ` · ${clipDisplay(props.track.tool_use_id, 20)}` : ""}
          </div>
        </div>
      </div>
      <div className="dag-lane">
        <div className="dag-lane-lab mute">轨道</div>
        <div className="dag-lane-plot">
          {wfBar ? (
            <span
              className={`dag-bar tone-${tone || "idle"}`}
              style={wfBar}
              title={`${formatClock(props.track.start_ts)} – ${formatClock(props.track.end_ts ?? props.nowSec)}`}
            />
          ) : null}
        </div>
      </div>
      {props.lanes.map((lane) => {
        const bar = barStyle(props.domain, lane.start_ts, lane.end_ts, lane.live ? props.nowSec : undefined);
        const lt = toneClass(lane.live ? "running" : lane.status === "completed" ? "done" : "failed");
        return (
          <div key={lane.lane_id} className="dag-lane">
            <div className="dag-lane-lab" title={lane.lane_id}>
              {props.colorJob === "lane" ? <i className={`swatch ${seriesClass(lane.series)}`} /> : null}
              {clipDisplay(lane.lane_id, 12)}
            </div>
            <div className="dag-lane-plot">
              {bar ? (
                <span
                  className={`dag-bar tone-${lt || "idle"}`}
                  style={bar}
                  title={`${clipDisplay(lane.lane_id, 24)} ${formatClock(lane.start_ts)} – ${formatClock(lane.end_ts ?? props.nowSec)}`}
                />
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DagBoardView(props: { board: DagBoard; lanes: DagLane[]; domain: DagDomainScale; nowSec?: number }) {
  const colorJob = props.board.layout === "side-by-side" ? "track" : "lane";
  const byTrack = new Map<string, DagLane[]>();
  for (const l of props.lanes) {
    if (!l.track_id) continue;
    const list = byTrack.get(l.track_id) || [];
    list.push(l);
    byTrack.set(l.track_id, list);
  }
  const unjoined = props.board.unjoined_lane_ids
    .map((id) => props.lanes.find((l) => l.lane_id === id))
    .filter((l): l is DagLane => !!l);
  return (
    <div className={`dag-board layout-${props.board.layout}`}>
      <div className="dag-board-head">{clipDisplay(props.board.workflow_name === "_unnamed" ? "未命名" : props.board.workflow_name, 64)}</div>
      <div
        className="dag-tracks"
        style={
          props.board.layout === "side-by-side"
            ? { gridTemplateColumns: `repeat(${Math.max(props.board.tracks.length, 1)}, minmax(0, 1fr))` }
            : undefined
        }
      >
        {props.board.tracks.map((t) => (
          <TrackPlot
            key={t.track_id}
            track={t}
            lanes={byTrack.get(t.track_id) || []}
            domain={props.domain}
            nowSec={props.nowSec}
            colorJob={colorJob}
          />
        ))}
      </div>
      {unjoined.length ? (
        <div className="dag-unjoined">
          <div className="stat-k">未分组</div>
          {unjoined.map((l) => (
            <div key={l.lane_id} className="dag-lane">
              <div className="dag-lane-lab" title={l.lane_id}>
                {colorJob === "lane" ? <i className={`swatch ${seriesClass(l.series)}`} /> : null}
                {clipDisplay(l.lane_id, 12)}
              </div>
              <div className="dag-lane-plot" />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

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
  const dag = useMemo(
    () => buildDagGraph({ snapshot: snap, events: props.events, now }),
    [snap, props.events, now],
  );
  const domain = useMemo(() => buildDagDomain(dag, now), [dag, now]);
  const ticks = useMemo(() => clockTicks(domain), [domain]);
  const boards = useMemo(() => groupTracksByWorkflow(dag, now), [dag, now]);
  const nowSec = now > 1e12 ? now / 1000 : now > 1e9 ? now : undefined;
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

      {boards.length ? (
        <div className="dag" aria-label="工作流 DAG">
          <div className="stat-k">工作流 DAG</div>
          <DagClock domain={domain} ticks={ticks} nowSec={nowSec} live={live} />
          {boards.map((b) => (
            <DagBoardView key={b.workflow_name} board={b} lanes={dag.lanes} domain={domain} nowSec={nowSec} />
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
