# ccop notes (P1 honesty)

This is an Agent SDK host: one daemon owns live ClaudeSDKClient
connections. The assistant drives it with `python -m ccop` JSON I/O
and Reads files under /workspace/ccop/data/.

TUI attach is not provided. There is no tmux, no pixels, no
interactive Claude Code screen. That is the accepted P1 gap.

send always uses client.query on the live client (P3). hold sets
lock=operator and blocks send plus auto-allow (P4). ResultMessage
is turn_done only, not task finished (P6).
