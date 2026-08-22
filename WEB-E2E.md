# WEB-E2E

Live results against the existing ccop WebSocket (127.0.0.1:8787) and the web/ Next.js proxy.
A row is only PASS if that case actually ran and matched the expected outcome.

| case | result | detail |
| --- | --- | --- |
| reject missing token | PASS | HTTP/1.1 401 Unauthorized |
| reject wrong token | PASS | HTTP/1.1 401 Unauthorized |
| Bearer connect ping | PASS | {"ok":true,"pid":158627,"ws":{"host":"127.0.0.1","port":8787},"req_id":"ping-b"} |
| x-ccop-token connect | PASS | {"ok":true,"pid":158627,"ws":{"host":"127.0.0.1","port":8787},"req_id":"ping-x"} |
| watch plus start hello-cc and see events | PASS | id=8d73892c-6b6f-46a5-bfdc-50f1af87496a kinds=sent,working |
| approve or deny if parked | PASS | denied tool_use_id=call-4fd58dbd-be40-4a91-98e1-d8e92bc64206-0 allowed=false ok=true last_kind=needs_decision state=needs_decision |
| web proxy connect | PASS | GET /api/health 200 connected=false; POST /api/connect 200 ok ping_ok; GET /api/health 200 connected=true target=127.0.0.1:8787; POST /api/rpc ping 200 ok pid=158627 ws=127.0.0.1:8787 req_id=2 leaked=false |

Ran: 2026-08-22T18:40:20Z

First proxy attempt (same session, before import fix) was HTTP 500: Next could not resolve `.js` imports of the TypeScript bridge. After dropping those extensions / adding webpack `extensionAlias`, the case was re-run against the same live daemon (pid 158627, not restarted) and passed as above.

Daemon left running. Token never written here.
