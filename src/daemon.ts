/** One process owns live ClaudeSDKClient / query connections. */

import { chmodSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import * as classify from "./classify.js";
import { CLI_PATH, LOG_PATH, PERMISSION_TIMEOUT_S, PID_PATH, SOCK_PATH, ensureData } from "./paths.js";
import * as policyMod from "./policy.js";
import { appendEvent, listSessions, readEvents, upsertSession } from "./store.js";

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

type LiveClient = {
  query: (text: string) => Promise<void>;
  interrupt: () => Promise<void>;
  disconnect: () => Promise<void>;
  receiveMessages: () => AsyncIterable<unknown>;
  getServerInfo: () => Promise<unknown>;
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
  };
}

class Session {
  name: string;
  cwd: string;
  client: LiveClient | null = null;
  recvTask: Promise<void> | null = null;
  recvAbort: AbortController | null = null;
  lock: string | null = null;
  sdkSessionId: string | null = null;
  pending: Record<string, Pending> = {};
  alive = false;
  policy = policyMod.loadPolicy();

  constructor(name: string, cwd: string) {
    this.name = name;
    this.cwd = cwd;
  }

  persist(): void {
    upsertSession(this.name, {
      cwd: this.cwd,
      lock: this.lock,
      sdk_session_id: this.sdkSessionId,
      alive: this.alive,
      pending: Object.entries(this.pending).map(([k, v]) => ({
        tool_use_id: k,
        tool: v.tool,
        reason: v.reason,
        input: v.input || {},
      })),
    });
  }

  emit(events: classify.Event[]): void {
    for (const e of events) appendEvent(this.name, e.kind, e.summary, e.extra || {});
  }

  async canUseTool(toolName: string, toolInput: Record<string, unknown>, ctx: any): Promise<unknown> {
    const toolUseId = ctx?.toolUseID || ctx?.tool_use_id || `anon-${Object.keys(this.pending).length + 1}`;
    const decision = policyMod.decide(toolName, toolInput, this.policy);
    if (decision === "deny") return PermissionResultDeny(`policy deny ${toolName}`);
    const auto = decision === "allow" && this.lock !== "operator";
    if (auto) return PermissionResultAllow();
    const reason = decision === "allow" && this.lock === "operator" ? "held" : "ask";
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
    const sid = payload.session_id || payload.sessionId;
    if (sid && !this.sdkSessionId) {
      this.sdkSessionId = String(sid);
      this.persist();
    }
    return {};
  }

  ingestSessionId(msg: any): void {
    const val = msg?.session_id || msg?.sessionId;
    if (val) {
      this.sdkSessionId = String(val);
      return;
    }
    const data = msg?.data;
    if (data && typeof data === "object" && data.session_id) {
      this.sdkSessionId = String(data.session_id);
    }
  }

