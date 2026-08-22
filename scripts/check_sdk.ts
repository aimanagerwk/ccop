import { query } from "@anthropic-ai/claude-agent-sdk";

const opts = {
  pathToClaudeCodeExecutable: "/home/box/.local/bin/claude",
  cwd: "/workspace/hello-cc",
  systemPrompt: { type: "preset" as const, preset: "claude_code" as const },
  tools: { type: "preset" as const, preset: "claude_code" as const },
  includeHookEvents: true,
  forwardSubagentText: true,
  permissionMode: "default" as const,
  settingSources: ["user", "project", "local"] as const,
};
console.log("ok_options", typeof query, Boolean(opts.tools), opts.settingSources);
