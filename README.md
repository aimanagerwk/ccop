# ccop

内部控制面（internal Agent SDK host）。**给助手操作，不是给用户当面跑的产品。** 没有 TUI，没有像素，没有「打开 Claude Code 窗口」。命令行只吐一行 JSON。

助手用 JSON CLI 驱动常驻 daemon；daemon 持有活的 Agent SDK 客户端（ClaudeSDKClient / query），按 Claude session UUID 隔离，权限走 allow/ask/deny，事件写在 data/ 里供 Read。

    npx tsx src/cli.ts <cmd> ...
    npm start -- <cmd> ...
    npm run up

P1-P8 writeup: DESIGN.md (do not shorten). README keeps commands and JSON only.

## 1. 这是什么 / 不是什么

是：助手的控制面（JSON in / JSON out）；一个 Node 进程拥有多条 live session；unix socket RPC + data/sessions.json + data/events/<id>.jsonl；同一套引擎官方 @anthropic-ai/claude-agent-sdk（默认 settingSources: user+project+local，会读 ~/.claude）。

不是：用户产品、营销 CLI；每次 claude -p 再起一个一次性进程；tmux attach、交互键盘、TUI；另一套自研 agent。

P1 已接受的缺口：这个进程没有 claude --bg 那种 TUI attach。要看交互画面，只能另开 claude --bg，且不能和本 host 抢同一条 live session 的键盘。


## 2. 身份：id / title / name

三条东西不要混。P1-P8 的问题清单在 DESIGN.md。

- **id**：Claude session UUID。start 生成并作为 SDK options.sessionId。resume / --resume-id 用同一个 UUID。这是唯一主键。sdk_session_id 与 id 相同。
- **title**：Claude 自己的标题（SDKSessionInfo.customTitle / summary）。status 展示。不是 key。
- **name**：可选操作者标签（start --name / -n）。只是展示，可映射到 SDK title / renameSession。重复允许。不要当 key。永不因 name 已存在而拒绝 start。

若传入的不是 id、但唯一命中一条会话的 name 或 title，MAY 解析；2+ 条则 error=ambiguous name 并带回 ids。优先传 id。

## 3. 机制

    助手 CLI (JSON stdout)
            |  unix socket  data/ccop.sock
            v
       daemon (tsx src/cli.ts _serve)
            |  每个 Claude session UUID 一个 Session
            v
      ClaudeSDKClient / query()  -- canUseTool -- policy allow|ask|deny
            |                         |
            |                         + park Future 直到 approve/deny
            v
      classify -> data/events/<id>.jsonl
               -> data/sessions.json（按 id 索引）

一次 turn 的流向（散文）：

1. 助手 start --cwd DIR --prompt TEXT [--name LABEL] [--resume-id UUID]
2. daemon 生成或沿用 UUID，options.sessionId / resume 交给活客户端
3. 模型要跑 Write/Bash 等：policy=ask（或 hold 下的 allow）→ park canUseTool，写 needs_decision
4. 助手 status / events ID，看到 pending.tool_use_id
5. approve ID tool_use_id → PermissionResultAllow（deny 则 PermissionResultDeny）
6. 模型跑完该 turn，ResultMessage → turn_done（再 idle 或 failed）。这不是 task_done。

hold 时：send 立刻 {ok:false,error:"held"}；即使 Read 也会 park（reason=held）。

```mermaid
sequenceDiagram
  participant A as assistant CLI
  participant D as daemon
  participant S as Agent SDK
  A->>D: start --cwd --prompt [--name]
  D->>S: sessionId=UUID / query(prompt)
  S-->>D: tool ask
  D->>D: park canUseTool
  A->>D: approve ID tool_use_id
  D->>S: PermissionResultAllow
  S-->>D: ResultMessage
  D->>D: turn_done not task_done
```

## 4. 命令参考

统一：成功/失败都是一行 JSON。ok:false 时退出码 1。

远程 WS（`CCOP_TOKEN` 才听）：协议见 [WS.md](./WS.md)。

在 /workspace/ccop 跑 `npx tsx src/cli.ts <cmd>`（等价 `npm start -- <cmd>`；`npm run up` 只拉 daemon）。ID 是 Claude session UUID。

