"""Live smoke: start, hold/send, approve, wait for hello.py + turn_done."""

from __future__ import annotations

import json
import os
import sys
import time
from io import StringIO
from pathlib import Path

from ccop.__main__ import main
from ccop.store import read_events

HELLO = Path("/workspace/hello-cc/hello.py")
PROMPT = (
    "Create or overwrite hello.py that prints Hello, world! "
    "then run it with python3."
)


def rpc(argv: list[str]) -> dict:
    buf = StringIO()
    old = sys.stdout
    sys.stdout = buf
    code = 0
    try:
        main(argv)
    except SystemExit as e:
        code = int(e.code or 0)
    finally:
        sys.stdout = old
    text = buf.getvalue().strip()
    try:
        obj = json.loads(text) if text else {"ok": False, "error": "empty"}
    except json.JSONDecodeError:
        obj = {"ok": False, "error": "non-json", "raw": text[:500]}
    obj["_code"] = code
    return obj


def kinds(name: str) -> set[str]:
    return {e["kind"] for e in read_events(name)}


def main_smoke() -> int:
    print("== up")
    print(rpc(["up"]))
    print("== up again (idempotent)")
    print(rpc(["up"]))

    print("== start smoke")
    st = rpc(
        [
            "start",
            "smoke",
            "--cwd",
            "/workspace/hello-cc",
            "--prompt",
            PROMPT,
        ]
    )
    print({k: st[k] for k in st if k != "trace"})
    if not st.get("ok"):
        log = Path("/workspace/ccop/data/daemon.log")
        if log.exists():
            tail = log.read_text(errors="replace")[-3000:]
            # never dump auth tokens
            for tok in ("ANTHROPIC_AUTH_TOKEN", "sk-ant-", "Bearer "):
                if tok in tail:
                    tail = "[log redacted: contains secret-like token]"
                    break
            print("daemon.log tail:", tail)
        return 1

    print("== hold")
    print(rpc(["hold", "smoke"]))
    print("== send while held (expect error)")
    held = rpc(["send", "smoke", "ignore this"])
    print(held)
    if held.get("ok") or held.get("error") != "held":
        print("FAIL: expected held error")
        return 1
    print("== release")
    print(rpc(["release", "smoke"]))

    deadline = time.time() + 240
    approved = set()
    hello_ok = False
    while time.time() < deadline:
        st = rpc(["status"])
        sessions = {s["name"]: s for s in st.get("sessions") or []}
        s = sessions.get("smoke") or {}
        pending = s.get("pending") or []
        for p in pending:
            tid = p.get("tool_use_id")
            if tid and tid not in approved:
                print("approve", tid, p.get("tool"), p.get("reason"))
                print(rpc(["approve", "smoke", tid]))
                approved.add(tid)
        ks = kinds("smoke")
        if HELLO.exists():
            text = HELLO.read_text()
            if "Hello" in text:
                hello_ok = True
        if hello_ok and ("turn_done" in ks or "task_done" in ks):
            print("== done kinds", sorted(ks))
            break
        if "dead" in ks or "failed" in ks:
            # keep going a bit unless dead without progress
            if "dead" in ks and not hello_ok:
                print("session dead early", sorted(ks))
                evs = read_events("smoke")
                print("last events", evs[-8:])
                return 1
        time.sleep(1.0)
    else:
        print("TIMEOUT kinds", sorted(kinds("smoke")))
        print("status", rpc(["status"]))
        print("events tail", read_events("smoke")[-15:])
        return 1

    print("== hello.py")
    print(HELLO.read_text())
    print("== status")
    status = rpc(["status"])
    print(json.dumps(status, indent=2, default=str)[:4000])
    smoke = [x for x in status.get("sessions") or [] if x.get("name") == "smoke"][0]
    assert "last_turn" in smoke and "last_task" in smoke
    print("== stop")
    print(rpc(["stop", "smoke"]))
    print("== down")
    print(rpc(["down"]))
    print("SMOKE_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main_smoke())
