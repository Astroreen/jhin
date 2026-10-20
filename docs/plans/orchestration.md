# Orchestration plan

Status: **in progress**. This file records how a node's agents start and
follow other agents' work: delegated tasks, launched threads and workflows
(W10 of `t3-roadmap.md`, D360–D379), and recurring work in the node's
scheduler (W11, D380–D389). Both workstreams share it; each keeps its own
section.

## Goal

An agent inside a Jhin thread drives Jhin the way an agent inside T3 Code
drives T3 through its orchestration tools: it hands a task to another agent
of any runtime and model and follows it by id, starts top-level threads in
the workspace it chooses, lists what can run, and runs a script of several
agents. Everything is a command, so the same operations are RPC methods, CLI
subcommands and MCP tools.

## W10. Delegated tasks and workflows

Status: **implemented** (`plugins/orchestration`); the UI is deferred.

### Decisions

#### Reference and shape

- **D360. T3 Code nightly `eb7b35ac` (D53) is the reference** for tasks and
  launches: `apps/server/src/mcp/OrchestratorMcpService.ts`,
  `apps/server/src/mcp/toolkits/orchestrator/tools.ts`, the launch tool in
  `apps/server/src/mcp/toolkits/project`, the contracts in
  `packages/contracts/src/orchestratorMcp.ts` and the child-thread rules of
  `packages/provider-core/src/server/subagentProjection.ts`. Workflows follow
  the script contract of the Workflow tool T3's Claude sessions run (T3 only
  shows and stops those; Claude Code runs them itself), so a script written
  for it runs on Jhin unchanged as long as it uses what D373 lists. Field
  names, enum values, defaults and messages are T3's; T3's Effect runtime,
  receipts and model-option descriptors are not ported.
- **D361. One plugin, `jhin.orchestration`** (`plugins/orchestration`,
  server side). It requires `agent.registry@^1` (provided by the threads
  plugin, so its commands exist), `storage.kv@^1` and `storage.eventlog@^1`,
  and does everything through public commands (`threads.*`, `agents.list`)
  and the `threads` index stream. Its commands, with their MCP tool names
  (`.` → `_`) and T3's tool they mirror:

  | Command                      | MCP tool                     | T3 tool                     |
  | ---------------------------- | ---------------------------- | --------------------------- |
  | `orchestration.capabilities` | `orchestration_capabilities` | `orchestrator_capabilities` |
  | `tasks.delegate`             | `tasks_delegate`             | `delegate_task`             |
  | `tasks.status`               | `tasks_status`               | `task_status`               |
  | `tasks.cancel`               | `tasks_cancel`               | `task_cancel`               |
  | `tasks.list`                 | `tasks_list`                 | (none)                      |
  | `orchestration.launch`       | `orchestration_launch`       | `t3_thread_launch`          |
  | `workflows.run`              | `workflows_run`              | Workflow                    |
  | `workflows.status`           | `workflows_status`           | (`/workflows` view)         |
  | `workflows.stop`             | `workflows_stop`             | `t3_workflow_stop`          |
  | `workflows.list`             | `workflows_list`             | (none)                      |

  Errors carry T3's failure codes in Jhin's spelling (`thread_not_found` →
  `THREAD_NOT_FOUND`) with T3's messages, tool names replaced by Jhin's.

- **D362. The calling thread.** Commands that act as a thread take it from
  the invocation: `Invocation.threadId` (in `@jhin/sdk`, added with W9's
  D341) is the thread whose agent makes the call. For a thread's Claude Code
  it comes from its per-thread MCP credential; a request with the node's own
  token names it in the `x-jhin-thread` header. A caller outside a thread (CLI, RPC, an
  external MCP client) names it instead: `parentThreadId` on
  `tasks.delegate`/`workflows.run`, `threadId` on
  `orchestration.capabilities`, `callerThreadId` on `orchestration.launch`.
  When both are given they must agree. A caller with no thread at all is
  the owner (node token, `*`): it reads, cancels and stops any task or
  workflow of the node, and the `*.list` commands list them all. Unlike T3, a delegation does not need
  a turn of the parent to be running (`parent_not_active`): the CLI delegates
  from an idle thread.

#### Delegated tasks

