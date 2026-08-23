/** Minimal inline markdown: bold, code, line breaks. Escapes as React-safe tokens. */

export type MdPart = { t: "text" | "code" | "bold" | "br"; v?: string };

export function parseMdLite(src: string): MdPart[] {
  const parts: MdPart[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i) parts.push({ t: "br" });
    pushInline(parts, lines[i]);
  }
  return parts;
}

const INLINE_RE = /(`+)([^`]*?)\1|\*\*(.+?)\*\*/g;

function pushInline(parts: MdPart[], line: string): void {
  const re = INLINE_RE;
  re.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > last) parts.push({ t: "text", v: line.slice(last, m.index) });
    if (m[2] != null) parts.push({ t: "code", v: m[2] });
    else if (m[3] != null) parts.push({ t: "bold", v: m[3] });
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push({ t: "text", v: line.slice(last) });
}
