"""Filesystem layout for the operator."""

from pathlib import Path

ROOT = Path("/workspace/ccop")
DATA = ROOT / "data"
EVENTS = DATA / "events"
SESSIONS_PATH = DATA / "sessions.json"
POLICY_PATH = DATA / "policy.yaml"
SOCK_PATH = DATA / "ccop.sock"
PID_PATH = DATA / "daemon.pid"
LOG_PATH = DATA / "daemon.log"
CLI_PATH = Path("/home/box/.local/bin/claude")
VENV_PYTHON = Path("/workspace/.venv-ccsdk/bin/python")
PERMISSION_TIMEOUT_S = 3600.0


def ensure_data() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    EVENTS.mkdir(parents=True, exist_ok=True)
