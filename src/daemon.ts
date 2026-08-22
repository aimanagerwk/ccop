/** One process owns live ClaudeSDKClient / query connections. */

import { chmodSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import * as classify from "./classify.js";
import { CLI_PATH, LOG_PATH, PERMISSION_TIMEOUT_S, PID_PATH, SOCK_PATH, ensureData } from "./paths.js";
import * as policyMod from "./policy.js";
import { randomUUID } from "node:crypto";
import {
  appendEvent,
  listSessions,
  readEvents,
  resolveSessionId,
  upsertSession,
  type SessionRef,
} from "./store.js";
import {
  extractUsageFromResult,
  usageStatusFields,
  type SessionUsage,
} from "./usage.js";

export const HOOK_EVENTS = [
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "Notification",
] as const;

export function PermissionResultAllow(): { behavior: "allow" } {
  return { behavior: "allow" };
}

export function PermissionResultDeny(message: string): { behavior: "deny"; message: string } {
  return { behavior: "deny", message };
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  done: boolean;
  tool?: string;
  input?: Record<string, unknown>;
  reason?: string;
};

export type TrackedTask = {
  task_id: string;
  tool_use_id?: string;
  status: string;
  summary?: string;
  usage?: unknown;
};

export type TrackedSubagent = {
  agent_id: string;
  agent_type?: string;
  status: string;
};

function queryMethodMissing(name: string): never {
  throw new Error(`${name} is not available on this client (Python-shaped / no Query.${name})`);
}

function bindQueryControl(obj: any): Pick<LiveClient, "stopTask" | "backgroundTasks"> {
  return {
    async stopTask(taskId: string) {
      const fn = obj?.stopTask ?? obj?.stop_task;
      if (typeof fn !== "function") queryMethodMissing("stopTask");
      await fn.call(obj, taskId);
    },
    async backgroundTasks(toolUseId?: string) {
      const fn = obj?.backgroundTasks ?? obj?.background_tasks;
      if (typeof fn !== "function") queryMethodMissing("backgroundTasks");
      return await fn.call(obj, toolUseId);
    },
  };
}

type LiveClient = {
  query: (text: string) => Promise<void>;
  interrupt: () => Promise<void>;
  disconnect: () => Promise<void>;
  receiveMessages: () => AsyncIterable<unknown>;
  getServerInfo: () => Promise<unknown>;
  stopTask: (taskId: string) => Promise<void>;
  backgroundTasks: (toolUseId?: string) => Promise<boolean>;
};

async function openLiveClient(options: Record<string, unknown>, firstPrompt: string): Promise<LiveClient> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const Client = (sdk as { ClaudeSDKClient?: new (o: unknown) => any }).ClaudeSDKClient;
  if (Client) {
    const client = new Client(options);
    if (typeof client.connect === "function") await client.connect(firstPrompt);
    return {
      async query(text: string) {
        await client.query(text);
      },
      async interrupt() {
        await client.interrupt();
      },
      async disconnect() {
        if (typeof client.disconnect === "function") await client.disconnect();
        else if (typeof client.close === "function") client.close();
      },
      receiveMessages() {
        if (typeof client.receiveMessages === "function") return client.receiveMessages();
        if (typeof client.receive_messages === "function") return client.receive_messages();
        return client;
      },
      async getServerInfo() {
        if (typeof client.getServerInfo === "function") return client.getServerInfo();
        if (typeof client.get_server_info === "function") return client.get_server_info();
        if (typeof client.initializationResult === "function") return client.initializationResult();
        return null;
      },
      ...bindQueryControl(client),
    };
  }

  const { query } = sdk;
  type UserMsg = {
    type: "user";
    parent_tool_use_id: null;
    message: { role: "user"; content: string };
  };
  const waiters: Array<(r: IteratorResult<UserMsg>) => void> = [];
  const queued: UserMsg[] = [];
  let closed = false;
  const push = (text: string) => {
    const msg: UserMsg = {
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: text },
    };
    const w = waiters.shift();
    if (w) w({ value: msg, done: false });
    else queued.push(msg);
  };
  push(firstPrompt);
  const stream: AsyncIterable<UserMsg> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<UserMsg>> {
          if (queued.length) return Promise.resolve({ value: queued.shift()!, done: false });
          if (closed) return Promise.resolve({ value: undefined as unknown as UserMsg, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
  const q = query({ prompt: stream, options: options as never });
  let receiveStarted = false;
  return {
    async query(text: string) {
      push(text);
    },
    async interrupt() {
      await q.interrupt();
    },
    async disconnect() {
      closed = true;
      for (const w of waiters) w({ value: undefined as unknown as UserMsg, done: true });
      waiters.length = 0;
      q.close();
    },
    receiveMessages() {
      if (receiveStarted) {
        return (async function* () {
          /* already consumed */
        })();
      }
      receiveStarted = true;
      return q;
    },
    async getServerInfo() {
      try {
        return await q.initializationResult();
      } catch {
        return null;
      }
    },
    ...bindQueryControl(q),
  };
}

class Session {
  /** Claude session UUID — the only lookup key. */
  id: string;
  /** Optional operator label (--name). Display only. */
  name: string;
  /** Claude title (customTitle / summary). */
  title: string | null = null;
  cwd: string;
  client: LiveClient | null = null;
  recvTask: Promise<void> | null = null;
  recvAbort: AbortController | null = null;
  lock: string | null = null;
  pending: Record<string, Pending> = {};
  alive = false;
  policy = policyMod.loadPolicy();
  /** Hardcoded: always max effort. */
  effort = "max" as const;
  /** Hardcoded: dynamic workflows always on. */
  enableWorkflows = true;
  usage: SessionUsage | null = null;
  skills: string[] = [];
  slash_commands: string[] = [];
  plugins: unknown[] = [];
  tasks: Record<string, TrackedTask> = {};
  subagents: TrackedSubagent[] = [];
  /** SDK permissionMode. Hardcoded default is auto (classifier). Hold still parks. Policy deny still wins. */
  permissionMode = "auto";

  constructor(id: string, cwd: string, name = "") {
    this.id = id;
    this.cwd = cwd;
    this.name = name;
  }

  get sdkSessionId(): string {
    return this.id;
  }

  applyAdvertised(m: any): void {
    if (Array.isArray(m.skills)) this.skills = m.skills.map(String);
    if (Array.isArray(m.slash_commands)) this.slash_commands = m.slash_commands.map(String);
    else if (Array.isArray(m.slashCommands)) this.slash_commands = m.slashCommands.map(String);
    if (Array.isArray(m.plugins)) this.plugins = m.plugins;
  }

  upsertTask(row: TrackedTask): void {
    if (!row.task_id) return;
    const prev = this.tasks[row.task_id] || { task_id: row.task_id, status: "" };
    this.tasks[row.task_id] = {
      ...prev,
      ...Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)),
    };
    this.persist();
  }

  persist(): void {
    upsertSession(this.id, {
      name: this.name,
      title: this.title,
      cwd: this.cwd,
      lock: this.lock,
      sdk_session_id: this.id,
      alive: this.alive,
      pending: Object.entries(this.pending).map(([k, v]) => ({
        tool_use_id: k,
        tool: v.tool,
        reason: v.reason,
        input: v.input || {},
      })),
      effort: this.effort,
      enable_workflows: this.enableWorkflows,
      usage: this.usage,
      skills: this.skills,
      slash_commands: this.slash_commands,
      plugins: this.plugins,
      tasks: Object.values(this.tasks),
      subagents: this.subagents,
      permission_mode: this.permissionMode,
    });
  }

  emit(events: classify.Event[]): void {
    for (const e of events) appendEvent(this.id, e.kind, e.summary, e.extra || {}, this.name);
  }

  async canUseTool(toolName: string, toolInput: Record<string, unknown>, ctx: any): Promise<unknown> {
    const toolUseId = ctx?.toolUseID || ctx?.tool_use_id || `anon-${Object.keys(this.pending).length + 1}`;
    const decision = policyMod.decide(toolName, toolInput, this.policy);
    if (decision === "deny") return PermissionResultDeny(`policy deny ${toolName}`);
    // permissionMode auto: model classifier / host does not park ask tools.
    // Policy deny above still wins. Hold still parks even in auto.
    const autoPass =
      this.lock !== "operator" && (decision === "allow" || this.permissionMode === "auto");
    if (autoPass) return PermissionResultAllow();
    const reason = this.lock === "operator" && (decision === "allow" || this.permissionMode === "auto")
      ? "held"
      : "ask";
    const item: Pending = {
      resolve: () => {},
      reject: () => {},
      done: false,
      tool: toolName,
      input: toolInput,
      reason,
    };
    const fut = new Promise((resolve, reject) => {
      item.resolve = (v) => {
        item.done = true;
        resolve(v);
      };
      item.reject = (e) => {
        item.done = true;
        reject(e);
      };
    });
    this.pending[toolUseId] = item;
    this.persist();
    this.emit(
      classify.fromParkedCanUseTool({
        tool_name: toolName,
        tool_use_id: toolUseId,
        reason,
      }),
    );
    try {
      const result = await Promise.race([
        fut,
        sleepReject(PERMISSION_TIMEOUT_S * 1000, "permission timeout"),
      ]);
      return result;
    } catch (exc: any) {
      delete this.pending[toolUseId];
      this.persist();
      if (exc?.message === "permission timeout") return PermissionResultDeny("permission timeout");
      return PermissionResultDeny("cancelled");
    } finally {
      delete this.pending[toolUseId];
      this.persist();
    }
  }

  async onHook(hookInput: any, toolUseId: string | null): Promise<Record<string, unknown>> {
    let payload: Record<string, unknown>;
    if (hookInput && typeof hookInput === "object" && !Array.isArray(hookInput)) {
      payload = { ...hookInput };
    } else {
      payload = {};
    }
    const evName = String(payload.hook_event_name || payload.hook_event || payload.hookEventName || "");
    if (toolUseId && !("tool_use_id" in payload)) payload.tool_use_id = toolUseId;
    this.emit(classify.fromHook(evName, payload));
    if (evName === "SubagentStart") {
      const agentId = String(payload.agent_id || payload.agentId || toolUseId || "");
      const agentType = String(payload.agent_type || payload.agentType || "");
      if (agentId) this.subagents = this.subagents.filter((s) => s.agent_id !== agentId);
      this.subagents.push({ agent_id: agentId, agent_type: agentType || undefined, status: "running" });
      this.persist();
    } else if (evName === "SubagentStop") {
      const agentId = String(payload.agent_id || payload.agentId || toolUseId || "");
      let hit = false;
      for (const s of this.subagents) {
        if (!agentId || s.agent_id === agentId) {
          s.status = "stopped";
          hit = true;
        }
      }
      if (!hit && agentId) this.subagents.push({ agent_id: agentId, status: "stopped" });
      this.persist();
    }
    void payload.session_id;
    void payload.sessionId;
    if (evName === "PreToolUse") {
      const tool = String(payload.tool_name || payload.toolName || "");
      const raw = payload.tool_input ?? payload.toolInput ?? {};
      const input =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      const hookDecision = policyMod.preToolUseHookDecision(
        tool,
        input,
        this.lock,
        this.permissionMode,
        this.policy,
      );
      if (hookDecision && Object.keys(hookDecision).length) return hookDecision;
    }
    return {};
  }

  ingestSessionId(msg: any): void {
    /* id is the Claude session UUID we passed as options.sessionId / resume */
    void msg;
  }

  async receiveLoop(): Promise<void> {
    if (!this.client) return;
    try {
      for await (const msg of this.client.receiveMessages()) {
        this.ingestSessionId(msg);
        const m = msg as any;
        const typeName = m?.constructor?.name || "";
        const type = m?.type;
        const subtype = m?.subtype;
        if (type === "result" || typeName === "ResultMessage") {
          const extracted = extractUsageFromResult(m);
          if (extracted) this.usage = extracted;
          this.persist();
          this.emit(
            classify.fromResult({
              is_error: Boolean(m.is_error ?? m.isError),
              session_id: m.session_id || m.sessionId || null,
              result: m.result ?? null,
            }),
          );
        } else if ((type === "system" && subtype === "init") || typeName === "SystemInitMessage") {
          this.applyAdvertised(m);
          this.persist();
          this.emit([{ kind: "working", summary: "init", extra: { type: "system", subtype: "init" } }]);
        } else if (type === "system" && subtype === "commands_changed") {
          const cmds = m.commands;
          if (Array.isArray(cmds)) {
            this.slash_commands = cmds.map((c: any) => (typeof c === "string" ? c : c?.name || String(c)));
            this.persist();
          }
          this.emit([{ kind: "working", summary: "commands_changed", extra: {} }]);
        } else if (
          type === "task_notification" ||
          subtype === "task_notification" ||
          typeName === "TaskNotificationMessage"
        ) {
          this.upsertTask({
            task_id: String(m.task_id || m.taskId || ""),
            tool_use_id: m.tool_use_id || m.toolUseId,
            status: String(m.status ?? ""),
            summary: m.summary || "",
            usage: m.usage,
          });
          const tn = classify.fromTaskNotification({
              status: String(m.status ?? ""),
              summary: m.summary || "",
              task_id: m.task_id || m.taskId || "",
            });
          for (const e of tn) {
            e.extra = {
              ...e.extra,
              tool_use_id: m.tool_use_id || m.toolUseId,
              skip_transcript: m.skip_transcript ?? m.skipTranscript,
              usage: m.usage,
            };
          }
          this.emit(tn);
        } else if (subtype === "task_started" || type === "task_started") {
          const extraStarted: Record<string, unknown> = {
            task_id: m.task_id || m.taskId,
            tool_use_id: m.tool_use_id || m.toolUseId,
            task_type: m.task_type ?? m.taskType,
            workflow_name: m.workflow_name ?? m.workflowName,
            is_backgrounded: m.is_backgrounded ?? m.isBackgrounded,
            spawn_depth: m.spawn_depth ?? m.spawnDepth,
            skip_transcript: m.skip_transcript ?? m.skipTranscript,
            description: m.description,
          };
          this.upsertTask({
            task_id: String(m.task_id || m.taskId || ""),
            tool_use_id: m.tool_use_id || m.toolUseId,
            status: "running",
            summary: m.description || m.summary || m.workflow_name || "task started",
          });
          this.emit([{ kind: "working", summary: "task_started", extra: extraStarted }]);
        } else if (subtype === "task_progress" || type === "task_progress") {
          this.upsertTask({
            task_id: String(m.task_id || m.taskId || ""),
            tool_use_id: m.tool_use_id || m.toolUseId,
            status: "running",
            summary: m.summary || m.description || "task progress",
            usage: m.usage,
          });
          this.emit([{
            kind: "working",
            summary: "task_progress",
            extra: {
              task_id: m.task_id || m.taskId,
              description: m.description,
              last_tool_name: m.last_tool_name ?? m.lastToolName,
              subagent_type: m.subagent_type ?? m.subagentType,
              usage: m.usage,
            },
          }]);
        } else if (subtype === "task_updated" || type === "task_updated") {
          const patch = m.patch || {};
          this.upsertTask({
            task_id: String(m.task_id || m.taskId || ""),
            status: patch.status || "running",
            summary: patch.description || patch.error,
          });
          this.emit([{ kind: "working", summary: "task_updated", extra: { task_id: m.task_id || m.taskId, patch } }]);
        } else if (subtype === "background_tasks_changed" || type === "background_tasks_changed") {
          const live = Array.isArray(m.tasks) ? m.tasks : [];
          const liveIds = new Set(live.map((t: any) => String(t.task_id || t.taskId || "")));
          for (const t of live) {
            const id = String(t.task_id || t.taskId || "");
            if (!id) continue;
            this.upsertTask({
              task_id: id,
              status: this.tasks[id]?.status || "running",
              summary: t.description || this.tasks[id]?.summary,
            });
          }
          for (const [id, t] of Object.entries(this.tasks)) {
            if (!liveIds.has(id) && (t.status === "running" || t.status === "pending")) {
              t.status = "background_gone";
            }
          }
          this.persist();
          this.emit([{
            kind: "working",
            summary: "background_tasks_changed",
            extra: {
              n: live.length,
              tasks: live.map((t: any) => ({
                task_id: t.task_id || t.taskId || t.id,
                type: t.type,
                name: t.name,
                status: t.status,
                description: t.description,
                agent_type: t.agent_type || t.agentType,
              })),
            },
          }]);
        } else if (m?.type === "assistant" || typeName === "AssistantMessage") {
          const blocks = m.message?.content || m.content || [];
          for (const block of blocks) {
            const btype = block?.type || block?.constructor?.name;
            if (btype === "tool_use" || btype === "ToolUseBlock") {
              this.emit(
                classify.fromToolUse({
                  name: block.name,
                  tool_use_id: block.id || "",
                  tool_input: block.input || {},
                }),
              );
            } else {
              this.emit([
                {
                  kind: "working",
                  summary: "assistant",
                  extra: { type: btype || typeof block },
                },
              ]);
            }
          }
        } else {
          const label = subtype || typeName || type || "message";
          this.emit([
            {
              kind: "working",
              summary: String(label),
              extra: { type: typeName || type },
            },
          ]);
        }
      }
    } catch (exc: any) {
      if (exc?.name === "AbortError") throw exc;
      this.alive = false;
      this.emit(classify.fromProcessDeath({ error: `${exc?.name || "Error"}: ${exc?.message || exc}` }));
      this.persist();
      return;
    }
    if (this.alive) {
      this.alive = false;
      this.emit(classify.fromProcessDeath({ error: "receive loop closed" }));
      this.persist();
    }
  }
}

