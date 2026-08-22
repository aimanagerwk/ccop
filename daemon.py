"""One process owns live ClaudeSDKClient connections."""

from __future__ import annotations

import asyncio
import json
import os
import signal
import traceback
from typing import Any

from ccop import classify, policy as policy_mod
from ccop.paths import (
    CLI_PATH,
    LOG_PATH,
    PERMISSION_TIMEOUT_S,
    PID_PATH,
    SOCK_PATH,
    ensure_data,
)
from ccop.store import append_event, list_sessions, upsert_session

HOOK_EVENTS = (
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "SubagentStart",
    "SubagentStop",
    "Notification",
)


class Session:
    def __init__(self, name: str, cwd: str) -> None:
        self.name = name
        self.cwd = cwd
        self.client: Any = None
        self.recv_task: asyncio.Task | None = None
        self.lock: str | None = None
        self.sdk_session_id: str | None = None
        self.pending: dict[str, dict[str, Any]] = {}  # tool_use_id -> meta + future
        self.alive = False
        self.policy = policy_mod.load_policy()

    def persist(self) -> None:
        upsert_session(
            self.name,
            cwd=self.cwd,
            lock=self.lock,
            sdk_session_id=self.sdk_session_id,
            alive=self.alive,
            pending=[
                {
                    "tool_use_id": k,
                    "tool": v.get("tool"),
                    "reason": v.get("reason"),
                    "input": v.get("input") or {},
                }
                for k, v in self.pending.items()
            ],
        )

    def emit(self, events: list[dict[str, Any]]) -> None:
        for e in events:
            append_event(self.name, e["kind"], e["summary"], e.get("extra") or {})

    async def can_use_tool(self, tool_name: str, tool_input: dict[str, Any], ctx: Any) -> Any:
        from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny

        tool_use_id = getattr(ctx, "tool_use_id", None) or f"anon-{len(self.pending)+1}"
        decision = policy_mod.decide(tool_name, tool_input, self.policy)
        if decision == "deny":
            return PermissionResultDeny(message=f"policy deny {tool_name}")
        auto = decision == "allow" and self.lock != "operator"
        if auto:
            return PermissionResultAllow()
        # park (ask, or allow-while-held)
        reason = "held" if (decision == "allow" and self.lock == "operator") else "ask"
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self.pending[tool_use_id] = {
            "future": fut,
            "tool": tool_name,
            "input": tool_input,
            "reason": reason,
        }
        self.persist()
        self.emit(
            classify.from_parked_can_use_tool(
                tool_name=tool_name, tool_use_id=tool_use_id, reason=reason
            )
        )
        try:
            result = await asyncio.wait_for(asyncio.shield(fut), timeout=PERMISSION_TIMEOUT_S)
        except asyncio.TimeoutError:
            self.pending.pop(tool_use_id, None)
            self.persist()
            return PermissionResultDeny(message="permission timeout")
        except asyncio.CancelledError:
            self.pending.pop(tool_use_id, None)
            self.persist()
            return PermissionResultDeny(message="cancelled")
        finally:
            self.pending.pop(tool_use_id, None)
            self.persist()
        return result

    async def on_hook(self, hook_input: Any, tool_use_id: str | None) -> dict[str, Any]:
        payload: dict[str, Any]
        if isinstance(hook_input, dict):
            payload = dict(hook_input)
        else:
            payload = getattr(hook_input, "__dict__", {}) or {}
        ev_name = payload.get("hook_event_name") or payload.get("hook_event") or ""
        if tool_use_id and "tool_use_id" not in payload:
            payload["tool_use_id"] = tool_use_id
        self.emit(classify.from_hook(str(ev_name), payload))
        sid = payload.get("session_id")
        if sid and not self.sdk_session_id:
            self.sdk_session_id = str(sid)
            self.persist()
        return {}

    async def receive_loop(self) -> None:
        from claude_agent_sdk import (
            AssistantMessage,
            ResultMessage,
            TaskNotificationMessage,
            ToolUseBlock,
        )

        try:
            async for msg in self.client.receive_messages():
                self._ingest_session_id(msg)
                if isinstance(msg, ResultMessage):
                    if getattr(msg, "session_id", None):
                        self.sdk_session_id = msg.session_id
                        self.persist()
                    self.emit(
                        classify.from_result(
                            is_error=bool(msg.is_error),
                            session_id=getattr(msg, "session_id", None),
                            result=getattr(msg, "result", None),
                        )
                    )
                elif isinstance(msg, TaskNotificationMessage):
                    self.emit(
                        classify.from_task_notification(
                            status=str(msg.status),
                            summary=getattr(msg, "summary", "") or "",
                            task_id=getattr(msg, "task_id", "") or "",
                        )
                    )
                elif isinstance(msg, AssistantMessage):
                    for block in getattr(msg, "content", None) or []:
                        if isinstance(block, ToolUseBlock):
                            self.emit(
                                classify.from_tool_use(
                                    name=block.name,
                                    tool_use_id=getattr(block, "id", "") or "",
                                    tool_input=getattr(block, "input", None) or {},
                                )
                            )
                        else:
                            self.emit(
                                [
                                    {
                                        "kind": "working",
                                        "summary": "assistant",
                                        "extra": {"type": type(block).__name__},
                                    }
                                ]
                            )
                else:
                    subtype = getattr(msg, "subtype", None) or type(msg).__name__
                    self.emit(
                        [{"kind": "working", "summary": str(subtype), "extra": {"type": type(msg).__name__}}]
                    )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.alive = False
            self.emit(classify.from_process_death(error=f"{type(exc).__name__}: {exc}"))
            self.persist()
        else:
            if self.alive:
                self.alive = False
                self.emit(classify.from_process_death(error="receive loop closed"))
                self.persist()

    def _ingest_session_id(self, msg: Any) -> None:
        for key in ("session_id",):
            val = getattr(msg, key, None)
            if val:
                self.sdk_session_id = str(val)
                return
        data = getattr(msg, "data", None)
        if isinstance(data, dict) and data.get("session_id"):
            self.sdk_session_id = str(data["session_id"])


