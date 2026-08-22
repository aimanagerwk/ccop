/** P5 permission policy. Pure functions — unit-tested, no live API. */

import { existsSync, readFileSync } from "node:fs";
import { POLICY_PATH } from "./paths.js";

export type Decision = "allow" | "ask" | "deny";

export const DEFAULT_ALLOW = ["Read", "Grep", "Glob"] as const;
export const DEFAULT_BASH_SUBSTR = ["rm -rf /", "sudo "] as const;
export const DEFAULT_WRITE_PREFIXES = ["/etc", "/usr"] as const;

const REDIRECT = /(?:>>?|tee(?:\s+-a)?)\s*['"]?(\/etc(?:\/|\s|$)|\/usr(?:\/|\s|$))/i;
const COPY_DEST =
  /\b(?:cp|mv|install|dd|install\s+-m\s+\S+)\s+.+\s+['"]?(\/etc(?:\/|\s|$)|\/usr(?:\/|\s|$))/i;

export type Policy = {
  allow: string[];
  ask: string[];
  deny: {
    bash_substrings?: string[];
    write_prefixes?: string[];
    [key: string]: unknown;
  };
};

function defaultPolicy(): Policy {
  return {
    allow: [...DEFAULT_ALLOW],
    ask: ["*"],
    deny: {
      bash_substrings: [...DEFAULT_BASH_SUBSTR],
      write_prefixes: [...DEFAULT_WRITE_PREFIXES],
    },
  };
}

function minimalYaml(text: string): Policy {
  const out: Policy = {
    allow: [],
    ask: [],
    deny: { bash_substrings: [], write_prefixes: [] },
  };
  let section: string | null = null;
  let denyKey: string | null = null;
  for (const raw of text.splitlines ? (text as any).splitlines() : text.split("\n")) {
    const line = raw.split("#", 1)[0].replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (!line.startsWith(" ") && line.endsWith(":")) {
      section = line.slice(0, -1).trim();
      denyKey = null;
      continue;
    }
    const item = line.trim();
    if (item.startsWith("- ")) {
      const val = item.slice(2).trim().replace(/^['"]|['"]$/g, "");
      if (section === "allow") out.allow.push(val);
      else if (section === "ask") out.ask.push(val);
      else if (section === "deny" && denyKey) {
        const arr = (out.deny[denyKey] as string[]) || [];
        arr.push(val);
        out.deny[denyKey] = arr;
      }
    } else if (section === "deny" && item.endsWith(":")) {
      denyKey = item.slice(0, -1).trim();
      if (!out.deny[denyKey]) out.deny[denyKey] = [];
    }
  }
  return out;
}

export function loadPolicy(path?: string): Policy {
  const p = path ?? POLICY_PATH;
  if (!existsSync(p)) return defaultPolicy();
  const text = readFileSync(p, "utf8");
  const data = minimalYaml(text);
  if (!data.allow?.length) data.allow = [...DEFAULT_ALLOW];
  if (!data.ask?.length) data.ask = ["*"];
  if (!data.deny) data.deny = {};
  return data;
}

export function bashDenied(command: string, policy?: Policy | null): string | null {
  const deny = policy?.deny || {};
  const subs = (deny.bash_substrings as string[] | undefined) || [...DEFAULT_BASH_SUBSTR];
  const prefixes = (deny.write_prefixes as string[] | undefined) || [...DEFAULT_WRITE_PREFIXES];
  for (const s of subs) {
    if (command.includes(s)) return `bash substring ${JSON.stringify(s)}`;
  }
  if (REDIRECT.test(command) || COPY_DEST.test(command)) {
    return "bash write under /etc or /usr";
  }
  for (const pref of prefixes) {
    const re = new RegExp(`(>>?|tee(?:\\s+-a)?)\\s*['"]?${escapeRe(pref)}(?:/|\\s|$)`, "i");
    if (re.test(command)) return `bash write under ${pref}`;
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function decide(
  toolName: string,
  toolInput?: Record<string, unknown> | null,
  policy?: Policy | null,
): Decision {
  const input = toolInput || {};
  const pol = policy != null ? policy : loadPolicy();
  const allow = new Set((pol.allow || DEFAULT_ALLOW).map((t) => t.toLowerCase()));
  const name = toolName || "";
  if (name.toLowerCase() === "bash") {
    const reason = bashDenied(String(input.command || ""), pol);
    if (reason) return "deny";
  }
  if (allow.has(name.toLowerCase())) return "allow";
  return "ask";
}

/** PreToolUse hook output — denials that resolve before canUseTool. */
export type HookPermissionDecision = "allow" | "deny" | "ask" | "defer";

export type PreToolUseHookDecision = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: HookPermissionDecision;
    permissionDecisionReason: string;
  };
};

/**
 * Map (tool, input, lock, mode) → PreToolUse hook decision.
 * Policy deny always returns hook deny (auto classifier may skip canUseTool).
 * lock===operator must not auto-allow: ask so canUseTool can park; if the
 * SDK would skip canUseTool, ask still blocks silent proceed.
 * Empty object defers to canUseTool / classifier (in-project Write in auto).
 */
export function preToolUseHookDecision(
  tool: string,
  input: Record<string, unknown> | null | undefined,
  lock: string | null | undefined,
  mode: string,
  policy?: Policy | null,
): PreToolUseHookDecision | Record<string, never> {
  void mode;
  const decision = decide(tool, input, policy);
  if (decision === "deny") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `policy deny ${tool}`,
      },
    };
  }
  if (lock === "operator") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "held",
      },
    };
  }
  return {};
}
