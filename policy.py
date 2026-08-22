"""P5 permission policy. Pure functions — unit-tested, no live API."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Literal

Decision = Literal["allow", "ask", "deny"]

DEFAULT_ALLOW = ("Read", "Grep", "Glob")
DEFAULT_BASH_SUBSTR = ("rm -rf /", "sudo ")
DEFAULT_WRITE_PREFIXES = ("/etc", "/usr")

_REDIRECT = re.compile(
    r"(?:>>?|tee(?:\s+-a)?)\s*['\"]?(/etc(?:/|\s|$)|/usr(?:/|\s|$))",
    re.I,
)
_COPY_DEST = re.compile(
    r"\b(?:cp|mv|install|dd|install\s+-m\s+\S+)\s+.+\s+['\"]?(/etc(?:/|\s|$)|/usr(?:/|\s|$))",
    re.I,
)


def load_policy(path: Path | None = None) -> dict[str, Any]:
    p = path
    if p is None:
        from ccop.paths import POLICY_PATH

        p = POLICY_PATH
    if not p.exists():
        return {
            "allow": list(DEFAULT_ALLOW),
            "ask": ["*"],
            "deny": {
                "bash_substrings": list(DEFAULT_BASH_SUBSTR),
                "write_prefixes": list(DEFAULT_WRITE_PREFIXES),
            },
        }
    try:
        import yaml
    except ImportError:
        yaml = None  # type: ignore
    text = p.read_text()
    if yaml is not None:
        data = yaml.safe_load(text) or {}
    else:
        data = _minimal_yaml(text)
    data.setdefault("allow", list(DEFAULT_ALLOW))
    data.setdefault("ask", ["*"])
    data.setdefault("deny", {})
    return data


def _minimal_yaml(text: str) -> dict[str, Any]:
    """Tiny fallback if PyYAML is missing."""
    out: dict[str, Any] = {"allow": [], "ask": [], "deny": {"bash_substrings": [], "write_prefixes": []}}
    section = None
    deny_key = None
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        if not line.startswith(" ") and line.endswith(":"):
            section = line[:-1].strip()
            deny_key = None
            continue
        item = line.strip()
        if item.startswith("- "):
            val = item[2:].strip().strip("'\"")
            if section == "allow":
                out["allow"].append(val)
            elif section == "ask":
                out["ask"].append(val)
            elif section == "deny" and deny_key:
                out["deny"][deny_key].append(val)
        elif section == "deny" and item.endswith(":"):
            deny_key = item[:-1].strip()
            out["deny"].setdefault(deny_key, [])
    return out


def bash_denied(command: str, policy: dict[str, Any] | None = None) -> str | None:
    """Return deny reason or None."""
    deny = (policy or {}).get("deny") or {}
    subs = deny.get("bash_substrings") or list(DEFAULT_BASH_SUBSTR)
    prefixes = deny.get("write_prefixes") or list(DEFAULT_WRITE_PREFIXES)
    for s in subs:
        if s in command:
            return f"bash substring {s!r}"
    if _REDIRECT.search(command) or _COPY_DEST.search(command):
        return "bash write under /etc or /usr"
    for pref in prefixes:
        # explicit path write: > /etc/foo  already covered; also bare dest tokens
        if re.search(rf"(>>?|tee(?:\s+-a)?)\s*['\"]?{re.escape(pref)}(?:/|\s|$)", command, re.I):
            return f"bash write under {pref}"
    return None


def decide(tool_name: str, tool_input: dict[str, Any] | None = None, policy: dict[str, Any] | None = None) -> Decision:
    tool_input = tool_input or {}
    pol = policy if policy is not None else load_policy()
    allow = {t.lower() for t in (pol.get("allow") or DEFAULT_ALLOW)}
    name = tool_name or ""
    # AskUserQuestion is always ask (needs_info).
    if name.lower() == "bash":
        reason = bash_denied(str(tool_input.get("command") or ""), pol)
        if reason:
            return "deny"
    if name.lower() in allow:
        return "allow"
    return "ask"
