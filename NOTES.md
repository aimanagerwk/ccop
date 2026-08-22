# ccop notes (P1 honesty)

This is an Agent SDK host: one daemon owns live ClaudeSDKClient
(or the TypeScript query() streaming-input equivalent) connections.
The assistant drives it with `npx tsx src/cli.ts` JSON I/O
and Reads files under /workspace/ccop/data/.

TUI attach is not provided. There is no tmux, no pixels, no
interactive Claude Code screen. That is the accepted P1 gap.

send always uses client.query on the live client (P3). hold sets
lock=operator and blocks send plus auto-allow (P4). ResultMessage
is turn_done only, not task finished (P6).

Identity: id is the Claude session UUID (options.sessionId / resume). title is Claude display (customTitle/summary). name is an optional operator label, not a key.

## Invoke (TypeScript)

    npx tsx src/cli.ts up|down|status
    npx tsx src/cli.ts start --cwd DIR --prompt TEXT [--name LABEL] [--resume-id UUID]
    npx tsx src/cli.ts send ID TEXT
    npx tsx src/cli.ts interrupt|hold|release|stop ID
    npx tsx src/cli.ts approve|deny ID tool_use_id
    npx tsx src/cli.ts events ID [--tail N]

npm scripts: `npm start -- <cmd>`, `npm run up`, `npm test`.

P1-P8 writeup: DESIGN.md. Commands and JSON: README.md
(Chinese primary). Do not treat README as a user-facing product page.

## Policy / classify

- allow: Read, Grep, Glob
- ask: Write, Edit, Bash, AskUserQuestion, ...
- deny: bash `rm -rf /`, `sudo `, writes under /etc and /usr
- park canUseTool until approve/deny (or hold forces park)
- last_turn vs last_task are distinct fields

## Do not

- git commit/push unless asked
- commit data/, secrets, tokens, ~/.claude settings
- resume a live `claude --bg` session with `-p` or with this host


## TypeScript SDK mapping (0.3.x)

The official TS package exports query / CanUseTool / PermissionResult
({behavior: allow|deny}). It does not export a ClaudeSDKClient class
(that name is Python). The daemon wraps query() with a streaming
AsyncIterable prompt so send/interrupt stay on one live client.
Helper functions PermissionResultAllow/Deny match the Python names.
