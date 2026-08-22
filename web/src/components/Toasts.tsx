"use client";

export type ToastItem = { key: string; id: string; kind: string; summary: string };

export function Toasts(props: { items: ToastItem[]; onDismiss: (key: string) => void }) {
  if (!props.items.length) return null;
  return (
    <div className="toasts">
      {props.items.map((t) => (
        <div key={t.key} className="toast">
          <button type="button" aria-label="关掉" onClick={() => props.onDismiss(t.key)}>
            ×
          </button>
          <div>
            {t.kind} {t.id.slice(0, 8)}
          </div>
          <div>{t.summary}</div>
        </div>
      ))}
    </div>
  );
}
