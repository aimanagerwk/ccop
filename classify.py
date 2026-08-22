"""P2/P6 event classifier. Pure functions — unit-tested, no live API."""

from __future__ import annotations

from typing import Any

KINDS = (
    "working",
    "needs_decision",
    "needs_info",
    "turn_done",
    "task_done",
    "failed",
    "idle",
    "held",
    "dead",
    "sent",
    "interrupted",
)


def _ev(kind: str, summary: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    if kind not in KINDS:
        raise ValueError(f"unknown kind {kind}")
    return {"kind": kind, "summary": summary, "extra": extra or {}}


def from_result(*, is_error: bool, session_id: str | None = None, result: str | None = None) -> list[dict[str, Any]]:
    """ResultMessage → turn_done. is_error also failed. Never task_done."""
    extra = {"session_id": session_id, "result": result, "is_error": is_error}
    out = [_ev("turn_done", "result message (turn, not task)", extra)]
    if is_error:
        out.append(_ev("failed", "result is_error", extra))
    else:
        out.append(_ev("idle", "turn complete, waiting", extra))
    return out


def from_task_notification(*, status: str, summary: str = "", task_id: str = "") -> list[dict[str, Any]]:
    extra = {"status": status, "task_id": task_id}
    st = (status or "").lower()
    if st == "completed":
        return [_ev("task_done", summary or "task completed", extra)]
    if st in ("failed", "killed"):
        return [_ev("failed", summary or f"task {st}", extra)]
    if st == "stopped":
        return [_ev("interrupted", summary or "task stopped", extra)]
    return [_ev("working", summary or f"task {st}", extra)]


def from_tool_use(*, name: str, tool_use_id: str = "", tool_input: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    extra = {"tool": name, "tool_use_id": tool_use_id, "input": tool_input or {}}
    if name == "AskUserQuestion":
        return [
            _ev("needs_info", "AskUserQuestion", extra),
            _ev("needs_decision", "AskUserQuestion parked", extra),
        ]
    return [_ev("working", f"tool {name}", extra)]


def from_permission_request(*, tool_name: str, tool_use_id: str = "") -> list[dict[str, Any]]:
    extra = {"tool": tool_name, "tool_use_id": tool_use_id}
    return [_ev("needs_decision", f"PermissionRequest {tool_name}", extra)]


def from_parked_can_use_tool(*, tool_name: str, tool_use_id: str = "", reason: str = "ask") -> list[dict[str, Any]]:
    extra = {"tool": tool_name, "tool_use_id": tool_use_id, "reason": reason}
    evs = [_ev("needs_decision", f"can_use_tool parked {tool_name}", extra)]
    if tool_name == "AskUserQuestion":
        evs.insert(0, _ev("needs_info", "AskUserQuestion", extra))
    return evs


def from_process_death(*, error: str = "") -> list[dict[str, Any]]:
    extra = {"error": error}
    return [
        _ev("failed", error or "process death", extra),
        _ev("dead", "receive loop ended", extra),
    ]


def from_sent(*, text: str = "") -> list[dict[str, Any]]:
    return [_ev("sent", (text or "")[:200], {})]


def from_interrupted() -> list[dict[str, Any]]:
    return [_ev("interrupted", "interrupt", {})]


def from_held() -> list[dict[str, Any]]:
    return [_ev("held", "lock=operator", {})]


def from_hook(hook_event_name: str, payload: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    payload = payload or {}
    name = hook_event_name
    extra = {"hook": name, **{k: payload.get(k) for k in ("tool_name", "tool_use_id") if k in payload}}
    if name == "PermissionRequest":
        return from_permission_request(
            tool_name=str(payload.get("tool_name") or ""),
            tool_use_id=str(payload.get("tool_use_id") or ""),
        )
    if name == "PostToolUseFailure":
        return [_ev("working", f"PostToolUseFailure {payload.get('tool_name', '')}", extra)]
    if name in ("PreToolUse", "PostToolUse", "SubagentStart", "Notification"):
        return [_ev("working", name, extra)]
    if name == "Stop":
        return [_ev("working", "Stop hook", extra)]
    if name == "SubagentStop":
        return [_ev("working", "SubagentStop", extra)]
    return [_ev("working", name, extra)]
