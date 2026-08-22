from ccop.policy import bash_denied, decide, load_policy


def test_allow_read_grep_glob():
    for t in ("Read", "Grep", "Glob"):
        assert decide(t, {"file_path": "/tmp/x"}) == "allow"


def test_ask_write_edit_bash_safe():
    assert decide("Write", {"file_path": "/workspace/hello-cc/hello.py"}) == "ask"
    assert decide("Edit", {"file_path": "/workspace/hello-cc/hello.py"}) == "ask"
    assert decide("Bash", {"command": "python3 hello.py"}) == "ask"
    assert decide("AskUserQuestion", {"questions": []}) == "ask"


def test_deny_rm_rf_root():
    assert decide("Bash", {"command": "rm -rf /"}) == "deny"
    assert decide("Bash", {"command": "echo hi; rm -rf / && true"}) == "deny"
    assert bash_denied("rm -rf /")


def test_deny_sudo():
    assert decide("Bash", {"command": "sudo apt-get update"}) == "deny"
    assert bash_denied("sudo reboot")


def test_deny_write_etc_usr():
    assert decide("Bash", {"command": "echo x > /etc/passwd"}) == "deny"
    assert decide("Bash", {"command": "echo x >> /usr/bin/evil"}) == "deny"
    assert decide("Bash", {"command": "tee /etc/cron.d/x"}) == "deny"
    assert decide("Bash", {"command": "cp foo /usr/local/bin/x"}) == "deny"


def test_safe_bash_not_denied():
    assert bash_denied("python3 hello.py") is None
    assert bash_denied("ls /usr") is None  # read listing is not a write
    assert decide("Bash", {"command": "ls /usr"}) == "ask"


def test_load_policy_file():
    pol = load_policy()
    assert "Read" in pol["allow"]