function sleepReject(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

class Host {
  sessions: Record<string, Session> = {};
  shuttingDown = false;

  async dispatch(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const cmd = req.cmd;
    const fns: Record<string, (r: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
      ping: (r) => this.cmdPing(r),
      start: (r) => this.cmdStart(r),
      send: (r) => this.cmdSend(r),
      interrupt: (r) => this.cmdInterrupt(r),
      hold: (r) => this.cmdHold(r),
      release: (r) => this.cmdRelease(r),
      approve: (r) => this.cmdApprove(r),
      deny: (r) => this.cmdDeny(r),
      stop: (r) => this.cmdStop(r),
      status: (r) => this.cmdStatus(r),
      events: (r) => this.cmdEvents(r),
      info: (r) => this.cmdInfo(r),
      workflows: (r) => this.cmdWorkflows(r),
      tasks: (r) => this.cmdTasks(r),
      "task-stop": (r) => this.cmdTaskStop(r),
      "task-bg": (r) => this.cmdTaskBg(r),
      subagents: (r) => this.cmdSubagents(r),
      shutdown: (r) => this.cmdShutdown(r),
    };
    const fn = fns[String(cmd)];
    if (!fn) return { ok: false, error: `unknown cmd ${cmd}` };
    return fn(req);
  }

  async cmdPing(_req: Record<string, unknown>): Promise<Record<string, unknown>> {
    return { ok: true, pid: process.pid };
  }

  async cmdStart(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const name = typeof req.name === "string" ? req.name : "";
    const cwd = req.cwd as string | undefined;
    const prompt = req.prompt as string | undefined;
    const resumeId = (req.resume_id as string | undefined) || undefined;
    const permissionMode =
      typeof req.permission_mode === "string" && req.permission_mode.trim()
        ? String(req.permission_mode).trim()
        : "auto";
    if (!cwd || prompt === undefined) return { ok: false, error: "start requires cwd, prompt" };
    const id = resumeId || randomUUID();
    if (this.sessions[id]?.alive) return { ok: false, error: `session ${id} already live` };
    if (this.sessions[id]) await this.teardown(id);
    const sess = new Session(id, cwd, name);
    sess.permissionMode = permissionMode;
    this.sessions[id] = sess;

    const hookCb = async (hookInput: unknown, toolUseId: string | null) => sess.onHook(hookInput, toolUseId);
    const matcher = { hooks: [hookCb], timeout: 30 };
    const hooks: Record<string, unknown[]> = {};
    for (const ev of HOOK_EVENTS) hooks[ev] = [matcher];

    const canUseTool = (toolName: string, toolInput: Record<string, unknown>, ctx: unknown) =>
      sess.canUseTool(toolName, toolInput, ctx);

    const common: Record<string, unknown> = {
      pathToClaudeCodeExecutable: CLI_PATH,
      cwd,
      systemPrompt: { type: "preset", preset: "claude_code" },
      includeHookEvents: true,
      forwardSubagentText: true,
      canUseTool,
      permissionMode,
      settingSources: ["user", "project", "local"],
      ultracode: false,
      enableWorkflows: true,
      effort: "max",
      hooks,
    };
    if (resumeId) common.resume = resumeId;
    else common.sessionId = id;
    if (name) common.title = name;

    let options: Record<string, unknown> = {
      ...common,
      tools: { type: "preset", preset: "claude_code" },
    };

    try {
      sess.client = await openLiveClient(options, prompt);
    } catch (exc: any) {
      try {
        delete options.tools;
        sess.client = await openLiveClient({ ...common }, prompt);
      } catch (exc2: any) {
        sess.alive = false;
        sess.emit(classify.fromProcessDeath({ error: `connect: ${exc2}` }));
        sess.persist();
        return { ok: false, error: `connect failed: ${exc2}` };
      }
    }

    sess.alive = true;
    await refreshClaudeTitle(sess);
    if (resumeId && name) {
      try {
        const sdk = await import("@anthropic-ai/claude-agent-sdk");
        if (typeof sdk.renameSession === "function") {
          await sdk.renameSession(id, name, { dir: cwd });
          sess.title = name;
        }
      } catch {
        /* display-only; ignore */
      }
    }
    sess.persist();
    sess.emit(classify.fromSent({ text: prompt }));
    sess.emit([{ kind: "working", summary: "connected", extra: {} }]);
    sess.recvTask = sess.receiveLoop().catch((e) => {
      if (e?.name !== "AbortError") {
        /* already logged in loop */
      }
    });
    return { ok: true, id, name: sess.name, title: sess.title, sdk_session_id: sess.id, permission_mode: sess.permissionMode };
  }

  async cmdSend(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sess = this.need(req);
    if (!(sess instanceof Session)) return sess;
    if (sess.lock === "operator") return { ok: false, error: "held" };
    if (!sess.client || !sess.alive) return { ok: false, error: "session not live" };
    const text = req.text;
    if (text === undefined) return { ok: false, error: "send requires text" };
    await sess.client.query(String(text));
    sess.emit(classify.fromSent({ text: String(text) }));
    sess.emit([{ kind: "working", summary: "query sent", extra: {} }]);
    return { ok: true, id: sess.id, name: sess.name };
  }

  async cmdInterrupt(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sess = this.need(req);
    if (!(sess instanceof Session)) return sess;
    if (!sess.client) return { ok: false, error: "no client" };
    await sess.client.interrupt();
    sess.emit(classify.fromInterrupted());
    return { ok: true, id: sess.id, name: sess.name };
  }

  async cmdHold(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sess = this.need(req);
    if (!(sess instanceof Session)) return sess;
    sess.lock = "operator";
    sess.persist();
    sess.emit(classify.fromHeld());
    return { ok: true, id: sess.id, name: sess.name, lock: "operator" };
  }

  async cmdRelease(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sess = this.need(req);
    if (!(sess instanceof Session)) return sess;
    sess.lock = null;
    sess.persist();
    upsertSession(sess.id, { state: "idle" });
    return { ok: true, id: sess.id, name: sess.name, lock: null };
  }

  async cmdApprove(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.resolvePerm(req, true);
  }

  async cmdDeny(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.resolvePerm(req, false);
  }

  async resolvePerm(req: Record<string, unknown>, allow: boolean): Promise<Record<string, unknown>> {
    const sess = this.need(req);
    if (!(sess instanceof Session)) return sess;
    const tid = req.tool_use_id as string | undefined;
    if (!tid) return { ok: false, error: "tool_use_id required" };
    const item = sess.pending[tid];
    if (!item) return { ok: false, error: `no pending ${tid}` };
    if (item.done) return { ok: false, error: "already resolved" };
    if (allow) item.resolve(PermissionResultAllow());
    else item.resolve(PermissionResultDeny("operator deny"));
    return { ok: true, id: sess.id, name: sess.name, tool_use_id: tid, allowed: allow };
  }

  async cmdStop(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const resolved = resolveSessionId(lookupKey(req), this.sessionRefs());
    if (!resolved.ok) return resolved;
    const id = resolved.id;
    const label = this.sessions[id]?.name ?? "";
    if (id in this.sessions) await this.teardown(id);
    upsertSession(id, { alive: false, state: "dead" });
    appendEvent(id, "dead", "stopped", {}, label);
    return { ok: true, id };
  }

  async cmdStatus(_req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const rows: Record<string, unknown>[] = [];
    const disk: Record<string, Record<string, unknown>> = {};
    for (const s of listSessions()) disk[String(s.id)] = s;
    const ids = new Set([...Object.keys(disk), ...Object.keys(this.sessions)]);
    for (const id of [...ids].sort()) {
      const rec = { ...(disk[id] || { id }) };
      rec.id = id;
      const live = this.sessions[id];
      if (live) {
        rec.alive = live.alive;
        rec.lock = live.lock;
        rec.name = live.name;
        rec.title = live.title;
        rec.cwd = live.cwd;
        rec.sdk_session_id = live.id;
        rec.pending = Object.entries(live.pending).map(([k, v]) => ({
          tool_use_id: k,
          tool: v.tool,
          reason: v.reason,
        }));
        rec.effort = live.effort;
        rec.enable_workflows = live.enableWorkflows;
        rec.permission_mode = live.permissionMode;
        rec.skills = live.skills;
        rec.slash_commands = live.slash_commands;
        rec.plugins = live.plugins;
      }
      if (!("name" in rec)) rec.name = "";
      if (!("title" in rec)) rec.title = null;
      if (!("sdk_session_id" in rec)) rec.sdk_session_id = id;
      if (!("last_turn" in rec)) rec.last_turn = null;
      if (!("last_task" in rec)) rec.last_task = null;
      if (!("pending" in rec)) rec.pending = [];
      if (!("effort" in rec)) rec.effort = "max";
      if (!("enable_workflows" in rec)) rec.enable_workflows = true;
      if (!("skills" in rec)) rec.skills = live?.skills ?? [];
      if (!("slash_commands" in rec)) rec.slash_commands = live?.slash_commands ?? [];
      if (!("plugins" in rec)) rec.plugins = live?.plugins ?? [];
      const usage = (live?.usage ?? rec.usage) as SessionUsage | null | undefined;
      Object.assign(rec, usageStatusFields(usage ?? null));
      if (usage) rec.usage = usage;
      else if (!("usage" in rec)) rec.usage = null;
      rows.push(rec);
    }
    return { ok: true, sessions: rows };
  }

  async cmdEvents(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const resolved = resolveSessionId(lookupKey(req), this.sessionRefs());
    if (!resolved.ok) return resolved;
    const evs = readEvents(resolved.id, (req.tail as number | null | undefined) ?? null);
    return { ok: true, id: resolved.id, events: evs };
  }

  diskOrLive(id: string): { rec: Record<string, unknown>; live?: Session } {
    const live = this.sessions[id];
    const disk = listSessions().find((s) => String(s.id) === id) || { id };
    const rec = { ...disk };
    if (live) {
      rec.skills = live.skills;
      rec.slash_commands = live.slash_commands;
      rec.plugins = live.plugins;
      rec.usage = live.usage;
      rec.effort = live.effort;
      rec.enable_workflows = live.enableWorkflows;
      rec.permission_mode = live.permissionMode;
      rec.tasks = Object.values(live.tasks);
      rec.subagents = live.subagents;
      rec.cwd = live.cwd;
    }
    return { rec, live };
  }

  async cmdInfo(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const resolved = resolveSessionId(lookupKey(req), this.sessionRefs());
    if (!resolved.ok) return resolved;
    const { rec } = this.diskOrLive(resolved.id);
    const usage = (rec.usage as SessionUsage | null) ?? null;
    return {
      ok: true,
      id: resolved.id,
      effort: rec.effort ?? "max",
      enable_workflows: rec.enable_workflows ?? true,
      permission_mode: rec.permission_mode ?? "auto",
      skills: rec.skills ?? [],
      slash_commands: rec.slash_commands ?? [],
      plugins: rec.plugins ?? [],
      usage,
      ...usageStatusFields(usage),
    };
  }

  async cmdWorkflows(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const resolved = resolveSessionId(lookupKey(req), this.sessionRefs());
    if (!resolved.ok) return resolved;
    const { rec } = this.diskOrLive(resolved.id);
    return {
      ok: true,
      id: resolved.id,
      skills: rec.skills ?? [],
      slash_commands: rec.slash_commands ?? [],
      plugins: rec.plugins ?? [],
      note: "listed from session advertise (init); host does not invoke workflows — the model does",
    };
  }

  async cmdTasks(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const resolved = resolveSessionId(lookupKey(req), this.sessionRefs());
    if (!resolved.ok) return resolved;
    const { rec, live } = this.diskOrLive(resolved.id);
    const tasks = live ? Object.values(live.tasks) : Array.isArray(rec.tasks) ? rec.tasks : [];
    return { ok: true, id: resolved.id, tasks };
  }

  async cmdTaskStop(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sess = this.need(req);
    if (!(sess instanceof Session)) return sess;
    if (!sess.client || !sess.alive) return { ok: false, error: "session not live" };
    const taskId = req.task_id as string | undefined;
    if (!taskId) return { ok: false, error: "task_id required" };
    try {
      await sess.client.stopTask(taskId);
      return { ok: true, id: sess.id, task_id: taskId };
    } catch (exc: any) {
      return { ok: false, error: String(exc?.message || exc) };
    }
  }

  async cmdTaskBg(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sess = this.need(req);
    if (!(sess instanceof Session)) return sess;
    if (!sess.client || !sess.alive) return { ok: false, error: "session not live" };
    const toolUseId = (req.tool_use_id as string | undefined) || undefined;
    try {
      const backgrounded = await sess.client.backgroundTasks(toolUseId);
      return { ok: true, id: sess.id, backgrounded, tool_use_id: toolUseId ?? null };
    } catch (exc: any) {
      return { ok: false, error: String(exc?.message || exc) };
    }
  }

  async cmdSubagents(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const resolved = resolveSessionId(lookupKey(req), this.sessionRefs());
    if (!resolved.ok) return resolved;
    const { rec, live } = this.diskOrLive(resolved.id);
    const cwd = String(live?.cwd || rec.cwd || "");
    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      if (typeof sdk.listSubagents === "function") {
        const ids = await sdk.listSubagents(resolved.id, cwd ? { dir: cwd } : {});
        return { ok: true, id: resolved.id, source: "sdk", subagents: ids };
      }
    } catch {
      /* fall through to tracked */
    }
    const tracked = live?.subagents ?? (Array.isArray(rec.subagents) ? rec.subagents : []);
    return { ok: true, id: resolved.id, source: "tracked", subagents: tracked };
  }

  async cmdShutdown(_req: Record<string, unknown>): Promise<Record<string, unknown>> {
    for (const name of Object.keys(this.sessions)) {
      try {
        await this.teardown(name);
      } catch {
        /* ignore */
      }
    }
    this.shuttingDown = true;
    setTimeout(() => process.exit(0), 50);
    return { ok: true };
  }

  sessionRefs(): SessionRef[] {
    const map = new Map<string, SessionRef>();
    for (const s of listSessions()) {
      const id = String(s.id ?? "");
      if (!id) continue;
      map.set(id, {
        id,
        name: s.name ? String(s.name) : undefined,
        title: s.title ? String(s.title) : undefined,
      });
    }
    for (const [id, s] of Object.entries(this.sessions)) {
      map.set(id, { id, name: s.name || undefined, title: s.title || undefined });
    }
    return [...map.values()];
  }

  need(req: Record<string, unknown>): Session | Record<string, unknown> {
    const resolved = resolveSessionId(lookupKey(req), this.sessionRefs());
    if (!resolved.ok) return resolved;
    const sess = this.sessions[resolved.id];
    if (!sess) return { ok: false, error: `unknown session ${resolved.id}` };
    return sess;
  }

  async teardown(id: string): Promise<void> {
    const sess = this.sessions[id];
    delete this.sessions[id];
    if (!sess) return;
    for (const item of Object.values(sess.pending)) {
      if (!item.done) item.reject(new Error("cancelled"));
    }
    sess.alive = false;
    if (sess.client) {
      try {
        await sess.client.disconnect();
      } catch {
        /* ignore */
      }
    }
    sess.persist();
  }
}

