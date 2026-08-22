"""python -m ccop — JSON-in/JSON-out operator CLI for the parent assistant."""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from typing import Any

from ccop.paths import LOG_PATH, PID_PATH, SOCK_PATH, VENV_PYTHON, ensure_data


def _out(obj: dict[str, Any], code: int = 0) -> None:
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()
    raise SystemExit(code)


def _daemon_alive() -> int | None:
    from ccop.ipc import ping

    if ping():
        if PID_PATH.exists():
            try:
                return int(PID_PATH.read_text().strip())
            except ValueError:
                return 0
        return 0
    return None


def cmd_up() -> None:
    ensure_data()
    pid = _daemon_alive()
    if pid is not None:
        _out({"ok": True, "pid": pid, "already": True})
    env = os.environ.copy()
    pp = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = "/workspace" + (os.pathsep + pp if pp else "")
    log = open(LOG_PATH, "ab", buffering=0)
    proc = subprocess.Popen(
        [str(VENV_PYTHON), "-m", "ccop", "_serve"],
        cwd="/workspace",
        env=env,
        stdout=log,
        stderr=log,
        start_new_session=True,
    )
    PID_PATH.write_text(str(proc.pid) + "\n")
    deadline = time.time() + 15
    while time.time() < deadline:
        if _daemon_alive() is not None:
            _out({"ok": True, "pid": proc.pid, "already": False})
        if proc.poll() is not None:
            tail = ""
            if LOG_PATH.exists():
                tail = LOG_PATH.read_text(errors="replace")[-2000:]
            _out({"ok": False, "error": f"daemon exited {proc.returncode}", "log_tail": tail}, 1)
        time.sleep(0.1)
    _out({"ok": False, "error": "daemon did not open socket"}, 1)


def cmd_down() -> None:
    from ccop.ipc import ping, send_req

    if ping():
        try:
            send_req({"cmd": "shutdown"}, timeout=5.0)
        except OSError:
            pass
    pid = None
    if PID_PATH.exists():
        try:
            pid = int(PID_PATH.read_text().strip())
        except ValueError:
            pid = None
    if pid:
        for _ in range(20):
            try:
                os.kill(pid, 0)
            except OSError:
                break
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                break
            time.sleep(0.1)
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    if SOCK_PATH.exists():
        try:
            SOCK_PATH.unlink()
        except OSError:
            pass
    _out({"ok": True})


def _rpc(req: dict[str, Any], timeout: float = 60.0) -> None:
    from ccop.ipc import send_req

    try:
        res = send_req(req, timeout=timeout)
    except OSError as exc:
        _out({"ok": False, "error": f"daemon not reachable: {exc}"}, 1)
    _out(res, 0 if res.get("ok") else 1)


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m ccop")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("up")
    sub.add_parser("down")
    sub.add_parser("_serve")
    sub.add_parser("status")

    st = sub.add_parser("start")
    st.add_argument("name")
    st.add_argument("--cwd", required=True)
    st.add_argument("--prompt", required=True)
    st.add_argument("--resume-id", dest="resume_id", default=None)

    se = sub.add_parser("send")
    se.add_argument("name")
    se.add_argument("text")

    for n in ("interrupt", "hold", "release", "stop"):
        sp = sub.add_parser(n)
        sp.add_argument("name")

    ap = sub.add_parser("approve")
    ap.add_argument("name")
    ap.add_argument("tool_use_id")
    dn = sub.add_parser("deny")
    dn.add_argument("name")
    dn.add_argument("tool_use_id")

    ev = sub.add_parser("events")
    ev.add_argument("name")
    ev.add_argument("--tail", type=int, default=None)

    args = p.parse_args(argv)
    cmd = args.cmd
    if cmd == "up":
        cmd_up()
    if cmd == "down":
        cmd_down()
    if cmd == "_serve":
        from ccop.daemon import main as serve_main

        serve_main()
        return
    if cmd == "status":
        _rpc({"cmd": "status"})
    if cmd == "start":
        _rpc(
            {
                "cmd": "start",
                "name": args.name,
                "cwd": args.cwd,
                "prompt": args.prompt,
                "resume_id": args.resume_id,
            },
            timeout=120.0,
        )
    if cmd == "send":
        _rpc({"cmd": "send", "name": args.name, "text": args.text})
    if cmd in ("interrupt", "hold", "release", "stop"):
        _rpc({"cmd": cmd, "name": args.name})
    if cmd == "approve":
        _rpc({"cmd": "approve", "name": args.name, "tool_use_id": args.tool_use_id})
    if cmd == "deny":
        _rpc({"cmd": "deny", "name": args.name, "tool_use_id": args.tool_use_id})
    if cmd == "events":
        _rpc({"cmd": "events", "name": args.name, "tail": args.tail})


if __name__ == "__main__":
    main()
