# ccop HOST command-surface coverage (live)

Inventory is the user-facing CLI in `src/cli.ts` plus start flags and documented policy/lock/decision behaviors.
Not Claude MCP / plan / plugin coverage.

- Project cwd: `/workspace/hello-cc`
- Auto (product default, no flag): `cfab4ab6-8878-4047-a9cf-b45f99138839`
- Auto retry (hold/deny): `e2002286-259c-4af7-9f0f-b978636df939`
- Auto fix retest (write+hold): `62fe1bdd-3d65-4024-99a1-ae3f2084f630`
- Auto fix retest (sudo true): `12d5783c-8292-416c-a3dd-23630953b13d`
- Contrast `--permission-mode default`: `56c2aab7-6807-4d55-b76f-675f88d73abb`
- Results: {"ok": 44, "fail": 0, "skip": 1}
- PERMISSION_TIMEOUT_S=3600 → timeout row skipped
- Product default permissionMode is **auto**. `--permission-mode default` is contrast only.
- Daemon left up. No git commit/push.

| id | feature | attempted | evidence | result |
| --- | --- | --- | --- | --- |
| unknown-cmd | unknown cmd error | True | ok=false error=unknown cmd not-a-real-host-cmd | ok |
| down | down | True | ok=true | ok |
| missing-daemon | missing daemon error | True | ok=false daemon not reachable ENOENT ccop.sock | ok |
| up | up (restart after permissionMode default=auto) | True | ok=true pid=93635 already=false | ok |
| status | status | True | ok=true after up; sessions listed | ok |
| start-cwd-prompt | start --cwd --prompt | True | cfab4ab6-8878-4047-a9cf-b45f99138839 start ok cwd=/workspace/hello-cc | ok |
| start-name | start --name | True | name=host-cov on cfab4ab6 | ok |
| auto-mode-start-flag | start without --permission-mode is auto (product default) | True | cfab4ab6 permission_mode=auto; e2002286 retry also auto | ok |
| send | send | True | cfab4ab6 send pong ok=true | ok |
| hold | hold | True | ok=true id=cfab4ab6 lock=operator | ok |
| send-while-held | send-while-held expect held | True | ok=false error=held | ok |
| hold-read-parks | hold then Read that would auto-allow parks reason=held (even in auto) | True | 62fe1bdd: after PreToolUse ask-held, pending Read reason=held tool_use_id=call-2eff23d6; nPre=1 nPost=0. e2002286 prior fail. | ok |
| release | release | True | ok=true id=cfab4ab6 lock=null | ok |
| policy-allow-read | allow auto-pass Read/Grep/Glob without pending when not held | True | e2002286 read_auto sawRead=true parked=false pendingRead=false; cfab4ab6 tool Read call-7e355e1c Pre+Post no needs_decision | ok |
| release-then-read-auto | release then Read auto-allows again | True | e2002286 after release: second Read call-f67edac6 no park | ok |
| auto-allows-write-no-approve | auto (product default) allows in-project Write without host approve | True | cfab4ab6 wrote /workspace/hello-cc/auto-mode-probe.txt body=auto-ok; tool Write call-80ff120f; sawWritePend=false | ok |
| policy-deny-dangerous | deny by policy: sudo — PermissionResultDeny / no host approve | True | 12d5783c Bash sudo true: tool Bash + PreToolUse, nPost=0; turn_done The host denied the sudo true call. e2002286 prior fail (pwned ran). | ok |
| auto-policy-deny-still-blocks | auto + policy deny still blocks | True | 12d5783c PreToolUse permissionDecision=deny; no PostToolUse; model reported host deny. Auto Write still no pending (62fe1bdd auto-fix-probe.txt). | ok |
| ask-user-question | AskUserQuestion needs_info + needs_decision (auto: may not park pending) | True | cfab4ab6 call-d2f879fc needs_info + needs_decision + PermissionRequest + PostToolUse (no status.pending). 2 options red/blue. | ok |
| interrupt | interrupt | True | ok=true id=cfab4ab6; events kind=interrupted then turn_done is_error | ok |
| events | events | True | cfab4ab6 events ok n>=27 | ok |
| events-tail | events --tail | True | ok=true n=4 (<=5) | ok |
| events-truth | needs_decision vs turn_done vs task_done not confused | True | cfab4ab6 last_turn.kind=turn_done last_task=null has_needs_decision=true has_task_done=false | ok |
| info | info | True | ok=true effort=max permission_mode=auto | ok |
| workflows | workflows | True | ok=true nSkills=14 advertise only; host does not invoke | ok |
| tasks | tasks | True | ok=true n=0 | ok |
| task-stop | task-stop | True | ok=true task_id=no-such-task | ok |
| task-bg | task-bg | True | ok=true backgrounded=true tool_use_id=null | ok |
| subagents | subagents | True | ok=true source=sdk | ok |
| approve-unknown | approve unknown tool_use_id | True | ok=false error=no pending toolu_does_not_exist | ok |
| deny-unknown | deny unknown tool_use_id | True | ok=false error=no pending toolu_does_not_exist | ok |
| permission-timeout | permission timeout (PERMISSION_TIMEOUT_S=3600) | False | PERMISSION_TIMEOUT_S is 3600s; suite does not stall | skip |
| duplicate-live-start | duplicate live start same id | True | ok=false error=session cfab4ab6 already live | ok |
| stop | stop | True | ok=true id=cfab4ab6 | ok |
| start-resume-id | start --resume-id (resume a stopped session) | True | resume cfab4ab6 ok name=host-cov-resume permission_mode=auto | ok |
| permission-mode-default-contrast | start --permission-mode default (contrast only) | True | 56c2aab7-6807-4d55-b76f-675f88d73abb permission_mode=default | ok |
| policy-ask-write | ask parks Write/Edit/Bash under --permission-mode default | True | 56c2aab7 pending Write reason=ask call-5ef26622; events needs_decision parked Write | ok |
| pending-shape | pending list shows tool, tool_use_id, reason (ask vs held) | True | tool=Write tool_use_id=call-5ef26622 reason=ask | ok |
| default-mode-parks-write | default mode still parks Write (contrast vs auto) | True | same parked Write reason=ask on 56c2aab7 | ok |
| approve | approve | True | ok=true id=56c2aab7 tool_use_id=call-5ef26622 allowed=true | ok |
| approve-write-proceeds | approve parked in-project Write — tool proceeds | True | exists /workspace/hello-cc/host-cov-ok.txt after approve | ok |
| deny | deny | True | ok=true id=56c2aab7 tool_use_id=call-47e63c3c allowed=false | ok |
| deny-write-blocked | deny parked out-of-project Write — file does not happen | True | /tmp/ccop-host-cov-probe.txt exists=false; model said write denied | ok |
| ask-user-question-default | AskUserQuestion parks under default; deny tool_use_id | True | 56c2aab7 pending AskUserQuestion reason=ask call-83304e4d; needs_info + needs_decision. Denied then stop. | ok |
| daemon-up-end | daemon left up | True | status ok=true after suite | ok |

## Notes

- Start without `--permission-mode` → `permission_mode: auto` (cli.ts + daemon.ts). Do not revert.
- Auto does not park ask Write (file appeared with no host approve). `--permission-mode default` still parks Write for approve/deny.
- Hold + send returns `{error:held}` (ok). Hold + in-flight Read now parks reason=held via PreToolUse ask + canUseTool (62fe1bdd).
- Policy deny is enforced in PreToolUse (auto may skip canUseTool). Live sudo true was host-denied; no PostToolUse (12d5783c).
- AskUserQuestion: auto emitted needs_info+needs_decision then auto-passed; default parked pending reason=ask.

