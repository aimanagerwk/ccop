# ccop 设计说明：今天提的问题，一条一条怎么解

这份文件只回答一件事：早上列的控制面缺口，以及后来补的几条，**各自到底是什么问题、错的做法是什么、现在怎么做、还缺什么**。

命令怎么敲、JSON 长什么样，看 [README.md](./README.md)。  
实现在 `src/`。这不是给终端用户看的产品说明书。

---

## 先说总原则

要管的是「和 Claude Code **同一套引擎** 的活会话」，不是再包一个 chatbot。

两条产品线故意拆开，不混在一个进程里：

1. **程序化派活**：本仓库。Agent SDK（`query()` / 活客户端），JSON 进出，助手自己开、塞、放行。
2. **人要盯 TUI**：只用官方 `claude --bg`，人用 `claude attach` 进同一会话。本进程不提供 TUI，也不模拟键盘、不点像素、不 tmux 灌键。

`-p` 只留给一次性冒烟。它一轮就退，权限和提问不会停等，不能当控制面。

查找键用 **Claude 自己的 session UUID**，不用我们发明的 NAME。展示名用 Claude 自己的标题（`/resume` 列表里那行，`summary` / 自动摘要 / `/rename` 的 `customTitle`）。

---

## P1 运行时拓扑：谁拥有这条会话？

**问题**  
TUI、`claude --bg`、`claude -p`、Agent SDK 看起来都能「开 Claude」，但它们不是同一种进程。混用的时候：谁活着、谁能塞下一句、人能不能 attach，全说不清。

**错的做法**  
- 用 `-p` 当交互宿主（进程立刻退，决策 UI 不会停）。  
- 对已经在跑的 `--bg` 再 `-p --resume`（官方会说 transcript already open）。  
- 用桌面点像素 / tmux 灌键「假装」在 TUI 里打字。  
- 指望 SDK 进程能 `claude attach`（SDK 没有 TUI）。

**现在怎么解**  
程序化宿主 = 本 daemon 里的 Agent SDK 活连接。一个 Node 进程持有多路会话。  
人要画面 = 另开 `claude --bg`，和本 host **不要**抢同一条 live session 的键盘。

**还故意没做**  
本进程没有 attach、没有交互画面。这是接受的缺口，不是还没写完的功能。

---

## P2 事件总线：做完了 / 要你决定 / 还缺信息

**问题**  
模型的 stdout、Stop、Result、hook、权限提示糊在一起。助手只能猜「它是做完了还是在等我」。

**错的做法**  
把某一条 stdout 或 `Stop` 当任务完成。没有落盘，断线就没了。

**现在怎么解**  
hook（PreToolUse、PermissionRequest、PostToolUse、Stop、SubagentStop、Notification 等）加上 `canUseTool` 挂起，经过 `classify` 写成几种 **kind**，追加到 `data/events/<sessionId>.jsonl`：

| kind | 意思 |
| --- | --- |
| `needs_decision` | 工具被策略拦住，等 `approve` / `deny` |
| `needs_info` | 还缺人才能给的信息（问句一类） |
| `turn_done` | 这一轮模型说完了（ResultMessage） |
| `task_done` | 只有明确的任务完成通知才标（例如 task notification `completed`） |
| `sent` / 其它 | 过程记录 |

助手用 `status` / `events` 读文件，不靠抠屏幕。

**还故意没做**  
没有做成给用户点的 GUI。两路（hook 与 `claude agents --json`）对齐才标状态，那是 `--bg` TUI 路的事；SDK 路以本文件为准。

---

## P3 往活会话塞话

**问题**  
已经在跑的会话，怎样再送一句，而且是官方路径。

**错的做法**  
- `-p --resume` / `-r` 怼进活着的 `--bg`（transcript already open）。  
- 没有 `claude send <id>` 就改用 tmux/键盘/像素。  
- 每次新开一个 `-p` 进程，冒充「同一条会话」。

**现在怎么解**  
`send` 只打进 **本 daemon 已经持有的** 那条 SDK 活客户端（`query()` 流式输入）。会话按 Claude 的 session UUID 找。

**还故意没做**  
不能往一条别人正在 `attach` 的 `--bg` TUI 里塞字。那条路没有官方 send；人在里面时助手停发。