- `up` — 拉起 daemon。已在跑则 {already:true}。
- `down` — 关掉 daemon，卸 socket。
- `start --cwd DIR --prompt TEXT [--name LABEL] [--resume-id UUID] [--permission-mode MODE]` — 开一条 live session，或按 UUID resume。默认 auto、max、workflow 开。
- `send ID TEXT` — 往活会话再塞一轮。hold 时立刻 {error:held}。
- `interrupt ID` — 打断当前 turn。
- `hold ID` — 操作者锁：挡 send，连 Read 也 park，不自动放行。
- `release ID` — 解开 hold。
- `stop ID` — 关掉这条 live 客户端，记录还在，可 resume。
- `approve ID tool_use_id` — 放行一条 parked 工具。
- `deny ID tool_use_id` — 拒绝一条 parked 工具。
- `status` — 列出全部会话：活/死、lock、pending、用量、skills。
- `events ID [--tail N]` — 读这条会话的分类事件，可 tail。
- `wait ID [--kind a,b] [--timeout SEC]` — 阻塞直到**之后**出现 wake kind（默认 `needs_decision,needs_info,turn_done,failed,dead`）。已死立刻 `{ok:true,woke:"dead"}`；已有 pending 且 kinds 含 `needs_decision` 立刻返回 pending。超时 `{ok:false,error:"wait timeout"}` 退出 1。当前 daemon 若无 wait RPC，CLI 每 ~400ms poll `events`/`status`。
- `monitor ID [--kind a,b] [--timeout SEC] [--stall SEC]` — **wait + live event stream**：同样的未来事件规则，默认 kinds 与 wait 相同（含 `turn_done`，做完一轮会醒）。等待期间每条新事件一行 JSON；再打一行最终 `{ok:true,id,woke,reason,event?}` 后退出 0。额外 odd wake：`PostToolUseFailure`（summary/hook）、`--stall` 秒无新事件且仍活着（默认 180）、pending 工具。超时 `{ok:false,error:"monitor timeout"}` 退出 1。CLI poll，不重启 daemon。
- `info ID` — 单会话快照：effort、workflow、用量、skills、plugins，便宜时带 mcp_servers。
- `workflows ID` — 列出 session 广告过的 skills / slash / plugins。host 不 invoke。
- `tasks ID` — 列出 SDK 任务。
- `task-stop ID TASK_ID` — 停掉一条任务。
- `task-bg ID [tool_use_id]` — 把当前或指定工具转后台。
- `subagents ID` — 列出这条会话上的子代理。
- `mcp ID` — 当前 MCP server 状态。
- `mcp-set ID --json '{...}'` — 动态改 MCP 配置，也可 stdin JSON。空对象合法。
- `mcp-reconnect ID SERVER` — 重连一台 MCP server。
- `mcp-toggle ID SERVER --on|--off` — 开或关一台 MCP server。
- `plugins-reload ID` — 热加载插件。
- `skills-reload ID` — 热加载 skills。

例 up/down：

    {"ok": true, "pid": 1234, "already": false}
    {"ok": true, "pid": 1234, "already": true}
    {"ok": true}

例 start：

    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "name": "smoke", "title": null, "sdk_session_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7"}
    {"ok": false, "error": "session 7c9e6679-7425-40de-944b-e07fc1f90ae7 already live"}
    {"ok": false, "error": "connect failed: ..."}

例 send（含 hold）：

    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "name": "smoke"}
    {"ok": false, "error": "held"}
    {"ok": false, "error": "session not live"}

例 误用重复 name（优先传 id）：

    {"ok": false, "error": "ambiguous name", "ids": ["7c9e6679-7425-40de-944b-e07fc1f90ae7", "11111111-1111-1111-1111-111111111111"]}


例 hold / release / interrupt / stop：

    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "name": "smoke", "lock": "operator"}
    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "name": "smoke", "lock": null}
    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7"}

例 approve / deny：

    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "name": "smoke", "tool_use_id": "toolu_...", "allowed": true}
    {"ok": false, "error": "no pending toolu_..."}

例 status（每行必有 cost_usd、token 合计、model_usage；历史会话可为 null）：

    {"ok": true, "sessions": [{"id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "name": "smoke", "title": "Create hello.py", "cwd": "/workspace/hello-cc", "alive": true, "lock": null, "sdk_session_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "effort": "max", "enable_workflows": true, "pending": [{"tool_use_id": "...", "tool": "Write", "reason": "ask"}], "last_turn": null, "last_task": null, "cost_usd": 0.12, "input_tokens": 150, "output_tokens": 28, "cache_read_input_tokens": 6, "cache_creation_input_tokens": 3, "model_usage": {"claude-opus": {"inputTokens": 100, "outputTokens": 20, "cacheReadInputTokens": 5, "cacheCreationInputTokens": 3, "costUSD": 0.1}}, "skills": ["pdf"], "slash_commands": ["/compact"], "plugins": []}]}

cost_usd 是 SDK 估算（ResultMessage.total_cost_usd，流式 query() 取最新一条，不要相加），不是 otomianai 账单。自定义 gateway 可能是 $0 或 Anthropic 标价。token 合计来自 modelUsage（主循环 + Task 子代理 + sidechain + compaction + Workflow），不是单轮 usage。

例 info / workflows：

    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "effort": "max", "enable_workflows": true, "skills": ["pdf"], "slash_commands": ["/compact"], "plugins": [], "mcp_servers": [], "usage": {"cost_usd": 0.12, "model_usage": {}, "last_turn_usage": {}, "updated_ts": 1770000000.1}, "cost_usd": 0.12, "input_tokens": 150, "output_tokens": 28, "cache_read_input_tokens": 6, "cache_creation_input_tokens": 3, "model_usage": {}}
    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "skills": ["pdf"], "slash_commands": ["/compact"], "plugins": [], "note": "listed from session advertise (init); host does not invoke workflows — the model does"}

