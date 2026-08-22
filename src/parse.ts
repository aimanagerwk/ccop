/** CLI argv → {cmd, args}. Exported for unit tests. */

export function parseArgs(argv: string[]): { cmd: string; args: Record<string, unknown> } {
  const [cmd, ...rest] = argv;
  if (!cmd) {
    process.stderr.write("usage: tsx src/cli.ts <up|down|start|send|...>  (session commands take ID)\n");
    process.exit(2);
  }
  const args: Record<string, unknown> = {};
  if (cmd === "start") {
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--cwd") args.cwd = rest[++i];
      else if (rest[i] === "--prompt") args.prompt = rest[++i];
      else if (rest[i] === "--resume-id") args.resume_id = rest[++i];
      else if (rest[i] === "--name" || rest[i] === "-n") args.name = rest[++i];
      else if (rest[i] === "--permission-mode") args.permission_mode = rest[++i];
    }
  } else if (cmd === "send") {
    args.id = rest[0];
    args.text = rest.slice(1).join(" ");
  } else if (
    [
      "interrupt",
      "hold",
      "release",
      "stop",
      "info",
      "workflows",
      "tasks",
      "subagents",
      "mcp",
      "plugins-reload",
      "skills-reload",
    ].includes(cmd)
  ) {
    args.id = rest[0];
  } else if (cmd === "task-stop") {
    args.id = rest[0];
    args.task_id = rest[1];
  } else if (cmd === "task-bg") {
    args.id = rest[0];
    if (rest[1]) args.tool_use_id = rest[1];
  } else if (cmd === "approve" || cmd === "deny") {
    args.id = rest[0];
    args.tool_use_id = rest[1];
  } else if (cmd === "events") {
    args.id = rest[0];
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "--tail") args.tail = parseInt(rest[++i], 10);
    }
  } else if (cmd === "mcp-set") {
    args.id = rest[0];
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "--json") args.json = rest[++i];
    }
  } else if (cmd === "mcp-reconnect") {
    args.id = rest[0];
    args.server = rest[1];
  } else if (cmd === "mcp-toggle") {
    args.id = rest[0];
    args.server = rest[1];
    for (let i = 2; i < rest.length; i++) {
      if (rest[i] === "--on") args.enabled = true;
      else if (rest[i] === "--off") args.enabled = false;
    }
  } else if (cmd === "wait") {
    args.id = rest[0];
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "--kind") args.kind = rest[++i];
      else if (rest[i] === "--timeout") args.timeout = parseInt(rest[++i], 10);
    }
  }
  return { cmd, args };
}
