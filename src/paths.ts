/** Filesystem layout for the operator. */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DATA = join(ROOT, "data");
export const EVENTS = join(DATA, "events");
export const SESSIONS_PATH = join(DATA, "sessions.json");
export const POLICY_PATH = join(DATA, "policy.yaml");
export const SOCK_PATH = join(DATA, "ccop.sock");
export const PID_PATH = join(DATA, "daemon.pid");
export const LOG_PATH = join(DATA, "daemon.log");
export const CLI_PATH = "/home/box/.local/bin/claude";
export const PERMISSION_TIMEOUT_S = 3600;

export function ensureData(): void {
  mkdirSync(DATA, { recursive: true });
  mkdirSync(EVENTS, { recursive: true });
}
