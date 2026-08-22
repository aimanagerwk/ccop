"use client";

import type { ClassifiedEvent } from "../lib/protocol";

export function Transcript(props: { events: ClassifiedEvent[] }) {
  if (!props.events.length) {
    return <div className="transcript tiny">还没有记录。选一路会话，或从左边开会话。</div>;
  }
  return (
    <div className="transcript">
      {props.events.map((e, i) => (
        <div key={`${e.ts}-${i}`} className={`ev ${e.kind}`}>
          <span className="k">{e.kind}</span>
          <span>{e.summary}</span>
        </div>
      ))}
    </div>
  );
}
