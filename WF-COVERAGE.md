# Claude Agent SDK dynamic-workflow coverage (live ccop)

Inventory is only what `sdk.d.ts` documents for workflows plus host RPCs already in ccop.
100% = every inventory row has a result, not that every row is ok.

- Sessions: `cee5cd27-209d-496e-9835-075e8d317b5f` (ultracode + small review; bg/pause/stop/continue/slash), `6da9c30c-a520-4d0e-ada7-75cb34e38cfc` (control, no ultracode keyword)
- Project cwd: `/workspace/next-login`
- Host start (hardcoded): `enableWorkflows: true`, `effort: "max"`, `ultracode: false`; `disableWorkflows` never set
- Settings during test: `workflowSizeGuideline=small`, `workflowKeywordTriggerEnabled=true`; restored after
- Results: {'ok': 25, 'policy-skip': 1, 'fail': 2, 'unsupported': 1}

| id | feature | attempted | evidence | result |
| --- | --- | --- | --- | --- |
| 1 | enableWorkflows=true (hardcoded) | true | cee5cd27-209d-496e-9835-075e8d317b5f info.enable_workflows=true; Workflow tool fired tool_use_id=call-7355f38b-a24e-4c11-81e3-fb50b8248049-0. Host start options always set enableWorkflows:true (daemon.ts). | ok |
| 2 | disableWorkflows | false | Policy-skip: host hardcoded always-on. daemon.ts cmdStart common={ultracode:false, enableWorkflows:true, effort:'max'}; disableWorkflows is never set. settings.json has enableWorkflows true and no disableWorkflows key. | policy-skip |
| 3 | workflowSizeGuideline small | true | Set ~/.claude/settings.json workflowSizeGuideline=small then started cee5cd27-209d-496e-9835-075e8d317b5f. First script meta name=auth-session-dashboard-review used 2 parallel agents + 1 synthesizer (3 agent() calls, <5). Live SubagentStart workflow-subagent count before stop=2 (a4b038649de76b741, ad7590958a54e1418). Restored settings after. | ok |
| 4 | workflowKeywordTriggerEnabled + keyword ultracode | true | cee5cd27-209d-496e-9835-075e8d317b5f prompt began with 'ultracode:'. settings workflowKeywordTriggerEnabled=true. Event kind=working summary='tool Workflow' tool_use_id=call-7355f38b-a24e-4c11-81e3-fb50b8248049-0. | ok |
| 5 | ultracode boolean session flag | true | Opted-out per user. Host start options pass ultracode:false (daemon.ts). settings.json ultracode=false. Start payload never includes ultracode:true. | ok |
| 6 | workflowKeywordTrigger without keyword (control) | true | 6da9c30c-a520-4d0e-ada7-75cb34e38cfc prompt had no word ultracode; asked to call Workflow anyway. Workflow still fired tool_use_id=call-81c1deae-08a8-4ffa-85dc-191ac309b496-0 task_id=wd3eoqk8l. Keyword trigger is sufficient but not required when the model is told to use the tool. | ok |
| 7 | Workflow tool call (name Workflow) + tool_use_id | true | cee5cd27-209d-496e-9835-075e8d317b5f {"kind":"working","summary":"tool Workflow","extra":{"tool":"Workflow","tool_use_id":"call-7355f38b-a24e-4c11-81e3-fb50b8248049-0"}} | ok |
| 8 | task_started with task_id | true | cee5cd27-209d-496e-9835-075e8d317b5f {"summary":"task_started","extra":{"task_id":"wq80ltdqd","tool_use_id":"call-7355f38b-a24e-4c11-81e3-fb50b8248049-0","task_type":"local_workflow"}} | ok |
| 9 | workflow_name / local_workflow / task_type | true | cee5cd27-209d-496e-9835-075e8d317b5f task_started extra: task_type=local_workflow workflow_name=auth-session-dashboard-review. Second task: task_id=whsrtu0a3 workflow_name=dashboard-only-review. 6da9c30c-a520-4d0e-ada7-75cb34e38cfc workflow_name=login-page-review. | ok |
| 10 | workflow-subagent SubagentStart (count) | true | cee5cd27-209d-496e-9835-075e8d317b5f 3 SubagentStart agent_type=workflow-subagent (a4b038649de76b741, ad7590958a54e1418, ab5ca444586b035f7). 6da9c30c-a520-4d0e-ada7-75cb34e38cfc 1 (a6377826949f1d6b2). subagents RPC 6da9c30c-a520-4d0e-ada7-75cb34e38cfc source=sdk ids=['a6377826949f1d6b2']. | ok |
| 11 | task_progress | true | cee5cd27-209d-496e-9835-075e8d317b5f task_progress task_id=wq80ltdqd description='Review: review-auth-session' last_tool_name=review-auth-session. Many later frames on whsrtu0a3 with usage.tool_uses incrementing. | ok |
| 12 | task_updated | true | cee5cd27-209d-496e-9835-075e8d317b5f task_updated extra={task_id:wq80ltdqd, patch:{status:'killed', end_time:1787403750285}} after live task-stop. 6da9c30c-a520-4d0e-ada7-75cb34e38cfc patch={status:'completed', end_time:1787403870719}. | ok |
| 13 | task_notification completed|failed|stopped | true | cee5cd27-209d-496e-9835-075e8d317b5f kind=interrupted status=stopped task_id=wq80ltdqd tool_use_id=call-7355f38b-…. 6da9c30c-a520-4d0e-ada7-75cb34e38cfc kind=task_done status=completed task_id=wd3eoqk8l usage={total_tokens:13828, tool_uses:3, duration_ms:15029}. No failed notification this run. | ok |
| 14 | background_tasks_changed | true | cee5cd27-209d-496e-9835-075e8d317b5f extra={n:1, tasks:[{task_id:'wq80ltdqd', description:'Code-review Next.js auth, session, and dashboard paths'}]} then n:0. Repeated for second task whsrtu0a3. | ok |
| 15 | Background task type/name if tasks RPC exposes them | true | tasks RPC rows are {task_id,status,summary,tool_use_id,usage} only — no type/name. background_tasks_changed live items also lacked type/name (SDK BackgroundTaskSummary fields). Observed keys: task_id, description. | fail |
| 16 | spawn_depth if present | true | cee5cd27-209d-496e-9835-075e8d317b5f/6da9c30c-a520-4d0e-ada7-75cb34e38cfc task_started extras never included spawn_depth. Matches sdk.d.ts: spawn_depth is for local_agent, not set on other tasks (these were task_type=local_workflow). | ok |
| 17 | is_backgrounded field | true | Never present on task_started/task_updated for local_workflow (sdk.d.ts: set for local_agent and local_bash). task-bg RPC returned backgrounded=false (see row 21). | ok |
| 18 | skip_transcript if present | true | cee5cd27-209d-496e-9835-075e8d317b5f/6da9c30c-a520-4d0e-ada7-75cb34e38cfc skip_transcript absent on task_started and task_notification extras (including completed wd3eoqk8l). | ok |
| 19 | monitor: tasks, subagents, events --tail, info, workflows, status | true | cee5cd27-209d-496e-9835-075e8d317b5f all six RPCs returned ok during run. info.enable_workflows=true effort=max. events --tail used throughout driver. status listed live session + pending Workflow. | ok |
| 20 | workflows RPC lists advertised skills/slash | true | cee5cd27-209d-496e-9835-075e8d317b5f workflows.slash_commands includes __remote-workflow, workflow-launch-exec. skills include deep-research, code-review, run, … (no workflow-named skill). | ok |
| 21 | task-bg while running | true | cee5cd27-209d-496e-9835-075e8d317b5f while wq80ltdqd status=running: task-bg -> {ok:true, backgrounded:false, tool_use_id:'call-7355f38b-a24e-4c11-81e3-fb50b8248049-0'}. No subsequent is_backgrounded patch. | ok |
| 22 | task-stop on a LIVE running workflow task | true | cee5cd27-209d-496e-9835-075e8d317b5f task-stop wq80ltdqd while running -> {ok:true, task_id:'wq80ltdqd'}; tasks RPC status=stopped; task_updated patch.status=killed; task_notification status=stopped. | ok |
| 23 | pause — no pauseTask in SDK | true | cee5cd27-209d-496e-9835-075e8d317b5f sent text 'pause' while task running. No paused status on session or tasks (paused=false, sess_state=working, task still running). No pauseTask on Query/client. | unsupported |
| 24 | continue/resume after stop or interrupt | true | cee5cd27-209d-496e-9835-075e8d317b5f after stop, sent continue prompt to read prior journal and resume. Model started second Workflow dashboard-only-review (whsrtu0a3). Journals exist under …/cee5cd27-209d-496e-9835-075e8d317b5f/workflows and …/subagents/workflows/wf_255b0b71-05e. | ok |
| 25 | start a second workflow in same or new session | true | Same session cee5cd27-209d-496e-9835-075e8d317b5f: second tool Workflow call-7c901579-b19c-4d30-9f76-b6caf54675f7-3 task_id=whsrtu0a3 workflow_name=dashboard-only-review. Also new session 6da9c30c-a520-4d0e-ada7-75cb34e38cfc started another workflow. | ok |
| 26 | usage/cost_usd/model_usage after workflow | true | cee5cd27-209d-496e-9835-075e8d317b5f info.cost_usd=0.270088 model_usage.grok-4.6={inputTokens:46542,outputTokens:1490,cacheReadInputTokens:256,costUSD:0.270088}. 6da9c30c-a520-4d0e-ada7-75cb34e38cfc cost_usd=0.334524 after completed workflow (task usage total_tokens=13828 included in pipeline). | ok |
| 27 | stop session | true | stop cee5cd27-209d-496e-9835-075e8d317b5f -> {ok:true,id:cee5cd27-209d-496e-9835-075e8d317b5f}; stop 6da9c30c-a520-4d0e-ada7-75cb34e38cfc -> {ok:true,id:6da9c30c-a520-4d0e-ada7-75cb34e38cfc}. status afterward: no live sessions. Daemon left up. | ok |
| 28 | slash that looks like workflow-launch | true | cee5cd27-209d-496e-9835-075e8d317b5f workflows listed workflow-launch-exec; sent '/workflow-launch-exec'. turn_done result was prose about the already-running review ('Workflow is running: 2 review agents…'), not a new launcher invocation. No extra Workflow tool_use from the slash itself. | fail |
| 29 | Journal files under ~/.claude/projects/*next-login*/**/workflows/ | true | Created: …/cee5cd27-209d-496e-9835-075e8d317b5f/workflows/wf_255b0b71-05e.json, scripts/auth-session-dashboard-review-*.js, scripts/dashboard-only-review-*.js, subagents/workflows/wf_255b0b71-05e/journal.jsonl; …/6da9c30c-a520-4d0e-ada7-75cb34e38cfc/workflows/wf_2fe81b4a-b94.json + scripts/login-page-review-*.js + journal.jsonl. | ok |

## Notes

- `task_type` observed: `local_workflow` (not a separate `workflow` string).
- `spawn_depth` / `is_backgrounded` / `skip_transcript` were absent on these local_workflow tasks; SDK says spawn_depth and is_backgrounded apply to local_agent (and bash for background).
- `task-bg` returned `backgrounded: false` (workflow already not a blocking foreground bash/subagent in the SDK sense).
- `task-stop` maps to `task_updated.patch.status=killed` and `task_notification.status=stopped`.
- Control session B shows Workflow tool still fires without the ultracode keyword when the prompt asks for it.
- `/workflow-launch-exec` is advertised but sending the slash did not launch a distinct workflow.
- Daemon left up. No git commit/push.