---

## P4 控制权锁：人和助手别同时动手

**问题**  
助手在发、策略在自动放行、人可能也要介入。没有锁就会抢。

**错的做法**  
没有互斥。或者「人 attach 了还继续自动 allow」。

**现在怎么解**  
`hold` 把该会话标成 `lock=operator`：  
1. `send` 立刻失败，返回 `held`；  
2. 本来会 auto-allow 的工具也 park，等 `approve`/`deny`。  
`release` 清锁。

**还故意没做**  
和真人抢 `--bg` TUI 键盘的操作系统级锁没有。约定：人 attach 那条 `--bg` 时，助手不要对同一 id 再 send。

---

## P5 放行策略：不能全家 bypass

**问题**  
`bypassPermissions` / 全放行等于把门卸了。用户要的是和自己点 TUI 时一样：该问的问，危险的拒。

**错的做法**  
为了「跑通」把 permissionMode 调成 bypass。

**现在怎么解**  
`permissionMode: auto`（默认）。分类器先判；策略 deny 仍直接拒；hold 仍 park。自有 policy（`src/policy.ts`，可被 `data/policy.yaml` 覆盖）：

- **allow**：Read / Grep / Glob（未 hold 时自动过）  
- **ask**：Write / Edit / Bash 等，挂起等 `approve` / `deny`（按 `tool_use_id`）  
- **deny**：`rm -rf /`、`sudo`、往 `/etc` `/usr` 写

超时或取消视为 deny。单元测试覆盖分类和策略。

**还故意没做**  
没有「永远允许这一类」的悄悄升级，除非以后单独加、并且写进事件。

---

## P6 进度真话：停嘴 ≠ 交差

**问题**  
SDK 的 `ResultMessage`、hook 的 `Stop`，只表示这一轮结束。当成「整个任务做完」会谎报。

**错的做法**  
`Stop` / Result 一到就标完成，去开下一件。

**现在怎么解**  
分类器把 Result 标成 `turn_done` only。  
`sessions` 里 `last_turn` 和 `last_task` 分开。  
`task_done` 只来自明确的任务完成通知，不来自 Stop。

**还故意没做**  
助手仍要自己看产物/测试/事件，判断「活干没干完」。控制面不替你编一个假的 Definition of Done。

---

## P7 多路隔离

**问题**  
并行好几路开发时，权限、事件、cwd 会互相踩。用「名字」当键，重名并不少见。

**错的做法**  
一条全局会话。或者用我们发明的 NAME 当主键（hello / smoke 这种会撞）。

**现在怎么解**  
一路会话一块布：自己的活客户端、pending、事件文件、cwd。  
**主键 = Claude 的 session UUID**（`start` 时用 SDK `sessionId` 指定，或从首条系统消息读取；`resume` 用同一个 UUID）。  
Claude 自己的标题只做展示，不参与查找。不再要求助手起 NAME。

**还故意没做**  
不把展示标题当唯一键。标题本来就可以重复、也可以事后被 `/rename`。

---

## P8 生命周期：进程死了，会话还在不在

**问题**  
daemon 挂了、机器重启了，活连接没了。会话号和事件如果只在内存里，就全没了。

**错的做法**  
每次新开就当新会话。没有 pid/socket，没有落盘，不能 resume。

**现在怎么解**  
`up` / `down` 管 daemon（unix socket + pid + log）。  
`data/sessions.json` 和 `data/events/<sessionId>.jsonl` 落盘（不提交到 git）。  
`start --resume-id <uuid>`（或等价）按 Claude 的 session UUID 把 SDK 会话接回来。

**还故意没做**  
daemon 挂掉的那几秒，内存里没批完的 `canUseTool` Future 会丢，需要人再看 pending / 再开。不是自动热迁移。

---

## 今天后来补的几条

### 不要做成给用户自己跑的 CLI

这是助手的内部控制面。JSON 进出是为了我用 Shell 操作，不是再发一个产品。README 不写安装营销。

### 不要用 Python 当给人看的源码

官方 Agent SDK 本来就是 TypeScript。源码在 `src/`，测试 vitest。Python 已删除。

### NAME 参数作废的原因