没有单独的 invoke-workflow RPC。settingSources 已是 user+project+local，磁盘上的 Claude Code dynamic workflows 由模型自己触发；host 只列出 session 广告过的 skills / slash_commands / plugins。

例 tasks / task-stop / task-bg / subagents：

    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "tasks": [{"task_id": "t1", "tool_use_id": "toolu_...", "status": "running", "summary": "explore", "usage": {"total_tokens": 10}}]}
    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "task_id": "t1"}
    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "backgrounded": true, "tool_use_id": null}
    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "source": "sdk", "subagents": ["agent-..."]}
    {"ok": false, "error": "stopTask is not available on this client (Python-shaped / no Query.stopTask)"}

例 mcp / mcp-set / mcp-reconnect / mcp-toggle / plugins-reload / skills-reload（都是活 Query 方法，不是 host 自造 token）：

    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "servers": []}
    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "result": {"added": [], "removed": [], "errors": {}}}
    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "server": "github"}
    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "server": "github", "enabled": false}
    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "result": {"commands": [], "agents": [], "plugins": [], "mcpServers": [], "error_count": 0}}
    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "result": {"skills": []}}
    {"ok": false, "error": "mcpServerStatus is not available on this client (Python-shaped / no Query.mcpServerStatus)"}

`mcp-set` 把 JSON 对象交给 Query.setMcpServers。空对象 `{}` 合法，只清动态加的 server，不会卸掉 plugin 拥有的 server。`info ID` 在活客户端上便宜时带 `mcp_servers` 快照。

例 events：

    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "events": [{"ts": 1770000000.1, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "name": "smoke", "kind": "sent", "summary": "...", "extra": {}}, {"kind": "needs_decision", "summary": "can_use_tool parked Write"}, {"kind": "turn_done", "summary": "result message (turn, not task)"}]}

例 wait（只认 ts 大于 wait 开始时最新事件的未来事件；session 已死 / 不 live：立刻 woke=dead）：

    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "woke": "turn_done", "event": {"ts": 1770000001.0, "kind": "turn_done", "summary": "result message (turn, not task)", "extra": {}}}
    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "woke": "needs_decision", "event": {"kind": "needs_decision"}, "pending": [{"tool_use_id": "toolu_...", "tool": "Write", "reason": "ask"}]}
    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "woke": "dead", "event": {"kind": "dead", "summary": "session not live"}}
    {"ok": false, "error": "wait timeout"}

例 monitor（先流新事件，最后一行才是 wake；`turn_done` 会停，不是只跟不醒）：

    {"ts": 1770000000.2, "kind": "working", "summary": "tool Bash", "extra": {}}
    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "woke": "turn_done", "reason": "turn_done", "event": {"ts": 1770000001.0, "kind": "turn_done", "summary": "result message (turn, not task)", "extra": {}}}
    {"ok": true, "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "woke": "stall", "reason": "stall"}
    {"ok": false, "error": "monitor timeout"}

daemon 不可达：

    {"ok": false, "error": "daemon not reachable: ..."}

## 5. 明确没有解决的

- TUI attach / 像素 / tmux。要交互画面用 claude --bg，那是另一条进程。
- 和真人同时独占 --bg 键盘。不要对同一条 live --bg 会话再 send 或 -p --resume。
- 不是用户产品。不要写安装教程给终端用户。
- 不提交 data/ 里的 sock/pid/log/sessions/events，也不提交 secrets / ~/.claude。
- 没有 invoke-workflow RPC（模型自己触发）。没有从 ~/.claude/projects jsonl 回填用量当真相源。

## 6. TypeScript 之后怎么跑

要求 Node 20+。在 /workspace/ccop：

    npm install
    npm test
    npx tsx src/cli.ts up
    npx tsx src/cli.ts status
    npx tsx src/cli.ts start --cwd DIR --prompt TEXT [--name LABEL]
    npx tsx src/cli.ts events ID --tail 20
    npx tsx src/cli.ts down

可选：npx tsx scripts/check_sdk.ts ； npx tsx scripts/boot_check.ts ； npx tsx scripts/smoke.ts（smoke 会打真模型，需要本机已有 Claude 凭据）。

默认 settingSources 是 user + project + local，因此会读 ~/.claude，除非调用方改隔离。CLI 二进制默认 pathToClaudeCodeExecutable=/home/box/.local/bin/claude（与原先 Python 一致）；SDK 也自带平台 binary。

落盘路径不变：/workspace/ccop/data/ 。sessions.json 按 Claude session UUID 索引；事件文件是 data/events/<id>.jsonl。

## 7. 默认 max + dynamic workflow（硬编码）

每条 session 的 query options **写死**，不跟设置开关：

    enableWorkflows: true
    effort: "max"
    ultracode: false

不要用 ultracode 布尔（那会锁 xhigh）。dynamic workflow 永远开。`max` 不能写进 settings.json 的 effortLevel（那边最高 xhigh），所以必须由 host 传入。


默认 `permissionMode: auto`。可用 `--permission-mode default` 对照。hold 仍会停；策略 deny 仍直接拒。
