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
  not broader. Model options (T3's `target.options`) are W20's D870.
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
  `scheduledTasks` is true once a command `scheduler.tasks.create` (W11) exists;
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
  them on with no change here; `worktree` is listed (`orchestrator.capabilities`)
  only where the node's source control makes worktrees (`git.worktree.create`). `tasks.delegate`'s `isolation: "worktree"`
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
  Jhin's addition (any runtime); `effort` is the model's `effort` option
  (D870); `budget` and `workflow()` are W20's D873, D874; `agentType` is
  not available and throws. `Date.now()`, argless `new Date()` and `Math.random()` throw, as in
  the Workflow tool. `command(name, input)` is A6's addition (agents.md
  D705).
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

- A scratch launch in a fresh folder of its own (T3's) waits for per-thread
  working directories.
- Custom `agentType`s of a workflow agent.
- The model label of a provider subagent from its alias (`sonnet`) rather
  than the alias itself.
- A background subagent's work that Claude Code sends while the node
  restarts is lost, and its thread ends `interrupted` (D1164); T3's
  continuation turns, which read a result into an idle parent, stay out
  (`t3-parity.md` D805).
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

## W20. Delegated work in the UI

Round 2 of `t3-roadmap.md` (D861–D880): the parts of W10 and W11 a T3 Code
user sees, which their Deferred lists left out.

### Decisions

- **D861. T3 Code nightly `eb7b35ac` (D53) is the reference** for the UI of
  delegated work: `apps/web/src/components/chat/V2LifecycleRow.tsx` (the
  subagent row and the created-thread row), `WorkflowOpeningBlock.tsx`,
  `AgentElapsed.tsx` and `filterSidebarV2VisibleThreads` of
  `components/Sidebar.logic.ts`. Wording, status labels and the elapsed
  format are T3's.
- **D862. Delegated work leaves a mark in the calling thread.** Like a
  rendered page (D407), the mark is an event of the calling thread's own
  stream, in the turn it runs (`turnId`; none when no turn runs), so it
  travels with the thread to every client and mesh member:
  `orchestration.task.delegated` `{ taskId, childThreadId, title, agentId,
  model? }` for a task of `tasks.delegate` (a workflow's agents get none),
  `orchestration.workflow.started` `{ workflowId, name, description, phases,
  script }` for `workflows.run`, and `orchestration.thread.launched`
  `{ threadId, title }` for `orchestration.launch` from a thread. The turn is
  read when the mark is written; a mark that cannot be written is logged and
  the work goes on. The event types live in `@jhin/agent-api`, for the
  plugin and its clients alike.
- **D863. `orchestration.thread { threadId? }`** reads a thread's tasks and
  workflows as the records the `orchestration` stream carries, with the
  stream's `head` to follow them from; unlike `tasks.status` and
  `workflows.status` it acknowledges no result, so a client showing them
  takes no wake-up message from the agent. A workflow's agents carry their
  `childThreadId` once their task exists.
- **D864. The chat shows the marks** through `chat.turn.item`
  (`jhin.orchestration-view`, contributions `jhin.orchestration.subagent`,
  `jhin.orchestration.workflow`, `jhin.orchestration.launched`). A task is
  T3's subagent row: a status dot, its title, its result once settled (not
  T3's generic "Child task ended with status …"), the status (`Running`,
  `Waiting`, `Completed`, `Failed`, `Stopped`), the elapsed time, and the
  button "Open <title>" to its thread. A workflow is T3's opening block:
  "Workflow started", its name and description, "N agents · 1 working · 2
  done", each phase with its settled count and member rows (as a task's,
  by label), then the script, folded while long. A launch is "Created thread
  · <title>" with "Open chat". The rows follow the records live:
  `orchestration.thread`, then the `orchestration` stream after its head,
  starting over with backoff when either fails; a thread on a mesh member
  reads them again whenever the member's threads change. A row with no record
  of its task says "Status unavailable" and claims no live state.