NAME 当初是给我自己当短把手，避免抄 UUID。名字会撞，而且 **Claude 已经会给会话起展示名、已经有 UUID**。再发明一套名字是叠床架屋。  
查找、resume、事件文件名，一律 Claude session UUID。标题跟 Claude。

### TUI 那条线为什么还在文档里

用户要能自己跳进画面盯。那只能走官方 `--bg` + `attach`。本仓库不假装已经解决 attach。两条线不要接到同一个 live 进程上。

---

## 一张对照表

| 编号 | 问题 | 解法 | 未解 |
| --- | --- | --- | --- |
| P1 | 谁是宿主 | SDK daemon 程序化；`--bg` 给人 attach | 本进程无 TUI |
| P2 | 完成/决策/缺信息混在一起 | 分类后落盘 events | 无 GUI |
| P3 | 往活会话塞话 | 只对已持有的 SDK 客户端 `query()` | 不能灌 `--bg` TUI |
| P4 | 抢控制权 | `hold`/`release` | 无 OS 级 TUI 键盘锁 |
| P5 | 全家 bypass | allow/ask/deny + 按条批准 | 无静默 always-allow |
| P6 | Stop 当交差 | `turn_done` ≠ `task_done` | 完成仍要看产物 |
| P7 | 并行踩踏、名字碰撞 | Claude session UUID 隔离 | 标题不当键 |
| P8 | 进程挂了状态没了 | 落盘 + resume UUID | 未批权限不热迁移 |

---

## 一次 turn 实际怎么走

1. `up` 拉起 daemon。  
2. `start --cwd DIR --prompt TEXT`：生成/使用 Claude session UUID，连上 SDK，把第一句交给活客户端。  
3. 模型要 Write/Bash：policy=ask → park，事件 `needs_decision`。  
4. `status` / `events <uuid>` 看到 `pending.tool_use_id`。  
5. `approve <uuid> <tool_use_id>` 或 `deny`。  
6. 模型说完：Result → `turn_done`。这不是任务完成。  
7. 真要停：`stop <uuid>`。整机收工：`down`。

人要自己看画面：不要用本进程，去开 `claude --bg`，用官方 attach。


---

## P-note（后补）：用量、workflow、子代理 / 后台任务

**曾经**  
`status` 不带 token / cost。workflow、subagent、background task 只当事件观察（classify + events），没有 list / stop / background。

**现在**  
ResultMessage 到来时把最新一条（不要相加）写入 session.usage：`cost_usd` = `total_cost_usd`，`model_usage` = `modelUsage`（正确账本），`last_turn_usage` = 主循环 `usage`。`status` 每行带 `cost_usd`、modelUsage 合计 tokens、`model_usage`。这是 SDK 估算，不是账单。历史会话可以 usage=null。

session init 广告的 `skills` / `slash_commands` / `plugins` 落盘；`workflows` / `info` 列出它们。host 不调用 workflow。

从 `task_notification` / `task_started` / `task_progress` / `background_tasks_changed` 和 SubagentStart/Stop hook 跟踪任务。CLI：`tasks` / `task-stop` / `task-bg` / `subagents`。`stopTask` / `backgroundTasks` 走活 Query；Python 形客户端没有这些方法时返回明确错误。`listSubagents` 优先 SDK，否则用跟踪列表。

每条 session **硬编码** `effort: "max"` + `enableWorkflows: true`（`ultracode: false`）。dynamic workflow 一直开，不做成可关选项。

### Host-gap：MCP / plugins / skills 是活 Query，不是自造 token

Query 已有 `mcpServerStatus` / `setMcpServers` / `reconnectMcpServer` / `toggleMcpServer` / `reloadPlugins` / `reloadSkills`。host 只是把它们绑到 LiveClient（缺方法时与 `stopTask` 同样的明确错误），再暴露 CLI：`mcp`、`mcp-set`、`mcp-reconnect`、`mcp-toggle`、`plugins-reload`、`skills-reload`。

`setMcpServers` 走当前会话的 SDK Query，不发明 MCP token、不写 secrets。空对象 `{}` 只影响动态加的 server；plugin 拥有的 server 不会因此被卸掉（SDK 自己的语义）。