class Host:
    def __init__(self) -> None:
        self.sessions: dict[str, Session] = {}

    async def dispatch(self, req: dict[str, Any]) -> dict[str, Any]:
        cmd = req.get("cmd")
        fn = {
            "ping": self.cmd_ping,
            "start": self.cmd_start,
            "send": self.cmd_send,
            "interrupt": self.cmd_interrupt,
            "hold": self.cmd_hold,
            "release": self.cmd_release,
            "approve": self.cmd_approve,
            "deny": self.cmd_deny,
            "stop": self.cmd_stop,
            "status": self.cmd_status,
            "events": self.cmd_events,
            "shutdown": self.cmd_shutdown,
        }.get(cmd)
        if not fn:
            return {"ok": False, "error": f"unknown cmd {cmd}"}
        return await fn(req)

    async def cmd_ping(self, req: dict[str, Any]) -> dict[str, Any]:
        return {"ok": True, "pid": os.getpid()}

    async def cmd_start(self, req: dict[str, Any]) -> dict[str, Any]:
        from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient, HookMatcher

        name = req.get("name")
        cwd = req.get("cwd")
        prompt = req.get("prompt")
        resume_id = req.get("resume_id")
        if not name or not cwd or prompt is None:
            return {"ok": False, "error": "start requires name, cwd, prompt"}
        if name in self.sessions and self.sessions[name].alive:
            return {"ok": False, "error": f"session {name} already live"}
        if name in self.sessions:
            await self._teardown(name)
        sess = Session(name, cwd)
        self.sessions[name] = sess

        async def hook_cb(hook_input, tool_use_id, context):
            return await sess.on_hook(hook_input, tool_use_id)

        matcher = HookMatcher(hooks=[hook_cb], timeout=30.0)
        hooks = {ev: [matcher] for ev in HOOK_EVENTS}

        common: dict[str, Any] = dict(
            cli_path=str(CLI_PATH),
            cwd=cwd,
            system_prompt={"type": "preset", "preset": "claude_code"},
            include_hook_events=True,
            forward_subagent_text=True,
            can_use_tool=sess.can_use_tool,
            permission_mode="default",
            setting_sources=["user", "project", "local"],
            hooks=hooks,
        )
        if resume_id:
            common["resume"] = resume_id
        try:
            options = ClaudeAgentOptions(
                tools={"type": "preset", "preset": "claude_code"},
                **common,
            )
        except TypeError:
            options = ClaudeAgentOptions(**common)

        client = ClaudeSDKClient(options)
        sess.client = client
        try:
            await client.connect(prompt)
        except Exception as exc:
            sess.alive = False
            sess.emit(classify.from_process_death(error=f"connect: {exc}"))
            sess.persist()
            return {"ok": False, "error": f"connect failed: {exc}"}

        sess.alive = True
        try:
            info = await client.get_server_info()
        except Exception:
            info = None
        sid = _session_id_from_info(info)
        if sid:
            sess.sdk_session_id = sid
        sess.persist()
        sess.emit(classify.from_sent(text=prompt))
        sess.emit([{"kind": "working", "summary": "connected", "extra": {}}])
        sess.recv_task = asyncio.create_task(sess.receive_loop(), name=f"recv-{name}")
        return {"ok": True, "name": name, "sdk_session_id": sess.sdk_session_id}

    async def cmd_send(self, req: dict[str, Any]) -> dict[str, Any]:
        sess = self._need(req.get("name"))
        if isinstance(sess, dict):
            return sess
        if sess.lock == "operator":
            return {"ok": False, "error": "held"}
        if not sess.client or not sess.alive:
            return {"ok": False, "error": "session not live"}
        text = req.get("text")
        if text is None:
            return {"ok": False, "error": "send requires text"}
        await sess.client.query(text)
        sess.emit(classify.from_sent(text=text))
        sess.emit([{"kind": "working", "summary": "query sent", "extra": {}}])
        return {"ok": True, "name": sess.name}

    async def cmd_interrupt(self, req: dict[str, Any]) -> dict[str, Any]:
        sess = self._need(req.get("name"))
        if isinstance(sess, dict):
            return sess
        if not sess.client:
            return {"ok": False, "error": "no client"}
        await sess.client.interrupt()
        sess.emit(classify.from_interrupted())
        return {"ok": True, "name": sess.name}

    async def cmd_hold(self, req: dict[str, Any]) -> dict[str, Any]:
        sess = self._need(req.get("name"))
        if isinstance(sess, dict):
            return sess
        sess.lock = "operator"
        sess.persist()
        sess.emit(classify.from_held())
        return {"ok": True, "name": sess.name, "lock": "operator"}

    async def cmd_release(self, req: dict[str, Any]) -> dict[str, Any]:
        sess = self._need(req.get("name"))
        if isinstance(sess, dict):
            return sess
        sess.lock = None
        sess.persist()
        upsert_session(sess.name, state="idle")
        return {"ok": True, "name": sess.name, "lock": None}

    async def cmd_approve(self, req: dict[str, Any]) -> dict[str, Any]:
        return await self._resolve_perm(req, allow=True)

    async def cmd_deny(self, req: dict[str, Any]) -> dict[str, Any]:
        return await self._resolve_perm(req, allow=False)

    async def _resolve_perm(self, req: dict[str, Any], allow: bool) -> dict[str, Any]:
        from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny

        sess = self._need(req.get("name"))
        if isinstance(sess, dict):
            return sess
        tid = req.get("tool_use_id")
        if not tid:
            return {"ok": False, "error": "tool_use_id required"}
        item = sess.pending.get(tid)
        if not item:
            return {"ok": False, "error": f"no pending {tid}"}
        fut = item["future"]
        if fut.done():
            return {"ok": False, "error": "already resolved"}
        if allow:
            fut.set_result(PermissionResultAllow())
        else:
            fut.set_result(PermissionResultDeny(message="operator deny"))
        return {"ok": True, "name": sess.name, "tool_use_id": tid, "allowed": allow}

    async def cmd_stop(self, req: dict[str, Any]) -> dict[str, Any]:
        name = req.get("name")
        if not name:
            return {"ok": False, "error": "name required"}
        if name not in self.sessions:
            return {"ok": False, "error": f"unknown session {name}"}
        await self._teardown(name)
        upsert_session(name, alive=False, state="dead")
        append_event(name, "dead", "stopped", {})
        return {"ok": True, "name": name}

    async def cmd_status(self, req: dict[str, Any]) -> dict[str, Any]:
        rows = []
        disk = {s["name"]: s for s in list_sessions()}
        names = set(disk) | set(self.sessions)
        for name in sorted(names):
            rec = dict(disk.get(name) or {"name": name})
            live = self.sessions.get(name)
            if live:
                rec["alive"] = live.alive
                rec["lock"] = live.lock
                rec["sdk_session_id"] = live.sdk_session_id
                rec["pending"] = [
                    {"tool_use_id": k, "tool": v.get("tool"), "reason": v.get("reason")}
                    for k, v in live.pending.items()
                ]
            rec.setdefault("last_turn", None)
            rec.setdefault("last_task", None)
            rec.setdefault("pending", [])
            rows.append(rec)
        return {"ok": True, "sessions": rows}

    async def cmd_events(self, req: dict[str, Any]) -> dict[str, Any]:
        from ccop.store import read_events

        name = req.get("name")
        if not name:
            return {"ok": False, "error": "name required"}
        evs = read_events(name, tail=req.get("tail"))
        return {"ok": True, "name": name, "events": evs}

    async def cmd_shutdown(self, req: dict[str, Any]) -> dict[str, Any]:
        for name in list(self.sessions):
            try:
                await self._teardown(name)
            except Exception:
                pass
        asyncio.get_running_loop().call_later(0.05, _stop_loop)
        return {"ok": True}

    def _need(self, name: str | None) -> Session | dict[str, Any]:
        if not name:
            return {"ok": False, "error": "name required"}
        sess = self.sessions.get(name)
        if not sess:
            return {"ok": False, "error": f"unknown session {name}"}
        return sess

    async def _teardown(self, name: str) -> None:
        sess = self.sessions.pop(name, None)
        if not sess:
            return
        for item in list(sess.pending.values()):
            fut = item.get("future")
            if fut and not fut.done():
                fut.cancel()
        sess.alive = False
        if sess.recv_task:
            sess.recv_task.cancel()
            try:
                await sess.recv_task
            except (asyncio.CancelledError, Exception):
                pass
        if sess.client:
            try:
                await sess.client.disconnect()
            except Exception:
                pass
        sess.persist()


