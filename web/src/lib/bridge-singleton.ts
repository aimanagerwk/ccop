/** One CcopWsBridge on globalThis across Next hot reload. */

import { CcopWsBridge } from "./ws-proxy";

const GLOBAL_KEY = "__ccop_ws_bridge__";

type Holder = typeof globalThis & { [GLOBAL_KEY]?: CcopWsBridge };

export function getBridge(): CcopWsBridge {
  const g = globalThis as Holder;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new CcopWsBridge();
  return g[GLOBAL_KEY];
}
