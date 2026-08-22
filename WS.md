# ccop WebSocket 协议

远程管理客户端走这条。本地助手仍用 unix socket。worker 还在这台机器上跑，不搬。

## 1. 何时监听

`CCOP_TOKEN` 非空才听。没设 / 空字符串：不 bind，CLI 照旧。

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `CCOP_TOKEN` | （无） | 鉴权口令。不写进 git，不打日志。 |
| `CCOP_WS_HOST` | `127.0.0.1` | 远程绑 `0.0.0.0`。 |
| `CCOP_WS_PORT` | `8787` | |

`up` / `ping` / `status` 在听的时候多一个 `ws: {host, port}`，不含 token。

    CCOP_TOKEN=... CCOP_WS_HOST=0.0.0.0 npx tsx src/cli.ts up
    {"ok":true,"pid":1234,"already":false,"ws":{"host":"0.0.0.0","port":8787}}

## 2. URL

    ws://<host>:<port>/v1

只有 `/v1`。别的 path 升级失败 404。HTTP 普通请求 404。二进制帧不用。

## 3. 升级鉴权

upgrade 时带其一：

    Authorization: Bearer <token>
    x-ccop-token: <token>

和 `CCOP_TOKEN` 做 timing-safe 比较。缺或错 → **401，不升级**。

## 4. 帧

一条文本帧 = 一个 JSON 对象。请求一帧，应答一帧。可并行，用 `req_id` 对上。

`id` 在大多数 cmd 里是 **Claude session UUID**，不要拿它当请求号。请求号用 `req_id`。

## 5. 请求

    { "cmd": "<name>", "req_id": <any>, ...args }

`req_id` 可选，原样回。下面是 `Host.dispatch` 现有 cmd（不要发明）。会话键：`id`（UUID，优先）或唯一 `name`/`title`。

| cmd | 必填 | 可选 |
| --- | --- | --- |
| `ping` | | |
| `start` | `cwd`, `prompt` | `name`, `resume_id`, `permission_mode`（默认 auto） |
| `send` | `id`, `text` | |
| `interrupt` | `id` | |
| `hold` | `id` | |
| `release` | `id` | |
| `approve` | `id`, `tool_use_id` | |
| `deny` | `id`, `tool_use_id` | |
| `stop` | `id` | |
| `status` | | |
| `events` | `id` | `tail` |
| `info` | `id` | |
| `workflows` | `id` | |
| `tasks` | `id` | |
| `task-stop` | `id`, `task_id` | |
| `task-bg` | `id` | `tool_use_id` |
| `subagents` | `id` | |
| `mcp` | `id` | |
| `mcp-set` | `id`, `servers`（JSON 对象，可 `{}`） | |
| `mcp-reconnect` | `id`, `server` | |
| `mcp-toggle` | `id`, `server`, `enabled`（bool） | |
| `plugins-reload` | `id` | |
| `skills-reload` | `id` | |
| `wait` | `id` | `kinds`（数组或逗号串；默认 needs_decision,needs_info,turn_done,failed,dead）、`timeout`（秒，默认 3600） |

CLI `monitor` = `wait` + 实时事件流 + stall/PostToolUseFailure/pending；默认 kinds 含 `turn_done`。当前是本地 CLI poll，不是这条 WS dispatch 上的 cmd。
| `shutdown` | | 能用，不是远程管理的正经路径。关 daemon。 |

WS 另有（不进 unix `dispatch`）：

| cmd | 必填 | 可选 |
| --- | --- | --- |
| `watch` | | `id`（省略 = 全部会话） |
| `unwatch` | | |

## 6. 应答

成功：`{ "ok": true, "req_id": ..., ... }`  
失败：`{ "ok": false, "error": "...", "req_id": ... }`

    → {"cmd":"ping","req_id":"a1"}
    ← {"ok":true,"pid":1234,"ws":{"host":"127.0.0.1","port":8787},"req_id":"a1"}

    → {"cmd":"status","req_id":2}
    ← {"ok":true,"sessions":[...],"ws":{"host":"127.0.0.1","port":8787},"req_id":2}

听着才带 `ws`。

## 7. watch / 多窗口客户端

多窗口（几条会话，有的前台有的后台）：**开一条** `watch`，不要每窗一条。省略 `id` = 全部。不回放历史；历史用 `events`。订阅时**没有** `{type:"pending"}` 快照。

    → {"cmd":"watch","req_id":"w1"}
    ← {"ok":true,"req_id":"w1"}

之后新分类事件推：

    { "type": "event", "id": "<session-uuid>", "event": { "kind": "...", "summary": "...", "extra": {}, "ts": 1770000000.1 } }

`id` 是 session UUID。`event` 就是落盘那条（`kind` / `summary` / `extra` / `ts`，还有 `id`/`name`）。推送没有 `req_id`。没有别的 `type`。

    → {"cmd":"unwatch","req_id":"u1"}
    ← {"ok":true,"req_id":"u1"}

`watch` 带 `id` 只收那条会话。多窗口客户端用全量。

### kind（`src/classify.ts`，不要自造）

`working` · `needs_decision` · `needs_info` · `turn_done` · `task_done` · `failed` · `idle` · `held` · `dead` · `sent` · `interrupted`

没有单独的 `assistant` kind。助手 token 现在是 `kind=working` `summary=assistant`。

`turn_done` ≠ `task_done`。ResultMessage 只是一轮说完。

### 远程 UI 优先级

- **打断 / badge+toast+拉前台**：`needs_decision`（parked 工具，approve/deny）、`needs_info`（AskUserQuestion）、`failed`、`dead`
- **后台只 badge；前台流进当前窗**：`turn_done`（新一轮助手）、`task_done`、`working`（工具 / assistant / task 进度）
- **不当告警**：`sent`、`idle`、`interrupted`、`held`（顶栏状态即可）

## 8. 不在协议里

- token 不进日志、不进 git、不进 JSON 应答。
- unix socket 还是本机 CLI。
- `shutdown` 存在，但远程别当正常下班按钮。
- 不发明 dispatch 没有的 cmd，不发明 classify 没有的 kind。
- 二进制帧、HTTP API、query string 带 token：都没有。

## 9. 最小客户端

```ts
import WebSocket from "ws";

const token = process.env.CCOP_TOKEN!;
const ws = new WebSocket("ws://127.0.0.1:8787/v1", {
  headers: { Authorization: `Bearer ${token}` },
});

ws.on("open", () => {
  ws.send(JSON.stringify({ cmd: "ping", req_id: 1 }));
  ws.send(JSON.stringify({ cmd: "status", req_id: 2 }));
  ws.send(JSON.stringify({ cmd: "watch", req_id: 3 }));
});

ws.on("message", (data) => {
  const msg = JSON.parse(String(data));
  if (msg.type === "event") {
    // msg.id, msg.event.kind
    return;
  }
  // reply: msg.ok, msg.req_id
});
```
