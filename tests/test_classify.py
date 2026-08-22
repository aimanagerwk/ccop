from ccop import classify


def test_result_is_turn_not_task():
    evs = classify.from_result(is_error=False, session_id="abc", result="ok")
    kinds = [e["kind"] for e in evs]
    assert "turn_done" in kinds
    assert "task_done" not in kinds
    assert "idle" in kinds


def test_result_error_failed():
    evs = classify.from_result(is_error=True, session_id="x")
    kinds = [e["kind"] for e in evs]
    assert "turn_done" in kinds
    assert "failed" in kinds
    assert "task_done" not in kinds


def test_task_completed_is_task_done():
    evs = classify.from_task_notification(status="completed", summary="done", task_id="t1")
    assert evs[0]["kind"] == "task_done"
    assert evs[0]["extra"]["task_id"] == "t1"


def test_task_failed():
    evs = classify.from_task_notification(status="failed", summary="boom")
    assert evs[0]["kind"] == "failed"


def test_ask_user_question():
    evs = classify.from_tool_use(name="AskUserQuestion", tool_use_id="u1")
    kinds = [e["kind"] for e in evs]
    assert "needs_info" in kinds
    assert "needs_decision" in kinds


def test_permission_request():
    evs = classify.from_permission_request(tool_name="Write", tool_use_id="w1")
    assert evs[0]["kind"] == "needs_decision"


def test_parked_can_use_tool():
    evs = classify.from_parked_can_use_tool(tool_name="Bash", tool_use_id="b1", reason="ask")
    assert evs[0]["kind"] == "needs_decision"
    evs = classify.from_parked_can_use_tool(tool_name="AskUserQuestion", tool_use_id="q1")
    kinds = [e["kind"] for e in evs]
    assert "needs_info" in kinds and "needs_decision" in kinds


def test_process_death():
    evs = classify.from_process_death(error="boom")
    kinds = [e["kind"] for e in evs]
    assert kinds == ["failed", "dead"]


def test_sent_interrupted_held():
    assert classify.from_sent(text="hi")[0]["kind"] == "sent"
    assert classify.from_interrupted()[0]["kind"] == "interrupted"
    assert classify.from_held()[0]["kind"] == "held"


def test_hook_permission_request():
    evs = classify.from_hook("PermissionRequest", {"tool_name": "Edit"})
    assert evs[0]["kind"] == "needs_decision"


def test_hook_tools_working():
    assert classify.from_hook("PreToolUse", {"tool_name": "Read"})[0]["kind"] == "working"
    assert classify.from_hook("PostToolUse", {})[0]["kind"] == "working"
