# ccop web

Operator UI for the daemon WebSocket. Protocol: [../WS.md](../WS.md).

Not a product. Token stays on the Node process that runs `server.ts` (POST `/api/connect`). Do not commit `.env` or tokens.

    # daemon (listens only when CCOP_TOKEN is set)
    CCOP_TOKEN=... CCOP_WS_HOST=127.0.0.1 CCOP_WS_PORT=8787 npx tsx src/cli.ts up

    cd web
    npm install
    npm run dev          # 127.0.0.1:3000 — paste the same token in the form

Same-origin `/api/ws` and `/v1` upgrade to the daemon using the stored token. Browser never sends the header.

`scripts/web-e2e.mjs` pings via `status` first, reuses a live daemon, and only `up`s if unreachable — it never runs `ccop down`.