- **D363. A task is a child thread and its first turn.** `tasks.delegate`
  creates a thread in the parent's project with `parentThreadId` and
  `relationshipToParent: "subagent"` (two new optional fields of the thread
  record and of `threads.create`), then sends it the task prompt only,
  without the parent's history. A `role` other than `general` puts T3's
  `Act as the ${role} sub-agent for this task.` in front of the prompt. The
  title is `title`, else the prompt, trimmed and cut at 72 characters
  (69 + `...`), else `<parent title> subagent <n>`. The task id is its own
  UUID; `childThreadId` is backing storage, not a target for the next round
  (a new round is a new `tasks.delegate`, as T3's description says). The
  task prompt is at most 120 000 characters, the title 512.
- **D364. What a child runs with.** Agent, model and modes come from the
  parent thread unless `target` (`{ agentId?, model? }`; T3's
  `providerInstanceId` is Jhin's `agentId`) or `runtimeMode` /
  `interactionMode` (`"inherit"` or a mode) override them. A model is the
  parent's only when the agent is the parent's, else the agent's default.
  The agent must be available (`AGENT_UNAVAILABLE`: "Agent X cannot run a
  child task: …") and a named model one it lists (`MODEL_UNAVAILABLE`), when
  it lists any. Modes rank as in T3 (`approval-required` <
  `auto-accept-edits` < `full-access`; `plan` < `default`): a requested mode
  broader than the parent's is refused ("Child runtime mode X is broader than
  parent mode Y."), a requested mode the agent does not offer is refused, and
  an inherited one steps down to the broadest mode the agent offers that is
  not broader. Per-turn model options (T3's `options`) wait for W6.
- **D365. Status follows the child, by events.** A task's record
  (`storage.kv`, namespace `jhin.orchestration`, `task/<id>`) mirrors the
  child turn's status from the `threads` index: `running`, `waiting` (the
  turn asks for something), `completed`, `failed`, `interrupted`, or
  `cancelled` (by `tasks.cancel`). `workState` is T3's: `working`,
  `waiting_for_children` (a task the child delegated still runs) or
  `result_available`. `summary` is T3's result: on failure the turn's error,
  otherwise the last non-empty message of the turn, else "Child task
  completed without an assistant result." or "Child task ended with status
  X."; it is never cut and stays as published. `hasPendingQuestion` is a
  waiting turn that asks the user for input; `hasPendingChildRuns` a later
  turn of the child thread still running. Every change of a record is also
  an `orchestration.task.updated` event of the `orchestration` stream, so a
  client follows tasks without polling. On activation the plugin reconciles
  the records of unfinished tasks with their threads (a node that restarted
  closed their turns) from the child's own stream, by the task's turn id, so a
  child that took later turns meanwhile still resolves it; a task recorded
  without its turn (the node stopped mid-delegation) takes the child's first
  turn, or fails with "The node stopped before the child task started." if
  there is none, and cancels the agents of a workflow that ended with
  the node or a reload.
- **D366. `mode: "async"` (default) or `"wait"`.** `wait` returns once the
  task is terminal, asks a question, or `timeoutMs` (default 10 minutes, at
  most 60, at least 1 ms) passes; then `waitTimedOut` is true and the child
  goes on; a waited task whose node stopped mid-wait wakes the parent like
  an async one. `clientRequestId` (at most 256 characters) makes a delegation
  idempotent per parent: a retry with the same id returns the same task
  instead of starting another. A task whose turn could not start fails with the
  error the caller got, wakes nobody, and is no answer to a retry.
- **D367. `tasks.status` and `tasks.cancel`.** A thread reads and cancels
  only its own tasks (`TASK_NOT_FOUND`: "Delegated task X does not belong to
  thread Y."). Reading a terminal task acknowledges its delivery (D368).
  `tasks.cancel` stops the child like a user's Stop (`threads.interrupt`)
  and cancels the tasks and workflows the child started, recursively; as
  in T3 the child stops even when the task is already terminal (a later turn
  of it included). Deleting a parent thread cancels its running tasks and
  stops its workflows; it
  answers `cancel_requested`, or the status of a task already terminal (its
  result stays). Unlike T3 there is no `task_not_cancellable`: a task whose
  turn already stopped is recorded cancelled. `tasks.list` lists a thread's
  tasks, newest first.
- **D368. A finished task wakes its parent.** When an async task (or a
  waited one whose wait timed out) ends, the parent thread gets T3's message
  "Delegated task X reached a terminal state. Use tasks_status with taskId X
  to read the result." (several tasks ending together share one message).
  It is sent with `threads.send` once the parent runs no turn, so it never
  interrupts the parent's turn; while a turn runs it waits for the turn's end
  in the `threads` index, as T3's `queue_after_active` does. Steering it into
  the running turn waits for W1. Delivery is `pending`, `delivered`,
  `acknowledged` (read first) or `disposed` (cancelled, or the parent was
  archived or deleted), recorded on the task, so it survives a restart.

#### Capabilities and launches

- **D369. `orchestration.capabilities`** lists `agents.list` as T3 lists
  providers: per agent `agentId`, `name`, `models`, `defaultModel`,
  `runtimeModes`, `interactionModes`, `canRunChildTask` (and
  `canRunCrossProviderChildTask`, the same), `constraints` (why it cannot:
  the runtime's own message, else "Agent is unavailable."); the calling
  thread's id, agent, model and modes; and `features`: `appOwnedSubagents`,
  `asyncPolling`, `cancellation`, `workflows`, `threadManagement` are true;
  `scheduledTasks` is true once a command `schedules.create` (W11) exists;
  `workspaceStrategies` lists what `orchestration.launch` accepts here.
- **D370. `orchestration.launch`** is T3's `t3_thread_launch`: a top-level
  thread with `title`, in `projectId` (the caller's project when omitted; a
  caller outside a thread must pass it) or `scratch: true` (the scratch
  project; not with `projectId` or `workspaceStrategy`), with `agentId`,
  `model` and modes (the caller's when omitted), then `message` as its first
  turn (omitted: an idle thread). It has no retry key, like T3's. The result
  is `{ threadId, projectId, agentId, model, turnId, status }`. A launched
  thread may not run with broader modes than the calling thread (D364's
  ranks); a caller outside a thread has no ceiling until scoped tokens (W13)
  give it one.
- **D371. Workspaces belong to W3.** `workspaceStrategy` is T3's union:
  `{type:"root", branch?}`, `{type:"worktree", baseRef, branch?,
  startFromOrigin?}`, `{type:"existing_worktree", worktreePath, branch?}`;
  omitted means `root`, not the caller's worktree. This plugin does not make
  worktrees: it passes the strategy to `threads.create` as `workspace`, the
  field W3 adds there. Until `threads.create`'s input lists `workspace`, only
  a plain `root` is accepted and the others answer `WORKSPACE_UNSUPPORTED`;
  the check reads the command's schema at call time, so W3's change turns
  them on with no change here. `tasks.delegate`'s `isolation: "worktree"`
  is `{type:"worktree", baseRef:"HEAD", startFromOrigin:false}` of the
  parent's checkout the same way.

#### Workflows

- **D372. A workflow is a script of agents.** `workflows.run { script, args?,
  parentThreadId? }` takes the Workflow tool's script: it begins with
  `export const meta = { name, description, whenToUse?, phases? }`, a pure
  literal (evaluated in an empty context, so a variable or call in it
  fails), and its body is plain JavaScript run as an async function. It
  returns `{ workflowId, name, status }` at once; the run goes on in the
  node.
- **D373. The script's hooks** are the Workflow tool's: `agent(prompt,
  {label?, phase?, schema?, model?, agentId?, isolation?, effort?})`,
  `parallel(thunks)` (a barrier; a thunk that throws gives `null`),
  `pipeline(items, ...stages)` (no barrier; a stage gets `(previous, item,
  index)`; a throw drops the item to `null`), `phase(title)`, `log(message)`
  and `args`. Each `agent()` is a delegated task of the workflow's parent
  thread (D363, labelled by `label`), run to its end (nobody answers inside
  a workflow, so an agent that asks the user or waits for an approval is
  cancelled, and the run's log says so); it returns the task's
  summary, or `null` when the task did not complete. With `schema` (a JSON
  Schema with `type: "object"` and `properties` at its root, `required` ⊆
  `properties`) the prompt asks for one JSON object matching it, and the
  answer is parsed and validated (Zod's `fromJSONSchema`); a mismatch is
  sent back to the same child twice at most before `null`. `agentId` is
  Jhin's addition (any runtime); `effort` waits for per-turn options (W6) and
  is ignored; `agentType`, `budget` and `workflow()` are not available and
  throw. `Date.now()`, argless `new Date()` and `Math.random()` throw, as in
  the Workflow tool.
- **D374. Limits.** At most `jhin.orchestration.maxConcurrentAgents` agents
  of one workflow run at once (default `min(16, CPUs − 2)`, at least 1), 1000
  over a run, 4096 items per `parallel()`/`pipeline()` call. The body may run
  1 s before its first `await` (`vm`'s timeout); a loop after an `await` is
  not bounded and still blocks the node (Deferred). An agent the script left
  running when it ends (it threw, or returned without waiting) is cancelled.
- **D375. A script runs with the node's rights.** Node's `vm` is no security
  boundary and the hooks are the node's own functions (a script reaches
  `process` through them): whoever runs a script runs arbitrary code on the
  node, and can stall it after the script's first `await`, where
  `workflows.stop` no longer helps (D374). So `workflows.run` needs its own
  permission, `workflows.run`, besides `threads.write`, and a calling thread
  in `full-access` mode (`RUNTIME_MODE_ESCALATION_DENIED` otherwise). The
  owner's token holds it; a thread's agent does not (W9's
  `AGENT_PERMISSIONS`), so an agent acting on injected content cannot run
  one. A scoped device token (W13, `auth.tokens.issue`) may be granted it;
  a thread's agent gets it once `AGENT_PERMISSIONS` lists it. A mesh
  member (`node:<id>` caller, which holds every permission today) cannot
  start one either.
- **D376. Following and stopping a workflow.** A run's record
  (`workflow/<id>`, mirrored as `orchestration.workflow.updated`) holds its
  meta, `status` (`running`, `completed`, `failed`, `stopped`), the phases
  with their agents (task id, label, status), the last 200 log lines, the
  script's return value (`result`, JSON) or `error`. `workflows.stop` stops
  the whole run: its running tasks are cancelled and every hook throws from
  then on. A run's end wakes its parent like a task (D368): "Workflow X
  reached a terminal state. Use workflows_status with workflowId X to read
  the result." Its own agents never wake the parent. A run still going when
  the node stops is recorded `failed` on the next start ("The node stopped
  while the workflow ran.").

### Deferred

- The thread UI of delegated work: T3's subagent rows in the parent's chat,
  hiding child threads (`relationshipToParent: "subagent"`) from the
  sidebar's list, the workflow progress tree and its Stop button. The
  records and the `orchestration` stream carry what they need.
- Steering a task's completion into the parent's running turn (W1); today
  it waits for the turn's end.
- Per-turn model options for a child (T3's `target.options`, a workflow
  agent's `effort`) — W6.
- Worktree strategies for `orchestration.launch` and `isolation:
  "worktree"` — enabled by W3's `workspace` field (D371); a scratch launch
  in a fresh folder of its own (T3's) also waits for per-thread working
  directories.
- Resuming a workflow (`resumeFromRunId`), `budget`, nested `workflow()`,
  saved workflows by name and `scriptPath`, custom `agentType`s.
- Delegating to an agent on another mesh node (`target.node`): today a task
  runs on the parent's node.
- Pruning old task and workflow records: they stay in `storage.kv` (and in
  memory) for good; `tasks.list` and `workflows.list` without a thread list
  them all.
- Smaller workflow events: every change appends the whole record (agents,
  logs, result) to the `orchestration` stream; deltas would keep it small.
- Ending a `mode: "wait"` delegation when its caller goes away: commands
  get no cancellation signal today, so the wait runs to its timeout (at most
  60 minutes) and the task goes on either way.
- Running workflow scripts out of process (a worker or a child process),
  which would bound their asynchronous part too and give them no node
  rights.
- `x-jhin-thread` from a caller with the node's own token is trusted as
  given: such a caller can act as any thread, with that thread's modes, so
  the ceiling of D364 binds agents only (W9's per-thread MCP credential
  fixes the thread for them). Scoped tokens are W13.
- A ceiling on modes for callers outside a thread (T3's approved permission
  mode of an MCP client) — W13's scoped tokens.
- The calling thread over `jhin mcp` (stdio): only the HTTP endpoint reads
  `x-jhin-thread`; a stdio client names the thread in the input.
- T3's batch `create_threads`, `t3_thread_wait` and `t3_thread_read`
  views: `threads.create`, `threads.get` and `threads.events` cover them.

### Landing

One PR. Public API it adds: the plugin `jhin.orchestration` with its
commands (D361), its config section, the storage namespace and stream
`orchestration`, the events `orchestration.task.updated` and
`orchestration.workflow.updated`, and the thread fields
`parentThreadId` and `relationshipToParent`.

**Done when:** with the fake agent, through RPC and MCP: a delegated task
completes and its summary is read; `wait` returns the result, and times out
on a held task without cancelling it; inheritance and mode escalation; an
idempotent retry; cancel of a running task and of a terminal one, with the
cascade to a nested task; the parent woken once its turn ended, and not
when the result was read first; a restart that reconciles a task; a launch
with and without a message, the scratch and workspace errors; capabilities;
a workflow with `parallel`, `pipeline`, `schema` and a stopped run; the
whole set reachable as MCP tools.

## W11. Scheduled tasks and webhooks

Status: **implemented** (`plugins/scheduler`, `packages/scheduler-api`); the settings page is D389.

### Decisions

The reference is T3 Code's scheduler (`apps/server/src/scheduledTasks`,
`packages/contracts/src/scheduledTask.ts`) at the nightly tag
`v0.1.1-nightly.20261020.3411`, the first to have `run_scheduled_task_now`;
the rest of it is unchanged since D53's tag.

- **D380. A plugin of its own:** `jhin.scheduler` provides
  `scheduler.tasks@1` and requires `agent.registry@1` (the threads plugin,
  whose commands its runs use); its contract (schemas, command names, event types and
  the schedule arithmetic) is the package `@jhin/scheduler-api`. A task is
  T3's: a title, a prompt, enabled or paused, a schedule, a project, the
  thread it runs in (or none: a new thread per run), the agent, model and
  modes of a new thread, and its run state (`nextRunAt`, `lastRunAt`,
  `lastRunStatus` `never | running | succeeded | failed`, `lastRunError`,
  `runCount`). Tasks are kept in `storage.kv`; every change appends
  `scheduler.task.updated` (the task) or `scheduler.task.deleted` (`{ id }`)
  to the `scheduler` stream, so a client follows the list from
  `scheduler.tasks.list`'s `head` like the threads index. The stream is
  guarded with `scheduler.read` (security.md D415).
- **D381. Three triggers, T3's schema:** `{ type: "interval", everyMs }`
  (at least 60 000), `{ type: "fixed_time", timeOfDay: "HH:MM", weekdays? }`
  (0 is Sunday; none means every day) in the node's local time zone, and
  `{ type: "webhook", signature? }`. An interval counts from the end of the
  previous run (elapsed time, across daylight saving changes); a fixed time is
  the next matching minute after now. A fixed-time run missed by more than ten
  minutes (the node was down or asleep) is skipped and rescheduled, as in T3;
  a missed interval runs once. Editing a title, prompt or binding keeps the
  pending run; changing the schedule or enabling the task restarts its clock.
- **D382. The node's scheduler is one timer:** set for the earliest due run
  and never more than a minute away, so a clock that jumped or a machine that
  slept is caught up within a minute (T3 polls every five seconds). Every
  change re-arms it. A task runs once at a time: no run starts while the
  previous one still runs, and the next one counts from its end. Runs still marked running when the node starts are recorded as
  failed ("Run was interrupted by a node restart.") and rescheduled, and
  webhook deliveries answered 202 whose run never started are marked
  `dispatch_failed`. Tests
  move Vitest's fake clock; nothing waits on real time.
- **D383. Where a run goes:** a task bound to a thread sends its prompt to
  that thread with the thread's own agent and settings (T3 #18467); an
  unbound task creates a thread in its project, titled after the task, with
  the task's agent, model and modes, and sends the prompt there. A bound run
  goes into the thread's queue (`threads.queue.add`, W1's D201, with the
  run's own message id), as T3 sends in `queue` mode: it starts at once on a
  free thread, else after the turns queued before it. A run counts as succeeded
  once the thread accepted the message, not when the turn ends (as in T3),
  and reports the thread it went to. Deleting a thread deletes the tasks
  bound to it (T3 #22070).
- **D384. Commands mirror T3's tools:** `scheduler.tasks.create`
  (`schedule_task`), `scheduler.tasks.update` (`update_scheduled_task`: only
  the fields given change), `scheduler.tasks.delete`,
  `scheduler.tasks.list` (`list_scheduled_tasks`, optionally one project's)
  and `scheduler.tasks.run` (`run_scheduled_task_now`: a manual run, refused
  for webhook tasks and while the task runs), plus
  `scheduler.webhooks.rotate` (a new URL token) and
  `scheduler.deliveries.list` / `scheduler.deliveries.get` (the delivery
  log; one delivery in full, with its body and prompt, takes the same rights
  as its URL). Reading takes `scheduler.read`; creating, changing, running a
  task and rotating its URL take `scheduler.write` and `threads.write`, since a
  task sends messages to threads (deleting takes `scheduler.write`), and only
  a caller holding both sees a webhook's URL token. A create with a `clientRequestId` is idempotent: the
  same id returns the task it created.
- **D385. Webhooks are routes of `http.server@1`:**
  `GET|POST|PUT|PATCH /api/hooks/<taskId>/<token>`, the token 32 random
  bytes in hex, compared in constant time before the body is read; a wrong
  token answers like an unknown task (404). The token is a right to run the
  task, so `webhook.path` and `url` go only to callers holding
  `scheduler.write` (null for readers and on the `scheduler` stream). Answers as T3's: 202 with the delivery id, 401 for a bad
  signature, 409 for a paused task, 413 past 1 MiB, 429 when rate limited. A
  task's `webhook.url` is the node's own URL plus the path; making it
  reachable from outside is remote access (W13), not T3 Connect. Without
  `http.server` webhook tasks can be kept but not called.
- **D386. Signatures, GitHub-style:** an optional HMAC-SHA256 over the raw
  body, with the header, `hex` or `base64` encoding and a prefix
  (`x-hub-signature-256`, `hex`, `sha256=` for GitHub). The secret is
  write-only: given on create or update, kept in `storage.kv`, never returned
  (`webhook.hasSecret`), and kept when an update omits it. T3's `secretRef`
  from `request_secret` waits for W13's secrets.
- **D387. Request data reaches the prompt only through placeholders**
  (`{{body.path}}`, `{{headers.name}}`, `{{query.name}}`, `{{body}}`,
  `{{request}}`), each value framed in `<webhook-data-ID>` tags with a fresh
  id and a closing note that it is untrusted, with `$`, `@` and `/command`
  mentions broken and credential-looking headers redacted where the whole set
  renders: T3's `webhookTemplate.ts`, ported.
- **D388. Limits and the delivery log, T3's numbers:** a signature is checked
  before anything else counts the request, so forged requests take no slot
  (the first of a minute is logged); then 60 accepted requests a
  minute per task (only the first rejected one of a window is logged), at most
  20 waiting to run per task (the first refusal while full is logged, as
  `rate_limited`), and the last 50 deliveries per task kept with
  their outcome (`accepted`, `dispatch_failed`, `rejected_signature`,
  `disabled`, `rate_limited`), body (up to 64 KiB), headers, missing
  placeholders and the rendered prompt.
- **D389. UI:** T3's Settings → Scheduled tasks page and the thread's
  automations panel, on these commands and the `scheduler` stream
  (follow-up PR).

### Deferred

- The settings page and the thread's automations panel (D389).
- `secretRef` for webhook signing secrets, entered through
  `request_secret` (W13's secrets).
- A public webhook URL through a relay, held deliveries while the node is
  offline and their maximum age (`maxDeliveryAgeMinutes`): T3 does this with
  T3 Connect; Jhin's remote access is W13.
- Inheriting the calling thread's project and binding a task to it by
  default (`bindToCurrentThread`): an MCP call does not say which thread it
  comes from until the node's MCP server is attached to Claude Code (W9).
- Metrics of deliveries (T3 counts them per outcome).
