"use client";

import type { SessionRow } from "../lib/protocol";

export function SessionList(props: {
  sessions: SessionRow[];
  selected: string | null;
  badges: Record<string, number>;
  onSelect: (id: string) => void;
}) {
  return (
    <div>
      <h2>sessions</h2>
      {props.sessions.length === 0 ? <div className="meta">none</div> : null}
      {props.sessions.map((s) => {
        const label = s.title || s.name || s.id.slice(0, 8);
        const pending = s.pending?.length ?? 0;
        return (
          <div
            key={s.id}
            className={`sess${props.selected === s.id ? " on" : ""}`}
            onClick={() => props.onSelect(s.id)}
          >
            <div>
              {label}
              {props.badges[s.id] && props.selected !== s.id ? <span className="badge" /> : null}
            </div>
            <div className="meta">
              {s.alive ? "live" : "dead"}
              {s.lock ? ` lock=${s.lock}` : ""}
              {pending ? ` pending=${pending}` : ""}
              <div>{s.id}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
