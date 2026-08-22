"use client";

import type { ClassifiedEvent } from "../lib/protocol";
import { foldTranscript, type FoldedRow } from "../lib/fold-transcript";

function Row(props: { row: FoldedRow; i: number }) {
  const { row, i } = props;
  if (row.type === "thinking") {
    return (
      <div key={i} className="ev thinking mute-row">
        <span className="k">思考</span>
        <span>思考 · {row.n}</span>
      </div>
    );
  }
  if (row.type === "thinking_text") {
    return (
      <div key={i} className="ev thinking">
        <details>
          <summary>思考</summary>
          <pre className="think-body">{row.text}</pre>
        </details>
      </div>
    );
  }
  if (row.type === "user") {
    return (
      <div key={i} className="ev bubble user">
        <div className="who">你</div>
        <div className="body">{row.text}</div>
      </div>
    );
  }
  if (row.type === "assistant") {
    return (
      <div key={i} className="ev bubble assistant">
        <div className="who">助手</div>
        <div className="body">{row.text}</div>
      </div>
    );
  }
  if (row.type === "tool") {
    return (
      <div key={i} className="ev tool mute-row">
        <span className="k">工具</span>
        <span>工具 · {row.name}</span>
      </div>
    );
  }
  if (row.type === "needs_decision") {
    return (
      <div key={i} className="ev needs_decision">
        <span className="k">待决定</span>
        <span>{row.text}</span>
      </div>
    );
  }
  if (row.type === "needs_info") {
    return (
      <div key={i} className="ev needs_info">
        <span className="k">需补充</span>
        <span>{row.text}</span>
      </div>
    );
  }
  if (row.type === "failed") {
    return (
      <div key={i} className="ev failed">
        <span className="k">失败</span>
        <span>{row.text}</span>
      </div>
    );
  }
  if (row.type === "dead") {
    return (
      <div key={i} className="ev dead">
        <span className="k">已结束</span>
        <span>{row.text}</span>
      </div>
    );
  }
  if (row.type === "task_done") {
    return (
      <div key={i} className="ev task_done">
        <span className="k">任务完成</span>
        <span>{row.text}</span>
      </div>
    );
  }
  return (
    <div key={i} className="ev system mute-row">
      <details>
        <summary>系统 · {row.items.length}</summary>
        <ul className="sys-list">
          {row.items.map((it, j) => (
            <li key={j}>{it}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

export function Transcript(props: { events: ClassifiedEvent[] }) {
  const rows = foldTranscript(props.events);
  if (!props.events.length) {
    return <div className="transcript tiny">还没有记录。从左侧新建会话，或选择一个已有会话。</div>;
  }
  return (
    <div className="transcript">
      {rows.map((row, i) => (
        <Row key={i} row={row} i={i} />
      ))}
    </div>
  );
}