  async receiveLoop(): Promise<void> {
    if (!this.client) return;
    try {
      for await (const msg of this.client.receiveMessages()) {
        this.ingestSessionId(msg);
        const m = msg as any;
        const typeName = m?.constructor?.name || "";
        if (m?.type === "result" || typeName === "ResultMessage") {
          if (m.session_id || m.sessionId) {
            this.sdkSessionId = String(m.session_id || m.sessionId);
            this.persist();
          }
          this.emit(
            classify.fromResult({
              is_error: Boolean(m.is_error ?? m.isError),
              session_id: m.session_id || m.sessionId || null,
              result: m.result ?? null,
            }),
          );
        } else if (m?.type === "task_notification" || typeName === "TaskNotificationMessage") {
          this.emit(
            classify.fromTaskNotification({
              status: String(m.status ?? ""),
              summary: m.summary || "",
              task_id: m.task_id || m.taskId || "",
            }),
          );
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
          const subtype = m?.subtype || typeName || m?.type || "message";
          this.emit([
            {
              kind: "working",
              summary: String(subtype),
              extra: { type: typeName || m?.type },
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
    const name = req.name as string | undefined;
    const cwd = req.cwd as string | undefined;
    const prompt = req.prompt as string | undefined;
    const resumeId = (req.resume_id as string | undefined) || undefined;
    if (!name || !cwd || prompt === undefined) return { ok: false, error: "start requires name, cwd, prompt" };
    if (this.sessions[name]?.alive) return { ok: false, error: `session ${name} already live` };
    if (this.sessions[name]) await this.teardown(name);
    const sess = new Session(name, cwd);
    this.sessions[name] = sess;

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
      permissionMode: "default",
      settingSources: ["user", "project", "local"],
      hooks,
    };
    if (resumeId) common.resume = resumeId;

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
    try {
      const info = await sess.client.getServerInfo();
      const sid = sessionIdFromInfo(info);
      if (sid) sess.sdkSessionId = sid;
    } catch {
      /* ignore */
    }
    sess.persist();
    sess.emit(classify.fromSent({ text: prompt }));
    sess.emit([{ kind: "working", summary: "connected", extra: {} }]);
    sess.recvTask = sess.receiveLoop().catch((e) => {
      if (e?.name !== "AbortError") {
        /* already logged in loop */
      }
    });
    return { ok: true, name, sdk_session_id: sess.sdkSessionId };
  }

  async cmdSend(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sess = this.need(req.name as string | undefined);
    if (!(sess instanceof Session)) return sess;
    if (sess.lock === "operator") return { ok: false, error: "held" };
    if (!sess.client || !sess.alive) return { ok: false, error: "session not live" };
    const text = req.text;
    if (text === undefined) return { ok: false, error: "send requires text" };
    await sess.client.query(String(text));
    sess.emit(classify.fromSent({ text: String(text) }));
    sess.emit([{ kind: "working", summary: "query sent", extra: {} }]);
    return { ok: true, name: sess.name };
  }

  async cmdInterrupt(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sess = this.need(req.name as string | undefined);
    if (!(sess instanceof Session)) return sess;
    if (!sess.client) return { ok: false, error: "no client" };
    await sess.client.interrupt();
    sess.emit(classify.fromInterrupted());
    return { ok: true, name: sess.name };
  }

  async cmdHold(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sess = this.need(req.name as string | undefined);
    if (!(sess instanceof Session)) return sess;
    sess.lock = "operator";
    sess.persist();
    sess.emit(classify.fromHeld());
    return { ok: true, name: sess.name, lock: "operator" };
  }

  async cmdRelease(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sess = this.need(req.name as string | undefined);
    if (!(sess instanceof Session)) return sess;
    sess.lock = null;
    sess.persist();
    upsertSession(sess.name, { state: "idle" });
    return { ok: true, name: sess.name, lock: null };
  }

  async cmdApprove(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.resolvePerm(req, true);
  }

  async cmdDeny(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.resolvePerm(req, false);
  }

  async resolvePerm(req: Record<string, unknown>, allow: boolean): Promise<Record<string, unknown>> {
    const sess = this.need(req.name as string | undefined);
    if (!(sess instanceof Session)) return sess;
    const tid = req.tool_use_id as string | undefined;
    if (!tid) return { ok: false, error: "tool_use_id required" };
    const item = sess.pending[tid];
    if (!item) return { ok: false, error: `no pending ${tid}` };
    if (item.done) return { ok: false, error: "already resolved" };
    if (allow) item.resolve(PermissionResultAllow());
    else item.resolve(PermissionResultDeny("operator deny"));
    return { ok: true, name: sess.name, tool_use_id: tid, allowed: allow };
  }

  async cmdStop(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const name = req.name as string | undefined;
    if (!name) return { ok: false, error: "name required" };
    if (!(name in this.sessions)) return { ok: false, error: `unknown session ${name}` };
    await this.teardown(name);
    upsertSession(name, { alive: false, state: "dead" });
    appendEvent(name, "dead", "stopped", {});
    return { ok: true, name };
  }

  async cmdStatus(_req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const rows: Record<string, unknown>[] = [];
    const disk: Record<string, Record<string, unknown>> = {};
    for (const s of listSessions()) disk[String(s.name)] = s;
    const names = new Set([...Object.keys(disk), ...Object.keys(this.sessions)]);
    for (const name of [...names].sort()) {
      const rec = { ...(disk[name] || { name }) };
      const live = this.sessions[name];
      if (live) {
        rec.alive = live.alive;
        rec.lock = live.lock;
        rec.sdk_session_id = live.sdkSessionId;
        rec.pending = Object.entries(live.pending).map(([k, v]) => ({
          tool_use_id: k,
          tool: v.tool,
          reason: v.reason,
        }));
      }
      if (!("last_turn" in rec)) rec.last_turn = null;
      if (!("last_task" in rec)) rec.last_task = null;
      if (!("pending" in rec)) rec.pending = [];
      rows.push(rec);
    }
    return { ok: true, sessions: rows };
  }

  async cmdEvents(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const name = req.name as string | undefined;
    if (!name) return { ok: false, error: "name required" };
    const evs = readEvents(name, (req.tail as number | null | undefined) ?? null);
    return { ok: true, name, events: evs };
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

  need(name: string | undefined): Session | Record<string, unknown> {
    if (!name) return { ok: false, error: "name required" };
    const sess = this.sessions[name];
    if (!sess) return { ok: false, error: `unknown session ${name}` };
    return sess;
  }

  async teardown(name: string): Promise<void> {
    const sess = this.sessions[name];
    delete this.sessions[name];
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
