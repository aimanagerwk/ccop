"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from "react";
import type { ClassifiedEvent } from "../lib/protocol";
import { clipToolText, foldTranscript, toolCardPresentation, type FoldedRow } from "../lib/fold-transcript";
import { flattenTimeline, groupTurns, type TimelineItem } from "../lib/timeline-turn";
import { filterGroups } from "../lib/timeline-filter";
import { DEFAULT_ROW_HEIGHT, endScrollTop, virtualWindow, visibleSlice } from "../lib/timeline-virtual";
import { parseMdLite } from "../lib/md-lite";
import { formatDateTimeAttr } from "../lib/format-ts";
import { formatClock } from "../lib/workflow-monitor";

const MdBody = memo(function MdBody(props: { text: string }) {
  return (
    <>
      {parseMdLite(props.text).map((p, i) => {
        if (p.t === "br") return <br key={i} />;
        if (p.t === "code") return <code key={i}>{p.v}</code>;
        if (p.t === "bold") return <strong key={i}>{p.v}</strong>;
        return <span key={i}>{p.v}</span>;
      })}
    </>
  );
});

function ToolCard(props: {
  name: string;
  detail: string;
  input: Record<string, unknown>;
  output?: unknown;
  is_error?: boolean;
}) {
  const presented = toolCardPresentation(props.input, props.output);
  const hasInput = Object.keys(props.input).length > 0;
  const title = (
    <>
      <span className="tool-name">{props.name}</span>
      {props.detail ? <span className="tool-sum">{props.detail}</span> : null}
    </>
  );
  if (!presented.open) {
    return <div className="tool-card closed">{title}</div>;
  }
  return (
    <details className={props.is_error ? "tool-card is-error" : "tool-card"}>
      <summary>{title}</summary>
      {hasInput ? <pre className="think-body">{presented.inputText}</pre> : null}
      {presented.outputText ? <pre className="think-body">{presented.outputText}</pre> : null}
    </details>
  );
}

function Item(props: { row: FoldedRow }) {
  const { row } = props;
  const clock = formatClock(row.ts);
  let tone = "sys";
  let body: ReactNode = null;

  if (row.type === "thinking") {
    tone = "think";
    body = <div className="tl-mute">思考 · {row.n}</div>;
  } else if (row.type === "thinking_text") {
    tone = "think";
    body = (
      <details className="think-card">
        <summary>思考</summary>
        <pre className="think-body">{clipToolText(row.text)}</pre>
      </details>
    );
  } else if (row.type === "user") {
    tone = "user";
    body = (
      <div className="bubble user">
        <div className="who">你</div>
        <div className="body">{clipToolText(row.text)}</div>
      </div>
    );
  } else if (row.type === "assistant") {
    tone = "assistant";
    body = (
      <div className="bubble assistant">
        <div className="who">助手</div>
        <div className="body">
          <MdBody text={clipToolText(row.text)} />
        </div>
      </div>
    );
  } else if (row.type === "tool") {
    tone = "tool";
    body = (
      <ToolCard
        name={row.name}
        detail={row.detail}
        input={row.input}
        output={row.output}
        is_error={row.is_error}
      />
    );
  } else if (row.type === "needs_decision") {
    tone = "alert";
    body = (
      <div className="flag alert">
        <span className="k">待决定</span>
        <span>{clipToolText(row.text)}</span>
      </div>
    );
  } else if (row.type === "needs_info") {
    tone = "alert";
    body = (
      <div className="flag alert">
        <span className="k">需补充</span>
        <span>{clipToolText(row.text)}</span>
      </div>
    );
  } else if (row.type === "failed") {
    tone = "alert";
    body = (
      <div className="flag alert">
        <span className="k">失败</span>
        <span>{clipToolText(row.text)}</span>
      </div>
    );
  } else if (row.type === "dead") {
    tone = "alert";
    body = (
      <div className="flag alert">
        <span className="k">已结束</span>
        <span>{clipToolText(row.text)}</span>
      </div>
    );
  } else if (row.type === "task_done") {
    tone = "ok";
    body = (
      <div className="flag ok">
        <span className="k">任务完成</span>
        <span>{clipToolText(row.text)}</span>
      </div>
    );
  } else {
    body = (
      <details className="sys-card">
        <summary>系统 · {row.items.length}</summary>
        <ul className="sys-list">
          {row.items.map((it, j) => (
            <li key={j}>{clipToolText(it)}</li>
          ))}
        </ul>
      </details>
    );
  }

  return (
    <div className={`tl-item ${tone}`}>
      <time className="tl-time" dateTime={formatDateTimeAttr(row.ts)}>
        {clock}
      </time>
      <div className="tl-rail" aria-hidden>
        <span className="tl-dot" />
      </div>
      <div className="tl-body">{body}</div>
    </div>
  );
}

