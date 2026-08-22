from claude_agent_sdk import ClaudeAgentOptions
opts = ClaudeAgentOptions(
    cli_path="/home/box/.local/bin/claude",
    cwd="/workspace/hello-cc",
    system_prompt={"type": "preset", "preset": "claude_code"},
    tools={"type": "preset", "preset": "claude_code"},
    include_hook_events=True,
    forward_subagent_text=True,
    permission_mode="default",
    setting_sources=["user", "project", "local"],
)
print("ok_options", type(opts).__name__, bool(opts.tools), opts.setting_sources)