def _session_id_from_info(info: Any) -> str | None:
    if not info:
        return None
    if isinstance(info, dict):
        for k in ("session_id", "sessionId", "sessionID"):
            if info.get(k):
                return str(info[k])
        data = info.get("data")
        if isinstance(data, dict):
            for k in ("session_id", "sessionId"):
                if data.get(k):
                    return str(data[k])
    return None


def _stop_loop() -> None:
    loop = asyncio.get_event_loop()
    loop.stop()


async def _handle(host: Host, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        line = await reader.readline()
        if not line:
            return
        try:
            req = json.loads(line.decode())
        except json.JSONDecodeError as exc:
            writer.write((json.dumps({"ok": False, "error": f"bad json: {exc}"}) + "\n").encode())
            await writer.drain()
            return
        try:
            res = await host.dispatch(req)
        except Exception as exc:
            res = {"ok": False, "error": f"{type(exc).__name__}: {exc}", "trace": traceback.format_exc()}
        writer.write((json.dumps(res, default=str) + "\n").encode())
        await writer.drain()
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def serve() -> None:
    ensure_data()
    if SOCK_PATH.exists():
        try:
            SOCK_PATH.unlink()
        except OSError:
            pass
    host = Host()
    server = await asyncio.start_unix_server(lambda r, w: _handle(host, r, w), path=str(SOCK_PATH))
    PID_PATH.write_text(str(os.getpid()) + "\n")
    os.chmod(SOCK_PATH, 0o600)

    stopping = asyncio.Event()

    def _sig(*_a):
        stopping.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _sig)
        except NotImplementedError:
            pass

    async with server:
        serve_task = asyncio.create_task(server.serve_forever())
        await stopping.wait()
        serve_task.cancel()
        await host.cmd_shutdown({})
        try:
            await serve_task
        except (asyncio.CancelledError, RuntimeError):
            pass
    try:
        SOCK_PATH.unlink(missing_ok=True)
    except OSError:
        pass


def main() -> None:
    ensure_data()
    # keep stderr for daemon.log redirection by supervisor
    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