function DayHead(props: { label: string }) {
  return (
    <div className="tl-day">
      <div className="tl-time" />
      <div className="tl-rail" aria-hidden>
        <span className="tl-dot" />
      </div>
      <div className="tl-body">{props.label}</div>
    </div>
  );
}

function TurnHead(props: { turnId: number }) {
  const label = props.turnId === 0 ? "开始前" : `回合 ${props.turnId}`;
  return (
    <div className="tl-turn-head">
      <div className="tl-time" />
      <div className="tl-rail" aria-hidden>
        <span className="tl-dot" />
      </div>
      <div className="tl-body">{label}</div>
    </div>
  );
}

function renderItem(item: TimelineItem, i: number) {
  if (item.kind === "day") return <DayHead key={`d-${item.dayKey}-${i}`} label={item.label} />;
  if (item.kind === "turn-head") {
    return <TurnHead key={`t-${item.turnId}-${i}`} turnId={item.turnId} />;
  }
  return <Item key={`r-${item.turnId}-${i}`} row={item.row} />;
}

export function Transcript(props: { events: ClassifiedEvent[] }) {
  const [q, setQ] = useState("");
  const [scroll, setScroll] = useState({ scrollTop: 0, viewportHeight: 0 });
  const listRef = useRef<HTMLDivElement | null>(null);
  const items = useMemo(() => {
    const rows = foldTranscript(props.events);
    return flattenTimeline(filterGroups(groupTurns(rows), { q }));
  }, [props.events, q]);
  const viewportHeight = scroll.viewportHeight > 0 ? scroll.viewportHeight : 800;
  const win = useMemo(
    () =>
      virtualWindow({
        scrollTop: scroll.scrollTop,
        viewportHeight,
        rowHeight: DEFAULT_ROW_HEIGHT,
        count: items.length,
      }),
    [scroll.scrollTop, viewportHeight, items.length],
  );
  const visible = useMemo(() => visibleSlice(items, win), [items, win]);
  useEffect(() => {
    const top = endScrollTop({
      count: items.length,
      viewportHeight,
      rowHeight: DEFAULT_ROW_HEIGHT,
    });
    setScroll((prev) => (prev.scrollTop === top ? prev : { ...prev, scrollTop: top }));
    const el = listRef.current;
    if (el && el.scrollTop !== top) el.scrollTop = top;
  }, [q, items.length, viewportHeight]);
  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScroll({ scrollTop: el.scrollTop, viewportHeight: el.clientHeight });
  }, []);
  const onListRef = useCallback((el: HTMLDivElement | null) => {
    listRef.current = el;
    if (!el) return;
    setScroll((prev) => {
      if (prev.viewportHeight === el.clientHeight && prev.scrollTop === el.scrollTop) return prev;
      return { scrollTop: el.scrollTop, viewportHeight: el.clientHeight };
    });
  }, []);
  if (!props.events.length) {
    return <div className="transcript tiny">还没有记录。从左侧新建会话，或选择一个已有会话。</div>;
  }
  return (
    <div className="transcript timeline">
      <input
        className="tl-search"
        type="search"
        value={q}
        placeholder="过滤时间线"
        onChange={(e) => setQ(e.target.value)}
        aria-label="过滤时间线"
      />
      <div className="tl-list" role="list" onScroll={onScroll} ref={onListRef}>
        {items.length ? (
          <div className="tl-virt" style={{ height: win.totalHeight }}>
            <div className="tl-virt-window" style={{ transform: `translateY(${win.offsetTop}px)` }}>
              {visible.map((item, i) => renderItem(item, win.start + i))}
            </div>
          </div>
        ) : (
          <div className="tl-empty">没有匹配的记录</div>
        )}
      </div>
    </div>
  );
}
