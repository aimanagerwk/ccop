"use client";

import { memo, useMemo, type ReactNode } from "react";
import type { ClassifiedEvent } from "../lib/protocol";
import { foldTranscript, toolCardPresentation, type FoldedRow } from "../lib/fold-transcript";
import { parseMdLite } from "../lib/md-lite";
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
        <pre className="think-body">{row.text}</pre>
      </details>
    );
  } else if (row.type === "user") {
    tone = "user";
    body = (
      <div className="bubble user">
        <div className="who">你</div>
        <div className="body">{row.text}</div>
      </div>
    );
  } else if (row.type === "assistant") {
    tone = "assistant";
    body = (
      <div className="bubble assistant">
        <div className="who">助手</div>
        <div className="body">
          <MdBody text={row.text} />
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
        <span>{row.text}</span>
      </div>
    );
  } else if (row.type === "needs_info") {
    tone = "alert";
    body = (
      <div className="flag alert">
        <span className="k">需补充</span>
        <span>{row.text}</span>
      </div>
    );
  } else if (row.type === "failed") {
    tone = "alert";
    body = (
      <div className="flag alert">
        <span className="k">失败</span>
        <span>{row.text}</span>
      </div>
    );
  } else if (row.type === "dead") {
    tone = "alert";
    body = (
      <div className="flag alert">
        <span className="k">已结束</span>
        <span>{row.text}</span>
      </div>
    );
  } else if (row.type === "task_done") {
    tone = "ok";
    body = (
      <div className="flag ok">
        <span className="k">任务完成</span>
        <span>{row.text}</span>
      </div>
    );
  } else {
    body = (
      <details className="sys-card">
        <summary>系统 · {row.items.length}</summary>
        <ul className="sys-list">
          {row.items.map((it, j) => (
            <li key={j}>{it}</li>
          ))}
        </ul>
      </details>
    );
  }

  return (
    <div className={`tl-item ${tone}`}>
      <time className="tl-time" dateTime={row.ts != null ? String(row.ts) : undefined}>
        {clock}
      </time>
      <div className="tl-rail" aria-hidden>
        <span className="tl-dot" />
      </div>
      <div className="tl-body">{body}</div>
    </div>
  );
}

export function Transcript(props: { events: ClassifiedEvent[] }) {
  const rows = useMemo(() => foldTranscript(props.events), [props.events]);
  if (!props.events.length) {
    return <div className="transcript tiny">还没有记录。从左侧新建会话，或选择一个已有会话。</div>;
  }
  return (
    <div className="transcript timeline" role="list">
      {rows.map((row, i) => (
        <Item key={i} row={row} />
      ))}
    </div>
  );
}
