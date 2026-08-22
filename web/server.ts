/** Custom Next server so the same HTTP port can proxy WS to the daemon. */

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import next from "next";
import { getHub } from "./src/lib/bridge-singleton.js";
import { attachWsHub } from "./src/lib/attach-hub.js";

const dir = dirname(fileURLToPath(import.meta.url));
const dev = process.env.NODE_ENV !== "production";
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);

const app = next({ dev, dir });
const handle = app.getRequestHandler();

await app.prepare();

const server = createServer((req, res) => {
  void handle(req, res);
});
attachWsHub(server, getHub());

server.listen(port, host, () => {
  console.log(`ccop web http://${host}:${port}`);
});
