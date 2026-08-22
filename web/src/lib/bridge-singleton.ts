/** One BridgeHub on globalThis across Next hot reload. */

import { BridgeHub } from "./bridge-hub";
import type { CcopWsBridge } from "./ws-proxy";

const GLOBAL_KEY = "__ccop_ws_hub__";

type Holder = typeof globalThis & { [GLOBAL_KEY]?: BridgeHub };

export function getHub(): BridgeHub {
  const g = globalThis as Holder;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new BridgeHub();
  return g[GLOBAL_KEY];
}

/** Active / first connected bridge (legacy single-socket callers). */
export function getBridge(): CcopWsBridge {
  return getHub().primary();
}