- **D865. The sidebar hides subagent threads** (`relationshipToParent:
  "subagent"`), and they raise no notification, as in T3; their parent's
  rows open them.
  `client.threads@1`'s `ThreadRecord` lists `parentThreadId` and
  `relationshipToParent`.

- **D866. Delegated work in the Lineage section.** T3 lists a thread's
  subagents and workflows in the Lineage section of the thread details panel
  (`ThreadRelationshipsControl.tsx`, `ThreadLineageWorkflowRow.tsx`). Jhin's
  Lineage section (`t3-parity.md` D802) gets the slot `chat.thread.lineage`
  (props `ChatThreadDetailsProps`): rows other plugins put into its list
  after the fork rows; the section shows while any row does.
- **D867. The rows of delegated work** (`jhin.orchestration.lineage`): for a
  subagent thread, its parent ("Parent thread", the thread's own status); a
  row per task of the thread outside workflows, newest first, with its status
  (`Running`, `Waiting`, `Done`, `Stopped`, `Failed`), opening the child, and
  T3's "Stop subagent" while it runs (`tasks.cancel`); a row per workflow with
  its name and status, T3's "Stop entire workflow" while it runs
  (`workflows.stop`), and a chevron that unfolds its phases ("<n>/<m>
  agents", open while running; "No agents yet") and their agents, each
  opening its thread.
- **D868. Stopping from the panel** runs the command as the thread's owner
  with `parentThreadId`; a refusal is shown in a toast, and the button
  spins until the command answers.

- **D869. A finished task is queued after the parent's turn, not steered
  into it.** T3 delivers a child's completion with `queue_after_active` and
  keeps `steer` for `t3_thread_send`; D368 already waits for the parent's
  turn to end, so the roadmap's "steered into the parent's turn" needs no
  change. Unlike T3, a result read before that turn ends is not delivered (D368;
  `tasks.test.ts`, "wakes a busy parent only after its turn, and not at all
  once the result was read").
- **D870. Model options of a child.** `tasks.delegate`'s `target.options` is
  T3's: `[{ id, value }]` or `{ id: value }`, passed as the child's
  `modelOptions` (the threads plugin keeps those its model declares, D297),
  at most 20, the last of an id winning. A child running the parent's model
  starts from the parent's options and the chosen ones are laid over them;
  another model starts with its defaults. A workflow agent's `effort` is the
  model's `effort` option. `orchestration.capabilities` lists each model's
  option descriptors, as T3 lists them.
- **D871. Worktree isolation needs nothing more here.** `orchestration.launch`'s
  `workspaceStrategy` and `isolation: "worktree"` reach `threads.create` as
  `workspace` (D371), which W3 implements with source control; without it
  they answer `WORKSPACE_UNSUPPORTED` and capabilities leave `worktree` out.

- **D872. `resumeFromRunId`** (`workflows.run`): a run of the same thread
  that no longer runs (`WORKFLOW_RUNNING` otherwise: stop it first). Each run
  keeps a journal of its completed `agent()` calls (`storage.kv`, one key
  per call, `journal/<id>/<index>`: `[prompt, options]` and result); a call
  that failed or answered `null` is not journaled, so a resume runs it, and
  everything after it, live. On resume each
  call is decided as it gets its index, in call order, so the reused calls
  are a prefix even under `parallel()`: it answers from the journal while it
  matches the journal's call of the same index; the first that differs, and every call after it, runs live,
  as the Workflow tool resumes. A reused call is a `cached` agent of the new
  record, with the original task. The record names `resumedFrom`.
- **D873. `budget`** is the Workflow tool's `{ total, spent(), remaining() }`.
  `workflows.run`'s `budget` (output tokens) sets `total`, else it is `null`
  and `remaining()` is `Infinity`. `spent()` adds up the output tokens of the
  run's agents (the last `agent.usage.updated` of each of their turns),
  counted as each agent ends; the record keeps `budget` and `spent`. It is a
  hard ceiling, as in the Workflow tool: agents already started finish,
  and once spent, `agent()` throws `WORKFLOW_BUDGET` ("The
  workflow's budget of N tokens is spent").
- **D874. `workflow(nameOrRef, args?)`** runs a saved workflow or
  `{ scriptPath }` inline, in a context of its own with `args`, sharing the
  run's agents, concurrency, budget and stop. Its agents go into the phase
  "▸ <name>" unless they name one; `workflow()` inside it throws ("nests one
  level only").
- **D875. Saved workflows** are the files `.jhin/workflows/<name>.js` of the
  thread's working directory (its worktree, else its project's folder);
  `scriptPath` is a file, relative to that directory unless absolute.
  `workflows.run` takes exactly one of `script`, `name` and `scriptPath`
  (`INVALID_REQUEST`); a missing one answers `WORKFLOW_NOT_FOUND`.

- **D876. A runtime's own subagents** (T3's provider-native subagents,
  `subagentProjection.makeSubagentChildThread`) reach the threads plugin as
  three more items of `agent.runtime@1` (1.4; `agent.registry` 1.2):
  `subagent.started { subagentId, title, prompt, model? }`, `subagent.item
  { subagentId, item }` (its messages, reasoning and tool calls only,
  `SubagentWorkItem`) and `subagent.ended { subagentId, status, error? }`.
  A runtime writes no other thread itself.
- **D877. The threads plugin projects them into child threads.** A started
  subagent gets a thread in the parent's project (and worktree) with
  `parentThreadId`, `relationshipToParent: "subagent"` and `subagentOrigin:
  "provider"`, titled after it ("Subagent" when it has no title), and one
  turn: its prompt as the input, its items as that turn's events, ended by
  `subagent.ended` or, still open, as interrupted with the parent's turn.
  The parent's stream gets `threads.subagent.started { turnId, subagentId,
  childThreadId, title }`. A subagent's own subagents are not shown apart,
  and a failure there never fails the parent's turn.
- **D878. Claude Code's `Agent` (and `Task`) calls** are such subagents: the
  call's `description` is the title and its `prompt` the input; the
  messages with its `parent_tool_use_id` become its items (whole text and
  reasoning blocks, tool calls and their results); the call's result ends
  it (a failed result fails it). The call itself stays in the parent's turn.

- **D879. A provider subagent in its parent's turn** is T3's subagent row:
  the chat passes `threads.subagent.started` to `chat.turn.item`, and
  `jhin.orchestration.provider-subagent` shows the child's title, its turn's
  status ("Completed", …) and elapsed time, opening its thread. The parent's
  Lineage section lists such children as subagent rows (no Stop: T3 stops a
  Claude subagent only through its live session).
- **D880. A provider subagent's thread runs on its own:** the composer is
  T3's `ProviderSubagentBar`: the agent's icon, the model ("Subagent"
  without one), the status ("Working 12s", "Completed in 1m 3s"), "Runs on
  its own" and "Open parent". The fake agent's `/subagent <task>` runs one.

- **D981. The thread's automations** (W20 continues in D981–D1000): T3's
  `ThreadAutomationsPanel` is a section of the thread details panel
  (`chat.thread.details`, contribution `jhin.scheduler.automations`,
  before Lineage, as in T3) listing the scheduled tasks bound to the thread (`threadId`):
  their status dot (never, running, succeeded, failed), title, schedule and
  "next …" or "paused", "Edit <title>" (opens Settings → Scheduled tasks),
  "Run <title> now" (not for a webhook; `scheduler.tasks.run`) and the
  switch "Pause <title>"/"Resume <title>" (`scheduler.tasks.update` with
  `enabled` alone); "Manage scheduled tasks" in its heading. A failure is
  told in a toast. It shows while the thread has such tasks, or with
  the error when they cannot be read (as in T3), for a thread of the
  connection's own node.
- **D982. One scheduler store per client, loaded with its first view:** the
  settings page and the automations section share it, in the page's chunk
  (D440); a chunk that failed to load is tried again.

- **D983. A task's workspace** is T3's launch strategy: `workspaceStrategy`
  of a scheduled task (`@jhin/scheduler-api`'s `WorkspaceStrategy`: the
  project checkout, a new worktree from `baseRef`, `startFromOrigin`, or a
  given checkout), stored with it and passed as `workspace` to the thread
  each run creates; a bound thread keeps its own. A task stored without one
  uses the project checkout. The editor's "Workspace" select has T3's three
  choices ("Create a new worktree", the default, "Use the project
  checkout", "Use a specific checkout"), with "Base branch" (default
  `main`) and "Start from origin" (on) for a worktree, and "Checkout path"
  for a checkout (required: "Checkout path is required").
- **D984. A task's model:** the editor's "Model" select lists "The node's
  default" and every agent's models ("<agent> · <model>", an unavailable
  agent's disabled), from `agents.list`, saved as the task's `agentId` and
  `model`.

### Subagents in the UI (W32)

Round 3 of `t3-roadmap.md` (D1161–D1180): what W20 left of T3's subagent UI.
The reference is D861's tag: `MessagesTimeline.tsx` (`V2SubagentGroup`,
`subagentGroupTiming`), `MessagesTimeline.logic.ts` (the grouping),
`SubagentTooltipContent.tsx`, `ThreadHoverCard.tsx`,
`client-runtime/src/state/subagentDisplay.ts` and
`ThreadRelationshipsControl.tsx` (the running count).

- **D1161. Subagents started one after another are one "N subagents" row.**
  T3 folds a turn's consecutive subagent items into one row; here the marks
  of tasks (D864) and of a runtime's subagents (D879) are other plugins'
  events in the turn, with the tool calls that started them between. So
  `chat.turn.item` gives each event the group it stands among
  (`ChatTurnItemProps.adjacent`, additive): the turn's events of other
  plugins with only the agent's work between them; a message, a plan or a
  steer starts another group. The orchestration view folds two or more
  subagent marks in a row of that group (no workflow or launch mark between)
  into T3's row, at the first; the others show nothing. The row is T3's:
  up to three agent avatars (the agent's icon, with the status dot when it
  is one) and "+N", "N subagents", the status summary ("1 working · 2
  done", T3's `summarizeSubagentStatuses`), the group's elapsed time (from
  the first start to the last end, ticking while any runs) and a chevron.
  It starts folded and unfolds into the members' rows. A mark a client older
  than D1161 renders gets no group and shows alone, as before.
- **D1162. A subagent row has T3's hover card.** Hovering (200 ms) or
  focusing a subagent row, alone or in a group, shows T3's
  `SubagentTooltipContent` in the glass popup the sidebar's cards use: the
  title, the agent's icon with the model ("Not reported" without one) and
  the effort option the child runs with, the status with its icon
  (`running`, `completed`, …) and elapsed time, the child's worktree when
  it is not its parent's ("Worktree", its folder's name), and a preview of
  the result (T3's `subagentDetailPreview`: the first 280 characters, on
  one line). The model and options are the child thread's (the
  catalog), else the task's. T3's progress line has no source here (a task
  carries no progress), so a running subagent shows none.
- **D1163. "Lineage · N running".** The Lineage section's title counts
  the thread's subagent threads (`relationshipToParent: "subagent"`, a
  delegated task, a workflow's agent or a runtime's subagent) whose turn
  runs and that are not archived, as T3 counts its active subagent edges
  (a workflow's agents among them, also while their workflow row is
  folded); waiting ones are not counted, as in T3. The count comes from the node's catalog, so it needs no
  record of the orchestration plugin.

### A runtime's subagents in the background, and stopping them (W32)

Round 3 of `t3-roadmap.md` (D1161–D1180). T3 keeps a Claude subagent that
runs in the background as a live child (`ClaudeAdapterV2.ts`: its
`task_started`, `task_updated` and `task_notification` frames, and
`stopTask` for "Stop subagent").

- **D1164. A subagent can outlive its turn** (`agent.runtime@1` 1.7,
  `agent.registry` 1.4, additive). A runtime yields `subagent.backgrounded
  { subagentId }` for a subagent that goes on in the background; the turn's
  end then leaves it running, and the runtime hands its later work over
  through `AgentTurn.afterwards`: `subagent.item` and `subagent.ended` items
  of the turn's backgrounded subagents only, ending once each has ended or
  the runtime can no longer follow them. The threads plugin keeps such a
  child's turn open past its parent's turn and projects those items into
  it as before (D877); a backgrounded subagent still open when `afterwards`
  ends (or of a runtime without it) ends `interrupted`, as an open one did
  with the turn. A node restart closes it like any running turn.
- **D1165. Claude Code's background subagents.** An `Agent` call with
  `run_in_background`, or one Claude Code registered or moved to the
  background (`task_started.is_backgrounded`, `task_updated.patch
  .is_backgrounded`, D805's moves), is backgrounded: its call's immediate
  result ("running in the background") ends the call in the parent's turn
  but not the subagent. Its own messages (`parent_tool_use_id`) and its
  `task_notification` (`completed`, `failed` with its summary as the error,
  `stopped` as `interrupted`) are read from the live session also after the
  turn ended, also while a later turn holds the session; a session that
  ends ends `afterwards`. A per-turn session is kept while its background
  work runs (D348), so its subagents go on too.
- **D1166. Stopping a runtime's subagent** (`AgentRuntime.stopSubagent
  { threadId, subagentId }`, 1.7): the runtime stops it and answers whether
  it did; its end comes as its `subagent.ended`. Claude Code's is the
  session's `stopTask` with the task of the call (`task_started.tool_use_id`).
  The threads plugin's `threads.subagent.stop { threadId }` takes the
  subagent's thread (`threads.write`), finds its parent and the runtime's
  `subagentId` (kept on the child's record as `subagentId`) and asks the
  parent's runtime; it refuses `SUBAGENT_NOT_RUNNING` when the child's turn
  does not run or the runtime answered false (it ended meanwhile), and
  `SUBAGENT_STOP_UNSUPPORTED` for a thread that is no runtime's subagent or a
  runtime without `stopSubagent`. The threads plugin follows `afterwards`
  until every backgrounded subagent ended, the parent is deleted or the
  plugin stops, and then lets the runtime go (`return()`), which lets go of
  the Claude Code session it read.
- **D1167. "Stop subagent" in the Lineage section for a runtime's
  subagent**, as for a task (D867, D868): shown while its turn runs, it
  runs `threads.subagent.stop` and spins until the command answers; a
  refusal is a toast. The fake agent's `/subagent-bg <task>` starts a
  subagent that answers "Echo: <task>" after its turn ended and runs until
  it is stopped.

### A subagent's progress (W38)

Round 4 of `t3-roadmap.md` (D1341–D1360), at T3 Code `eb7b35ac`.

- **D1343. A runtime reports a running subagent's progress**
  (`agent.runtime@1` 1.12, additive): the item `subagent.progress
  { subagentId, progress }`, in the turn or, for a subagent in the
  background, through `afterwards` (D1164). Claude Code's is T3's: the
  `description` of a `task_progress` frame (trimmed; an empty one says
  nothing) of a task this turn's subagent call started, in the foreground
  and in the background alike. The fake agent's `/subagent-bg` reports
  "Working on <task>" before it answers.
- **D1344. The progress lives on the child's latest turn**
  (`agent.registry` 1.6, additive): the threads plugin writes it to the
  subagent thread's record as `lastTurn.progress` while that turn runs, and
  keeps it on that turn once it ended (a later turn starts without one). A
  waiting turn takes new lines too, and shows the last. The hover card of a
  subagent row (D1162) shows T3's detail line: a running subagent its
  progress, else its result; an ended one its result, else its last
  progress (T3's `settled ? result || progress : progress || result`),
  on one line of at most 280 characters.
- **D1345. A subagent's text is not streamed, as in T3:** T3 projects only
  the frames without a `parent_tool_use_id` from Claude Code's stream
  (`ClaudeAdapterV2.ts`), so a subagent's messages come whole, as here
  (D878). The Deferred item asking for streamed text is closed by that.

### Deferred

- Saved workflows of the node (outside a project) and a command listing
  them; today they are read from the project only.
- A thread whose Lineage section is hidden (no rows) still counts as having
  details, so the panel does not say "No details for this thread" then.
- A delegated task's progress in its hover card: a task carries none (a
  runtime's subagent does, D1343). The card names a model by its id, not
  T3's catalog label, and shows no branch (the catalog does not know a
  thread's branch).
- A workflow's member rows have no hover card; T3's opening block has none
  either, but its Lineage rows do.
- A subagent thread that waits for the user (an approval or an answer) is
  reached only through its row in the parent's chat, as in T3: the sidebar
  hides it and it raises no notification. Without its row (a thread from
  before D862, or a mark that could not be written) it is reachable only by
  its id. A workflow's agents never wait (D373). Surfacing waiting subagents
  in the parent's sidebar card would close this.
- Live rows in a fork: the marks it copied from its source show "Status
  unavailable", because the records belong to the source thread; following
  them through `forkedFrom` would make them live.
- Following a mesh member's `orchestration` stream itself: its rows are read
  again on each change of its threads, not per record.

## W11. Scheduled tasks and webhooks

Status: **implemented** (`plugins/scheduler`, `packages/scheduler-api`, the settings page in `apps/web/src/plugins/scheduler`).

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
  from `request_secret` is D1034.
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
- **D389. The settings page, T3's:** the web client's builtin plugin
  `jhin.scheduler.ui` adds the section `scheduled-tasks` (Settings →
  Scheduled tasks) through `ui.settings@1`: the tasks of every connected node
  (one section per node when there are several), each row with its schedule
  ("Every 5 min", "Weekdays at 09:00", "On webhook"), the next run or
  Paused / Listening, the last run's status and error, an enable switch and
  the actions Edit, Run now (Deliveries for a webhook) and Delete (at once,
  without asking, as in T3; rotating a URL asks first), contributed to the
  slot `scheduler.task.actions` (ids `jhin.scheduler.<action>`). The editor
  dialog takes T3's name, project, prompt, trigger, weekdays, webhook URL
  (copy, rotate) and signature fields, plus the thread the runs go to (none:
  a new thread each run); the deliveries dialog lists the requests and shows
  one with its headers, body and the prompt it filled in. The page reads
  `scheduler.tasks.list` and follows the `scheduler` stream after its head.
- **D1034. A signature takes a `secretRef` (W28).** A webhook signature on
  `scheduler.tasks.create` and `.update` takes `secretRef` beside `secret`
  (T3's `ScheduledTaskUpsertWebhookSchedule`): a ref the user saved through
  `secrets.request` (security.md D1028), consumed by the save for the task's
  project (D1031), so it works once. A ref, when given, is the only source:
  a `secret` sent with it is ignored. The ref is consumed before the task is
  written; a save that fails after that has used it, and the agent asks
  again. Without `secrets.store@1` a ref is refused
  (`SECRET_STORE_UNAVAILABLE`). The tool's description says what T3's says:
  first call `secrets_request`, never ask for a secret in chat or invent
  one, then pass the ref (GitHub: `{type:'webhook', signature:{header:
  'x-hub-signature-256', encoding:'hex', prefix:'sha256=', secretRef}}`).
  The settings page's editor keeps T3's write-only Secret field: the person
  typing it is its owner.

### Binding to the calling thread, model options and the base branch (W32)

Round 3 of `t3-roadmap.md` (D1161–D1180). The reference is D53's tag:
`apps/server/src/mcp/OrchestratorMcpService.ts` (`scheduleTask`,
`updateScheduledTask`, `scheduledTaskWorkspaceStrategy`),
`packages/contracts/src/orchestratorMcp.ts`,
`apps/web/src/components/settings/ScheduledTasksSettings.tsx` (the editor's
`baseModelSelection`) and `WorktreeBaseBranchPicker.tsx`.

- **D1177. `bindToCurrentThread`, T3's.** The calling thread is the
  invocation's (an agent's MCP call names it, `x-jhin-thread`).
  `scheduler.tasks.create` without `projectId` takes the calling thread's
  project, and binds the task to the calling thread unless
  `bindToCurrentThread` is false (or `threadId` is null, a fresh thread per
  run); it binds by default only in that thread's project. `bindToCurrentThread: true` without a calling thread, or for
  another project, is refused (`INVALID_REQUEST`, T3's "bindToCurrentThread
  needs an agent running inside a Jhin thread." and "… binds to this thread,
  which belongs to a different project."), and with `threadId` too
  (`INVALID_REQUEST`: one of them). A task the call creates from a thread
  takes T3's workspace for it: the project checkout when bound, a new
  worktree of `main` from origin when not (a `workspaceStrategy` given wins),
  and the calling thread's agent, model, model options and modes for what it
  leaves out, as T3's runs inherit them. `scheduler.tasks.update` takes
  `bindToCurrentThread` too: true moves the task into the calling thread
  (refused without one, or for another project), false out of any thread,
  also without a calling thread, as T3's; the workspace follows as T3's does
  (a `workspaceStrategy` given wins). Otherwise a call without a calling
  thread (the settings page, the CLI) changes nothing: `threadId` binds.
- **D1178. A task keeps its model options.** A task has `modelOptions`
  (T3's `modelSelection.options`; `[{ id, value }]`, at most 20, as D870),
  given on create and update (null clears them) or inherited (D1177), and a
  run's new thread starts with them (the threads plugin keeps those its
  model declares, D297). The editor shows no picker for them, as T3's does
  not: it keeps them while the task's agent and model stay, and drops them
  when another model is chosen (T3's `baseModelSelection`).
- **D1179. The base branch is T3's picker.** "Base branch" is T3's
  `WorktreeBaseBranchPicker`: a button with the branch icon and the branch
  ("main" until one is chosen), opening a searchable list of the project's
  refs (`git.branches`, read when it opens; "current", "remote" and
  "default" badges) with "Start from origin" at its foot. A project whose
  refs cannot be read (no repository, no source control) keeps the text
  field.

### Deferred

- One shared `WorkspaceStrategy` contract: threads, orchestration and
  `@jhin/scheduler-api` each define T3's three strategies.
- "Edit" of the thread's automations opening that task's editor (the route
  has no task yet).
- Tasks of mesh members on the settings page: it shows the nodes the client
  is connected to.
- Component tests of the page. Its one end-to-end spec covers create, pause,
  run now and delete. The webhook parts (signature and secret, Rotate), the
  Deliveries dialog, several nodes and a node without the scheduler have no
  test in the UI yet. Below the UI, the server tests of `jhin.scheduler`
  cover them, and unit tests cover the store and the editor's validation
  (`draftProblem`).
- Releasing a run in-process when its completion cannot be recorded (T3's
  `releaseStuckRun`): today a storage failure at that write leaves the task
  marked running until the next start's recovery.
- The webhook signing secret a save takes (in clear or from a `secretRef`)
  is kept in `storage.kv` as before (D386), not in `secrets.store@1`
  (security.md D1021).
- A public webhook URL through a relay, held deliveries while the node is
  offline and their maximum age (`maxDeliveryAgeMinutes`): T3 does this with
  T3 Connect; Jhin's remote access is W13.
- A page-level test that the task editor keeps a task's model options on a
  save that leaves its model as it was (D1178); the server's side is tested.
- T3's ceiling on a task's modes from the calling agent's own (its
  `limits`): a task created from a thread takes the thread's modes (D1177),
  and one given wider modes keeps them.
- Metrics of deliveries (T3 counts them per outcome).
