"""Unix-socket JSON request/response."""

from __future__ import annotations

import json
import socket
from typing import Any

from ccop.paths import SOCK_PATH


def send_req(req: dict[str, Any], timeout: float = 30.0) -> dict[str, Any]:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(str(SOCK_PATH))
        s.sendall((json.dumps(req) + "\n").encode())
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
        if not buf.strip():
            return {"ok": False, "error": "empty daemon response"}
        return json.loads(buf.decode())
    finally:
        s.close()


def ping() -> bool:
    try:
        r = send_req({"cmd": "ping"}, timeout=2.0)
        return bool(r.get("ok"))
    except OSError:
        return False
