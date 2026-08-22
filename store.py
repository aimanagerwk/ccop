"""sessions.json + events/<name>.jsonl. Files the assistant Reads."""

from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from typing import Any

from ccop.paths import EVENTS, SESSIONS_PATH, ensure_data

try:
    import fcntl
except ImportError:
    fcntl = None  # type: ignore


@contextmanager
def _locked(path):
    ensure_data()
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text('{"sessions":{}}\n')
    fh = open(path, "r+")
    try:
        if fcntl:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        yield fh
    finally:
        if fcntl:
            try:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
        fh.close()


def load_sessions() -> dict[str, Any]:
    ensure_data()
    if not SESSIONS_PATH.exists():
        return {"sessions": {}}
    try:
        return json.loads(SESSIONS_PATH.read_text() or '{"sessions":{}}')
    except json.JSONDecodeError:
        return {"sessions": {}}


def upsert_session(name: str, **fields: Any) -> dict[str, Any]:
    with _locked(SESSIONS_PATH) as fh:
        try:
            data = json.loads(fh.read() or '{"sessions":{}}')
        except json.JSONDecodeError:
            data = {"sessions": {}}
        sess = data.setdefault("sessions", {}).setdefault(name, {"name": name})
        sess.update(fields)
        sess["name"] = name
        sess["updated_ts"] = time.time()
        fh.seek(0)
        fh.truncate()
        json.dump(data, fh, indent=2)
        fh.write("\n")
        return dict(sess)


def list_sessions() -> list[dict[str, Any]]:
    data = load_sessions()
    return list((data.get("sessions") or {}).values())


def append_event(name: str, kind: str, summary: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    ensure_data()
    ev = {
        "ts": time.time(),
        "name": name,
        "kind": kind,
        "summary": summary,
        "extra": extra or {},
    }
    path = EVENTS / f"{name}.jsonl"
    with open(path, "a") as fh:
        if fcntl:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        fh.write(json.dumps(ev, default=str) + "\n")
        if fcntl:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
    # keep last_turn / last_task distinct (P6)
    patch: dict[str, Any] = {"state": kind, "last_kind": kind}
    rec = {"kind": kind, "ts": ev["ts"], "summary": summary}
    if kind == "turn_done":
        patch["last_turn"] = rec
    elif kind == "task_done":
        patch["last_task"] = rec
    elif kind == "failed":
        patch["last_error"] = rec
    upsert_session(name, **patch)
    return ev


def read_events(name: str, tail: int | None = None) -> list[dict[str, Any]]:
    path = EVENTS / f"{name}.jsonl"
    if not path.exists():
        return []
    lines = path.read_text().splitlines()
    if tail is not None:
        lines = lines[-int(tail) :]
    out = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out
