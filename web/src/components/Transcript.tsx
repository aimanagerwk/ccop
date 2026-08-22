"use client";

import type { ClassifiedEvent } from "../lib/protocol";

export function Transcript(props: { events: ClassifiedEvent[] }) {
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