function lookupKey(req: Record<string, unknown>): string | undefined {
  const id = req.id;
  if (typeof id === "string" && id) return id;
  const name = req.name;
  if (typeof name === "string" && name) return name;
  return undefined;
}

async function refreshClaudeTitle(sess: Session): Promise<void> {
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    if (typeof sdk.getSessionInfo !== "function") return;
    const info = await sdk.getSessionInfo(sess.id, { dir: sess.cwd });
    if (!info) return;
    const rec = info as { customTitle?: string; aiTitle?: string; summary?: string };
    const title = rec.customTitle || rec.aiTitle || rec.summary;
    if (title) sess.title = title;
  } catch {
    /* title is display-only */
  }
}

function sessionIdFromInfo(info: unknown): string | null {
  if (!info) return null;
  if (typeof info === "object") {
    const obj = info as Record<string, unknown>;
    for (const k of ["session_id", "sessionId", "sessionID"]) {
      if (obj[k]) return String(obj[k]);
    }
    const data = obj.data;
    if (data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      for (const k of ["session_id", "sessionId"]) {
        if (d[k]) return String(d[k]);
      }
    }
  }
  return null;
}

function handle(host: Host, sock: Socket): void {
  let buf = "";
  sock.on("data", async (chunk) => {
    buf += chunk.toString("utf8");
    if (!buf.includes("\n")) return;
    const line = buf;
    buf = "";
    let req: Record<string, unknown>;
    try {
      req = JSON.parse(line);
    } catch (exc: any) {
      sock.write(JSON.stringify({ ok: false, error: `bad json: ${exc}` }) + "\n");
      sock.end();
      return;
    }
    let res: Record<string, unknown>;
    try {
      res = await host.dispatch(req);
    } catch (exc: any) {
      res = { ok: false, error: `${exc?.name || "Error"}: ${exc?.message || exc}`, trace: exc?.stack };
    }
    try {
      sock.write(JSON.stringify(res) + "\n");
    } catch {
      /* ignore */
    }
    sock.end();
  });
}

export async function serve(): Promise<void> {
  ensureData();
  if (existsSync(SOCK_PATH)) {
    try {
      unlinkSync(SOCK_PATH);
    } catch {
      /* ignore */
    }
  }
  const host = new Host();
  const server = createServer((sock) => handle(host, sock));
  await new Promise<void>((resolve, reject) => {
    server.listen(SOCK_PATH, () => resolve());
    server.on("error", reject);
  });
  writeFileSync(PID_PATH, String(process.pid) + "\n");
  chmodSync(SOCK_PATH, 0o600);
  void LOG_PATH;

  const stop = async () => {
    server.close();
    await host.cmdShutdown({});
    try {
      unlinkSync(SOCK_PATH);
    } catch {
      /* ignore */
    }
  };
  process.on("SIGTERM", () => {
    void stop();
  });
  process.on("SIGINT", () => {
    void stop();
  });
}

export function main(): void {
  ensureData();
  void serve();
}
