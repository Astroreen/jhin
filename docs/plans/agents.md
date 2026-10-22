# Agents plan: teams of persistent agents

Status: **in progress**. This file records how Jhin grows from "one thread,
one agent run" into persistent agents with addresses that message each other
across the mesh, work in teams on missions, keep and inherit what they learn,
and stay on the intent while nobody watches. It takes "Agent entity …",
"multi-agent threads" and "AI Civilization" off the Deferred list of
`foundation.md` (D52).

The approach comes from OpenRig ([`../research/openrig.md`](../research/openrig.md));
its failure stories are in [`../lore/`](../lore/README.md). Jhin takes the
ideas, not the code, and builds them on its own rules: plugins on the public
API, every operation a command, UI as slots and contributions.

## Goal

The owner talks to one lead agent. Behind it a team of agents, on any nodes
of the mesh, works through a mission slice by slice. They ask each other
instead of guessing. They find what the project already has before they build
it again. They come back to the intent after every compaction. When ceremony
outgrows progress, the owner and an agent that has the context hear about it.
A working team can be saved and installed elsewhere like a plugin.

### Two ways to work

Jhin offers two ways of getting work done with AI, and they stay separate:

- **Threads** (T3 Code's way) are for many projects at once, each with an
  agent the owner works alongside. The owner watches every turn, and can
  interrupt, stop, correct or steer it directly. The unit is a thread, and the
  owner is in the loop of every turn.
- **Civilization** is for large, long projects. Agents work for days, and
  nobody watches every turn. The owner sets the intent and missions, talks to
  the lead, answers what agents escalate, and watches health and progress.
  The owner is above the loop, not in it. Steering a single agent turn by turn
  is not how a civilization is run; the owner steers through the lead,
  missions and intent, and can stop a team as a whole.

The web client switches between them (D741). Everything in this plan belongs
to the Civilization side and never shows up among the owner's threads.

## Rules for every workstream

- Read `AGENTS.md` (trailhead), `docs/map.md`, `docs/README.md`, this plan,
  `docs/research/openrig.md` and `docs/lore/` first.
- Take decisions from your workstream's range below. Record them in this
  plan under your workstream's heading, and move what you leave to
  [Deferred](#deferred).
- New public API is additive. Existing ids (`agents.list`, `agentId` on
  turns and threads, `jhin://<nodeId>/agents/<id>`) keep working.
- Add every new package, plugin, capability and command to `docs/map.md`,
  and every new word to `GLOSSARY.md`, in the same PR.
- Overlaps with the T3 workstreams (`t3-roadmap.md`): W1 owns the
  server-side queue, W10 delegated tasks and workflows, and W11 scheduled
  tasks. Build on what they merged. Do not build a second one
  ([reinvent the wheel](../lore/reinvent-the-wheel.md)). If you need
  something of theirs that has not landed, write down the seam you need and
  build against it.
- Stacked workstreams start from the branch they stack on and rebase when it
  merges.

## Workstreams

| Id  | Workstream                              | Stacks on   | Decisions |
| --- | --------------------------------------- | ----------- | --------- |
| A1  | Agent entity                            | `main`      | D602–D620 |
| A2  | Messaging between agents, and the owner | A1          | D621–D640 |
| A3  | Missions and slices                     | `main`      | D641–D660 |
| A4  | Context library and lore                | `main`      | D661–D680 |
| A5  | Teams and team bundles                  | A1, A2      | D681–D700 |
| A6  | Orchestration and refocus               | A1, A3, W10 | D701–D720 |
| A7  | Health: ceremony against progress       | A2, A3      | D721–D740 |
| A8  | Modes and the Civilization shell        | `main`      | D742–D760 |

A1, A3, A4 and A8 start together. A2 starts once A1 has settled its contract
(`agent-api` types and the `agents.*` commands), A5 and A7 once A2 has, and
A6 once A3 has and W10 has landed.

## Decisions

### Shared

- **D600. Words.** The persistent actor is an **agent**, as `GLOSSARY.md`
  already reserves; it is OpenRig's _seat_. The process or session sitting
  in it at a time is a **generation** of the agent. A **team** is OpenRig's
  _rig_. A **mission** is a planned outcome of a project, and a **slice**
  is one change in it, with a **spec** and a **proof**. **Ceremony** is the
  work around the work: checks, handoffs, approvals. Pods are deferred: a team
  is flat until a team needs groups.
- **D601. Runtimes stay runtimes.** `agent.runtime@1` keeps meaning "what
  executes a turn" (Claude Code, Codex, fake). Every runtime is also an
  implicit agent with the same id, so `agentId: "claude"` on existing threads
  and turns stays valid, and `agents.list` still lists it. A defined agent
  (`builder`) names its runtime and model. Turns of defined agents record
  both `agentId` and `runtimeId`. A record without `runtimeId` is read as
  `runtimeId = agentId`.
- **D741. Threads and Civilization are two modes of the client, and their
  data stays apart.** A **mode** is a client contribution with its own layout
  (sidebar and main area slots). The app chrome shows a mode switcher, the
  mode is part of the route, and a keybinding switches it. Threads mode is
  today's T3 Code layout, unchanged. Civilization mode is contributed by the
  agents plugins. Users can add their own modes.
  - Agent generations run on the same thread machinery (turns, runtimes,
    event log), so nothing is built twice. They are marked as belonging to an
    agent, so the thread lists and catalogs of Threads mode leave them out by
    default (an additive filter; old clients see what they saw before).
  - In Civilization mode an agent's generation is **observed, not driven**:
    its transcript is readable, but there is no composer on it. The owner
    talks to the lead (a conversation of its own), answers asks in an inbox
    (A2), edits intent and missions (A3), and can stop or resume an agent or a
    whole team. Correcting one agent mid-turn is Threads mode's job.
  - A8 builds the mode capability, the switcher and the Civilization shell.
    A1, A3, A5 and A7 contribute their views into that shell, not into the
    Threads layout.

### A1. Agent entity (D602–D620)

An agent is defined on a node, usually for a project. Its definition is
config, and its state is storage:

- definition: id (unique on the node), title, **role** (a short job
  description), runtime and model, runtime and interaction mode, instructions,
  skills, home project. Defined in a config section (`jhin.agents`) on the
  node or project layer, so the settings page edits it with no new UI.
- address `jhin://<nodeId>/agents/<id>`, resolvable through any node
  (`mesh.resolve`).
- **generations**: each generation is one thread of the agent, in its home
  project. The current generation receives the agent's work, and earlier ones
  stay readable. `agents.rotate` starts a new generation (for example when the
  context is spent). The new generation starts with the agent's inherited
  knowledge, not with the old transcript.
- **inherited knowledge**: Markdown files the agent's generations read and
  write, under the project (`.jhin/agents/<id>/`). They are plain files, so the
  owner reads and edits them, and A4 can address them.
- commands: `agents.list` (additive), `agents.get`, `agents.define`,
  `agents.update`, `agents.remove`, `agents.rotate`, `agents.generations`.
  Events go to an `agents` stream.
- generations are threads marked with their agent (D741): Threads mode's
  lists leave them out.
- client, in Civilization mode (D741): a roster of agents with their role
  and a status (idle, working, waiting for the owner), and an agent's page
  with its generations, readable but without a composer, and stop and resume.

Decisions are recorded here as they are taken. The contract (types, event
types and the schemas of the `agents.*` commands) is
`packages/agent-api/src/agents.ts`.

- **D602. Defined agents are the plugin `jhin.agents`, registered as
  runtimes.** It requires `agent.registry@^1` and `host.identity@^1`, keeps
  generations in `storage.kv` and appends to the `agents` stream. Each
  defined agent is registered in `agent.registry@1` as a runtime of its own id
  that hands its turns to its runtime, with its model, modes and instructions
  filled in. So `agents.list`, `threads.send`, turns and the event log need no
  second path for agents (D601), and threads and runtimes stay unaware of
  definitions. The plugin reaches threads and projects through their
  commands (`threads.create`, `threads.get`, `projects.list`).
- **D603. Id, address and the runtime fields.** An agent id is lowercase
  letters, digits and `-`, starting with a letter (`AgentId`), unique on the
  node among defined agents and runtimes: an id a runtime has is refused
  (`AGENT_ID_TAKEN`), since that runtime is already the implicit agent of
  the id. The address is `jhin://<nodeId>/agents/<id>`; `mesh.resolve`
  already resolves it to its node, and every `agents.*` command on an existing
  agent takes its `agentId` or this node's address of it (`agents.define`
  takes a new `AgentId`) (another node's address is
  `AGENT_ELSEWHERE` with its `nodeId`, for `mesh.call`). `AgentRuntime` gets
  two optional fields: `runtimeId` (the runtime a defined agent's turns run
  on, absent for a runtime) and `role`.
- **D604. The definition is the config section `jhin.agents`:**
  `{ agents: { <id>: { title?, role, runtime, model?, runtimeMode?,
  interactionMode?, instructions?, skills?, project? } } }` on the node or
  project layer, so the settings page edits it as a key/value list of groups.
  `project` is a project's id or its path, the scratch project when unset.
  `agents.define`, `agents.update` and `agents.remove` write the layer through
  `host.config.patch` (the node layer unless `define` names `project`),
  touching only the agent's own entry in that file. `update` writes the
  changed keys into the highest file that defines the agent and clears an
  `unset` field from every file that sets it; `remove` empties the files
  highest first, so a write that fails leaves a valid definition, and its
  error names the files already done (`removedFrom`; `updatedIn` for an
  update, which writes several files the same way). A file edited by hand
  counts the same; a hand edit that breaks the section keeps the agents as
  they were until it is fixed.
  The plugin compares each change of the section with what it last recorded
  and appends the events, so the `agents` stream follows the files.
- **D605. What a generation is told.** `TurnRequest` gets an optional
  `instructions`: who the agent is (title, address, generation), its role, its
  instructions, its skills, and where its inherited knowledge is and that it
  keeps it current. Claude Code appends it to its system prompt, so it is part
  of the live session's launch key (D99): a changed definition starts Claude
  Code again with `resume`. A runtime that cannot use instructions still runs
  the turn.
- **D606. Generations are threads marked with their agent.** A generation is
  a thread in the agent's home project, created by `agents.rotate` (also the
  first one: an agent has no generation until it is rotated or work arrives,
  A2) and titled `<title> #<n>`. Its thread record carries
  **`generationOf: <agentId>`** (`GenerationOf`), set once by `threads.create`
  (an optional input) and never changed. This is the D741 mark, agreed with
  A8: A1 owns the field (`GenerationOf` in `agent-api`, the `Thread`
  schema of the threads plugin, the `threads.create` input and the client's
  `ThreadRecord`), and A8 owns the filter (`threads.list` and
  `threads.catalog` leave such threads out unless `includeGenerations: true`,
  and Threads mode's store drops them from the index). The generation's number is not on the thread: the list of
  generations (number, thread, start, reason) is kept in `storage.kv`
  (`jhin.agents`, `agent/<id>`), one source for it. A generation is recorded
  before its thread is made, under the thread id it chooses (W1's idempotent
  `threads.create`): a failed creation takes the record back, and a current
  generation whose thread a crash kept from being made gets it on the next
  start. `agents.generations`
  reads the threads with `threads.get`, which is unfiltered. Rotating leaves
  the previous generation as it is, readable, not archived and not stopped;
  only new work goes to the current one.
- **D607. Inherited knowledge** is the folder `.jhin/agents/<id>/` in the
  home project, created when a generation starts. The `*.md` files directly in
  it, by name, go in front of the first message of every generation (as D102
  hands over a transcript), the whole text with its headings up to 64 000
  characters; files past that are named, not inlined, and one whose size
  alone is past it is not read. The transcript of earlier generations is not. The agent
  writes the files with its own tools, as the instructions ask.
- **D608. Status** is `working` or `waiting` while the current generation's
  latest turn runs or asks the owner, `stopped` (D612), `unavailable` when its
  runtime or home project is not on the node, else `idle`. `agents.get` and
  `agents.generations` compute it; clients take it from the generation's
  thread, which they follow anyway (`agentStatusOf`). The `agents` stream
  carries definitions and generations, never status, so no second copy of a
  thread's state goes stale.
- **D609. Commands and events.** `agents.get`, `agents.define`,
  `agents.update` (with `unset`, never for a field it also sets), `agents.remove`, `agents.rotate`,
  `agents.generations`, `agents.stop`, `agents.resume`, and
  `agents.catalog` (the defined agents and the head of the `agents` stream,
  as `threads.catalog` does for threads). Events of the `agents` stream:
  `agents.agent.defined` and `agents.agent.updated` (the record),
  `agents.agent.removed`, `agents.generation.started`,
  `agents.agent.stopped`, `agents.agent.resumed`. Reading needs
  `agents.read`, changing `agents.write`.
- **D610. `agents.list` stays and grows.** It lists runtimes and defined
  agents, with the additive fields `kind` (`runtime` or `defined`),
  `runtimeId` and `role`. A node's default agent is never a defined agent,
  unless `jhin.threads.defaultAgent` names one. `agent.turn.started` records
  `runtimeId` for a defined agent's turn (the thread's `lastTurn` keeps
  `agentId` only). A runtime
  that tells turns apart by agent (Claude's D102) compares
  `runtimeId ?? agentId`, so a generation's own earlier turns are never
  handed to it as another agent's.
- **D611. Removing an agent removes its definition only.** Its generations,
  their threads and its knowledge stay; defining the id again continues with
  the next generation, since inheritance belongs to the address.
- **D612. Stop and resume.** `agents.stop` interrupts the current
  generation's running turn and marks the agent stopped (`stoppedAt`):
  `agents.rotate`, A2's messages and any turn of the agent (its runtime
  refuses to start one, so `threads.send` fails with `AGENT_STOPPED`) are
  refused until `agents.resume`. A whole team stops through its agents (A5).
- **D613. Skills are names in A1.** The definition lists them and the
  instructions name them; installing or limiting a runtime's skills per agent
  is deferred.
- **D614. The client shows agents in Civilization mode only (D741):** a
  roster of agents per project (title, role, status) and an agent page with
  its generations, read-only (no composer), and stop and resume. Nothing of it
  goes into the Threads sidebar or header. It contributes to A8's shell.
  The client plugin is `jhin.agents-view`
  (`apps/web/src/plugins/agents/`): the roster is `jhin.agents.roster` in
  `civilization.sidebar.agents`, the page `jhin.agents.page` in
  `civilization.views`, both a chunk of their own (D440). A generation's
  conversation comes from the new slot **`thread.transcript`**
  (`THREAD_TRANSCRIPT_SLOT`, `ThreadTranscriptProps { target, threadId }` in
  `@jhin/client-api`), which the chat plugin fills with
  `jhin.chat.transcript`: its timeline without composer, header, requests or
  message actions. A3's mission view reads generations through the same
  slot.
- **D615. An agent's page is a route.** Panel `agent`, mode
  `civilization`, the agent in `section`: `<agentId>` shows the current
  generation, `<agentId>/<n>` generation `n`. The route never carries
  `thread`, so nothing that follows Threads mode's open thread (its panels,
  visits) takes a generation for one. The client command
  `civilization.agent.open { node, agentId, generation? }` opens it, and the
  roster's rows run it, so the palette, the CLI and MCP reach it as well
  (AGENTS.md rule 6).
- **D616. The client's status of an agent** follows D608 without a second
  source: `stopped` from the record's `stoppedAt`; `unavailable` from the
  record (no `projectId`) or from `agents.get`, which knows whether the
  runtime is on the node; `working`, `waiting` and `idle` from the current
  generation's thread as the `threads` index reports it after its head,
  `agents.get`'s answer standing until that thread changes. The client reads
  `agents.catalog`, then `agents.get` for each agent and again whenever the
  `agents` stream defines or updates it (a stop, a resume and a new
  generation are each followed by `agents.agent.updated`, D609).
- **D617. The roster is grouped by home project**, in the order of the
  node's catalog of projects (the scratch project first), with agents whose
  home project is not on the node last; with several open nodes each node's
  agents are under its label. A row shows the title, the role and a status
  dot, and its accessible name is `<title>, <status>`. Stop and resume are
  the page's buttons (`agents.stop`, `agents.resume`) and a failure shows as
  a toast; there is no composer anywhere in it.

### A2. Messaging between agents, and the owner (D621–D640)

- `agents.send { to, from, body }` delivers a message to the current
  generation of the agent at `to`, on any node (through `mesh.call`). If the
  agent is in a turn, the message waits in the thread's queue (W1). The
  message is shown in the thread as from its sender, with a link back.
- `agents.ask { to, question }` returns an answer. A live agent answers in a
  turn. A dormant one is answered by a side turn that resumes its last
  session, without changing its current generation. With `generation`, it
  asks an earlier generation instead: the library of minds.
- Agents reach these commands as MCP tools of their node, so any runtime with
  MCP can use them. Claude Code gets the node's MCP server attached (W9 owns
  that seam).
- **The owner is addressable** (`jhin://<nodeId>/owner`): `agents.ask` to the
  owner becomes an item in Civilization mode's inbox and a notification. Answering it
  answers the agent.
- Every message carries a `traceId` and the sender's address, so a chain of
  asks can be followed in logs ([just following orders](../lore/just-following-orders.md)):
  an approval says who gave it and with which context.

Decisions are recorded here as they are taken. The contract (addresses,
the message, the inbox, events and the schemas of `agents.send`,
`agents.ask` and `agents.inbox.*`) is `packages/agent-api/src/messages.ts`.

- **D621. A message** is `{messageId, kind, from, to, body, traceId, sentAt,
  inReplyTo?, generation?}` (`AgentMessage`); `kind` is `message`, `ask` or
  `answer`. The first node that handles it chooses `messageId` (or takes the
  caller's, so a retry is idempotent) and keeps it on every hop; `traceId` is
  the request's (RPC, MCP and `mesh.call` already carry one), a new one only
  for an in-process caller without it. The text a recipient's turn gets
  starts with a header naming the sender, the trace and how to reply
  (`messageText`); the structured message goes beside it (D623).
- **D622. Parties and who may send as whom.** Three kinds of address take
  part: an agent (`jhin://<nodeId>/agents/<id>`), a node's **owner**
  (`jhin://<nodeId>/owner`) and a thread that is no generation
  (`jhin://<nodeId>/threads/<threadId>`, a Threads-mode agent). `from`
  defaults to the caller: a call bound to a thread (an agent credential, D340)
  is that thread's agent when the thread is a generation (`generationOf`),
  else the thread; any other caller is this node's owner. A caller bound to a
  thread can send only as it, and a mesh caller (`node:<X>`) only as a party
  on node X, whatever its grants (`SENDER_MISMATCH`, naming who it is).
  In-process callers and other callers holding `*` (the owner's token) may
  name any `from`: A5 and A7 send for the lead.
- **D623. Delivery reuses W1's queue.** On the recipient's node a message to
  an agent goes to its current generation with `threads.queue.add` (its
  `messageId` is the queued message's id): it starts a turn on a free thread,
  else it waits in the queue. An agent without a generation is rotated first
  (reason `message`), as D606 foresaw; a stopped one refuses
  (`AGENT_STOPPED`, D612), and a runtime, having no generations, refuses
  (`AGENT_IS_RUNTIME`). A message to a thread address goes to that thread the
  same way. The queued message and its turn's `agent.turn.started` carry it
  as `origin` (`MessageOrigin`: id, kind, sender, trace, reply), so the thread
  shows it as from its sender, with a link back. A message for another node
  is sent there with `mesh.call` to the same command, with the resolved
  `from`, the `messageId` and the trace, holding no more than
  `agents.message` (the caller here held it). A `messageId` the node has
  delivered is not delivered again; given again by another sender it is
  `MESSAGE_EXISTS`. A reply names the message it answers (`inReplyTo`) and
  goes as an `answer`.
- **D624. An ask is answered in a turn.** `agents.ask` delivers like
  `agents.send` (kind `ask`), then waits for the turn its message started to
  end: the answer is that turn's last assistant message, and a failed,
  interrupted or silent turn is `NO_ANSWER`. The current generation is the
  live agent, so it answers in its own thread and remembers it; the call has
  no timeout of its own (an agent's MCP call has its client's).
- **D625. The library of minds.** With `generation` naming an earlier
  generation, the ask goes to that dormant generation in a **side turn**: its
  thread is forked at its last ended turn (`threads.fork`, whose fork of a
  generation keeps `generationOf`, so Threads mode leaves it out, D745) into
  a thread recorded as no generation, and the question runs there. A
  generation with no ended turn has nothing to answer from (`NO_ANSWER`). Neither the
  asked generation nor the current one changes. The fork resumes from the
  generation's turns (the runtime gets them as history, D102). Naming the
  current generation is the same as naming none.
- **D626. The owner's inbox.** A message or ask to an owner address starts no
  turn: it becomes an `InboxItem` on the `agents/inbox` stream of that node,
  open until the owner answers it with `agents.inbox.answer`. The answer goes
  back to the sender as an `answer` message (`inReplyTo` the ask), through
  D623, so it wakes the asker's generation. `agents.ask` to the owner returns
  at once, `pending`; the agent's turn goes on or ends, and the answer
  arrives as its next message. The client shows the open items in
  Civilization mode's inbox (`civilization.sidebar.inbox`) with a
  notification, never in Threads mode (D741).
- **D627. Every message is recorded where it is delivered,** as
  `agents.message.delivered` on the node's `agents/messages` stream, and an
  ask's answer as `agents.message.answered`, both with their `traceId` and
  sender. A7 counts ceremony from this stream; the transcripts need not be
  parsed.
- **D628. Permissions.** `agents.send` and `agents.ask` need
  `agents.message`; reading `agents/messages` needs `agents.read`; the inbox
  (`agents.inbox.list`, `agents.inbox.answer`, the `agents/inbox` stream)
  needs `agents.inbox`. Agents get `agents.read` and `agents.message` through
  their node's MCP server (`AGENT_PERMISSIONS`), never `agents.inbox`: an
  agent cannot answer for the owner. On the recipient's node a mesh caller
  holds what both the original caller and its member grants hold (D416): the
  sending node forwards with its caller's grants, so a member without
  `agents.message` cannot message its agents.
- **D629. Agents reach messaging as MCP tools of their node**
  (`agents_send`, `agents_ask`): W9's server already exposes every command
  the agent credential permits, so the tools appear once D628 grants them,
  and `jhinToolsInstructions` names them.
- **D630. The inbox in Civilization mode** is the client plugin `jhin.inbox`.
  It follows `agents.inbox.list` and the `agents/inbox` stream of every open
  connection for as long as it runs, so a new item is told in any mode: a
  toast while the page has focus (unless `jhin.notifications.inApp` is off),
  else a system notification when `jhin.notifications.mode` allows it. Both
  open the item. The open items of every node, oldest first, fill
  `civilization.sidebar.inbox` (`jhin.inbox.list`). An item's page is the
  route panel `inbox` with the message id as `section`, in
  `civilization.views` (`jhin.inbox.item`): the sender's address, the time,
  the trace, the text and an answer box that calls `agents.inbox.answer`.
  `civilization.inbox.open {node, messageId}` opens it. A node whose inbox
  this client may not read shows none. Nothing of it goes into Threads mode
  (D741).

### A3. Missions and slices (D641–D660)

- A project gets an **intent**: one paragraph on what it is for.
- A **mission** has an outcome, slices, and an order between them: waves of
  parallel slices, and dependencies.
- A **slice** has a spec (what must work), an assignee (an agent or the
  owner), a status, a link to the thread or threads that work on it, and a
  **proof** (commands with output, screenshots, links) recorded when done.
- Stored as events in the project, editable through commands
  (`missions.*`, `slices.*`) and readable as Markdown, so humans and agents
  read the same thing.
- client, in Civilization mode (D741): a mission view with its waves, from which you zoom from mission to
  slice to the thread of the agent working on it.
- The **process per level** (for example spec → build → test for a slice,
  merging between slices, release between missions) is data on the mission,
  not code. A6 drives it.

Decisions:

- **D641. One `missions` stream per node, folded.** Every change is an event
  of the node's `missions` stream, and the state is the fold of that stream
  (`applyMissionEvent` in `@jhin/missions-api`), on the node and in clients
  alike. No second copy in `storage.kv`: the plugin keeps the fold in memory,
  catches up from its head before every command (so another process sharing
  the storage is seen), and appends with `expectedHead`, retrying on a
  conflict (`MISSIONS_BUSY` after five tries). A command that changes
  nothing appends nothing. Records carry their `projectId`; missions are few, so one stream
  per node is enough and a client follows one stream (`missions.catalog`
  returns the head, as `threads.catalog` does). Following the stream takes
  `missions.read`, like the commands, not `events.read` (security.md D415).
- **D642. Events carry the whole record.** `missions.intent.set`,
  `missions.mission.created|updated`, `missions.slice.created|updated` and
  `missions.slice.proved` each carry the record after the change, plus `by`
  (the caller's id) and `traceId` when the call had them. A reader (A6, A7,
  a client) needs no history to know a record, and A7 counts ceremony by
  event type: a `missions.slice.proved` after the slice was done is a proof
  edit.
- **D643. The intent lives with the missions, keyed by project.**
  `missions.intent.set { projectId, intent, process }` keeps one paragraph
  and the project's process between missions. Projects stay `jhin.threads`'
  records; a project id is checked against `projects.list` at call time
  when that command is registered, without depending on the plugin. The
  check is best-effort: no capability names projects, so a node without
  `projects.list` takes any project id. Reads by project id
  (`missions.intent.get`, `missions.markdown`, `missions.list` and
  `slices.list` with a `projectId`) check it too. The lookup runs
  as the node, not the caller: it checks an id the caller named and reads the
  project's name for the Markdown heading. A failing `projects.list` fails
  the command with its error and nothing is appended; the check runs before
  the append, not with it, so a project deleted meanwhile keeps its missions
  (see Deferred).
- **D644. Waves are the order.** A slice has a `wave` (1 first) and
  `dependsOn`: slices of the same mission in strictly earlier waves. So the
  order never loops, and a change that would break it (a dependency in the
  same or a later wave, a dependant left in front) fails with
  `SLICE_ORDER_INVALID`, as does newly depending on a dropped slice, which
  could never start. A dropped dependant holds nothing back. Without a wave, a new slice goes to the wave after its
  dependencies.
- **D645. The assignee is an address.** `jhin://<nodeId>/agents/<id>` or
  `jhin://<nodeId>/owner`, kept as a string: the agent need not exist yet
  and may live on another node, and nothing here depends on A1's code.
- **D646. Proof is small and marks the slice done.** `slices.prove` records
  one to ten items (a command with its output, a screenshot URL, a link),
  who recorded it and when, and sets the slice done. A slice is done only
  with a proof (`PROOF_REQUIRED`), and a dropped slice cannot be proved
  (`SLICE_DROPPED`). A slice leaving done loses its proof, so done again
  takes a new one. Proving again replaces the proof and is its own event, so a recursive proof loop is visible, not prevented
  ([bureaucracy](../lore/bureaucracy.md)).
- **D647. Linked threads are references.** A slice lists `{ threadId,
  nodeId? }` of the threads working on it (`slices.link`, `slices.unlink`).
  They are agent generations (D741), shown read-only; the slice does not
  own them. A dropped slice takes no new thread (`SLICE_DROPPED`); a done
  one does, since a thread may review or rework it, and unlinking always
  works; without `nodeId` it removes that thread id on any node, as
  `slices.list` finds it.
- **D648. Process per level is data.** A mission has
  `process: { slice: Step[], mission: Step[] }` (default spec → build →
  test, and merge), the project's intent has its `process` between missions,
  and a slice records its current `step`, which must be a step of its
  mission's slice process (`SLICE_STEP_INVALID`); a mission's new slice
  process that lacks a step one of its slices is at is refused the same way.
  Nothing runs it: A6 reads it.
- **D649. Markdown is rendered, not stored.** `missions.markdown
  { projectId } | { missionId }` renders intent, missions, waves, slices and
  proof from the fold, so humans and agents read the same thing and there is
  no file to drift. User text cannot break the document: titles stay on one
  line, headings in an intent, outcome or spec are escaped and a fence they
  open is closed, titles, the project name, assignees and thread ids are
  escaped, a
  proof command is fenced with its output, and proof URLs are http(s) only,
  their parentheses and spaces encoded. Blank lines are collapsed only
  between the renderer's own lines; a code block keeps its own. Raw HTML
  in the user's text is kept as text Markdown allows; a reader renders it
  without raw HTML, as the web client's Markdown does.
- **D650. The intent chain is one command.** `missions.chain { sliceId }`
  or `{ threadId, nodeId? }` returns slice spec → mission outcome → project
  intent. For a thread it takes its open slice changed last; without
  `nodeId` a thread id matches on any node, as `slices.list { threadId,
  nodeId? }` does. This is what A6's refocus hands an agent.
- **D651. Statuses.** A mission is `planned`, `active`, `done` or
  `dropped`; a slice `planned`, `active`, `blocked`, `done` or `dropped`.
  Nothing is deleted: a mistake is dropped, and a dropped slice stays
  dropped (`SLICE_DROPPED`), unchanged by `slices.update`, `slices.link` or
  `slices.prove`: plan a new one instead. A mission's status is set by
  whoever runs it, not derived from its slices: a mission may be done or
  dropped with slices still open (A6 decides when a mission is done), but a
  done or dropped mission takes no new slices (`MISSION_CLOSED`). Dropping a
  slice leaves its open dependants waiting until they are re-pointed or
  dropped too; noticing them is A6's (see Deferred).
- **D652. Agents reach missions.** `missions.read` and `missions.write` are
  in a thread agent's permissions (D341), so an agent over MCP reads its
  intent chain and records its slice's proof. Like D341's other
  permissions they are node-wide: an agent is not fenced to the slices that
  link its thread, and `by` on every event and proof says who acted. Fencing
  agents to their own slices waits for A1's agents and A6's runner.
- **D653. The mission view owns two route panels.** The client plugin
  `jhin.missions-view` contributes `jhin.missions.view` to
  `civilization.views` and renders only for `p=mission` (the mission id as
  section) and `p=slice` (`<sliceId>`, or `<sliceId>/<threadId>[@<nodeId>]`
  for a thread working on the slice); any other panel is another view's and
  it renders nothing. It never sets the route's `thread`, so a thread's
  terminal, browser or keybindings of Threads mode do not follow a generation
  opened here.
- **D654. The Missions section lists the route's node.** `jhin.missions.sidebar`
  fills `civilization.sidebar.missions` with the missions of the route's
  connection (the first open one without a route node), grouped by project
  (named from the threads catalog), open ones first (active, planned, then
  done and dropped). A node without `missions.catalog`, or a token without
  `missions.read`, says it has no missions instead of failing.
- **D655. The client folds the stream as the node does.** A store per
  connection reads `missions.catalog`, then follows the `missions` stream
  after its `head` and applies each event with `applyMissionEvent` (D641):
  one subscription however many components look. It starts over when its
  connection opens again, and after a failure at once, then backing off up
  to 30 s. The view and its store are a chunk of their own (D440), loaded once
  the Missions section shows.
- **D656. Mission → slice → thread, read only.** A mission shows the
  project's intent, its outcome and process, and its waves of slices
  (status, step, assignee, proof, thread count); a slice its facts, spec,
  dependencies, proof (commands with their output, http(s) links) and linked
  threads; a thread its transcript through the `thread.transcript` slot
  (A1's seam, D614), with no composer (D741). A breadcrumb leads back up. A
  thread on another node of the mesh (`nodeId`) is read through it. Nothing
  edits; the commands do (Deferred).

### A4. Context library and lore (D661–D680)

What `docs/README.md` does by hand, as a plugin for any project:

- **Addressable Markdown**: `context.read { path, heading? }` returns one
  section of a Markdown file in the project. `context.view` composes
  sections from several files into one view. Headings and paths are
  addresses.
- **Map and routes**: `context.map` returns the project's map (its
  `docs/map.md`, or what the project config names) and checks route-to-leaf
  reachability. It reports pages no route from the trailhead reaches.
- **Maturity**: a page or section can be marked `canon`, `insight`, `note`
  or `observation` in its front matter. `context.read` returns the level, and
  canon wins on conflicts.
- **Lore**: `lore.list` and `lore.get` for a project's (and an agent's or a
  team's) lore. A hook gives a new generation the lore on start and after a
  compaction, once A1 has generations.
- A **router skill** for the project, generated from its map and installed
  where the runtime looks for skills.

Decisions:

- **D661. A plugin with commands, no capability.** `jhin.context`
  (`plugins/context`) is a server plugin any project can use. It provides no
  service yet: every operation is a command. A project's root is the
  `projectId` given (through `projects.list`), else the directory the node
  runs in, which `host.paths@1.1` now exposes as `cwd` (optional, additive).
  The plugin requires `host.paths@^1.1`, so it never guesses a directory.
  It reads and writes project files with `node:fs` directly, so it runs on
  server nodes only (`side: server`), under the node process's own rights;
  its path guard (D662) keeps it inside the project.
  Projects are no capability: `projectId` is looked up through the
  `projects.list` command, as `jhin.source-control` does, and a node without
  it answers `PROJECT_NOT_FOUND`. How a project arranges its library is the
  `jhin.context` config section: `trailhead` (`AGENTS.md`), `map`
  (`docs/map.md`), `library` (`["docs"]`), `lore` (`docs/lore`), `maturity`
  and `skill`.
- **D662. Section addresses.** `context.read { path, heading? }` takes
  `path#heading` or a separate `heading`. A heading is named by its GitHub
  anchor (duplicates get `-1`, `-2`), or by its text in any case. `#D11`
  names the decision written as `**D11.`: its list item or paragraph. A
  section runs to the next heading of the same or a higher level. Paths are
  project-relative and name Markdown pages; anything else, or outside the
  project, also through a symlink (a page, or a directory a skill is
  written into), fails with `PATH_INVALID`, an unknown `projectId` with
  `PROJECT_NOT_FOUND`, a missing heading with `HEADING_NOT_FOUND` and the
  page's anchors. The output carries the page's outline (`headings`), so a reader can pick the
  next section without reading the page.
- **D663. Views keep the caller's order.** `context.view { sections }`
  joins the sections in the order given, each under an HTML comment naming
  its address and maturity, so the composed text still says where every
  part came from. It does not reorder by trust.
- **D664. Routes and reachability.** A route is a Markdown link or a
  **mention**: a path in backticks ending in `.md` or `/`. A link resolves
  against its page's directory, a mention first there, then against the
  project root (the nearest page wins, as for links), a leading `/` against
  the root, and
  a directory routes to its `README.md`. Code blocks and code inside link
  labels are not routes. `context.map` walks breadth-first from the trailhead
  and returns every page reached (hops, and the page that first routed to
  it), the `library` pages it never reaches (`unreachable`), links and
  mentions of a section (`docs/map.md#shape`) that lead nowhere or to a
  missing anchor (`broken`), and plain mentions of pages that resolve nowhere
  (`unresolved`: a page still to be written, like `preview.md`, or a file of
  another repository). Only `broken` and `unreachable` are errors, so prose
  may name paths outside the project.
- **D665. Maturity from front matter, then location.** A page sets
  `maturity: <level>` in its front matter, and a section
  `maturity.<anchor>: <level>`, inherited by its subsections. Without one,
  the longest matching key in the `maturity` config wins: a page
  (`AGENTS.md`) or a directory (`docs/lore/`, the `/` optional), never a
  plain string prefix. Levels are
  `observation`, `note`, `insight` and `canon`; exhaust is never committed,
  so it has no level. Every section comes back with `maturity` and a `rank`
  (0 unmarked … 4 canon): on a conflict the higher rank wins, and the caller
  compares ranks. This repository's levels follow `docs/README.md#maturity`
  in its project config (`.jhin/config.jsonc`), with plans in progress at
  `note`.
- **D666. Lore is a directory with an index.** `lore.list` lists the
  Markdown files of the project's lore directory and, with `agent`, of the
  agent's own (`.jhin/agents/<id>/lore/`, under A1's inherited knowledge).
  A story's name and lesson come from the row or item of the directory's
  `README.md` that links it ("moonbase"), else from its front matter (`name`,
  `lesson`), else from its file name. `lore.get { name }` finds a story by
  name, title, file name or path. A story's maturity is what `context.read`
  returns for its page: this repository sets `docs/lore/` to `insight`.
- **D667. The lore brief is a command with a hook.** `lore.brief { agent?,
  reason: start | compaction | request, full? }` returns the Markdown an
  agent gets on start or after a compaction: every story's name, address and
  lesson, or the whole stories with `full`. It runs through the
  `lore.brief` hook, so a team (A5) or refocus (A6) can add to it. A generation's
  start calls it (D671); a compaction does not yet (see [Deferred](#deferred)).
- **D668. The router skill is generated.** `context.skill` generates a skill
  from three canon sources: the trailhead's route section (`skill.route`,
  default `find-your-way`), the map's second-level sections as addresses, and
  the lore with its lessons. `context.skill.install` writes it to `<dir>/<name>/SKILL.md`
  for each of `skill.dirs` (default `.claude/skills`). Name and description
  are config, so the skill's "clickbait" stays the project's own. Both are
  written as JSON strings, so any description is valid YAML, and the name is
  a slug (`[a-z0-9-]`), so it cannot leave its directory. An `agent` input
  is an id for the same reason. This
  repository's `jhin-map` skill is now generated; regenerate it instead of
  editing it.
- **D669. The library is checked like code.** A unit test runs
  `context.map` on this repository and fails on any unreachable page or
  broken route, and when the committed `jhin-map` skill differs from what
  `context.skill` generates. Routes the first run found broken are fixed (`docs/map.md` named
  plans by bare file name; one `lore/` mention in this plan pointed nowhere).
- **D670. Permissions.** Reading commands, `context.skill` included, need
  `context.read`; `context.skill.install` writes files and needs
  `context.write`.

- **D671. A generation starts from the lore.** A1 landed first, so A4
  wires it: on a generation's first turn `jhin.agents` calls `lore.brief`
  (`reason: start`, the home project and the agent) and puts its Markdown in
  front of the inherited knowledge (D607). A node without `jhin.context`
  starts generations as before. The runtime starts once the brief is there
  (`deferredTurn`): an interrupt before then ends the turn at once and the
  runtime never starts, a failing brief is logged and the turn starts
  without it, and a steer before then gets a turn of its own.

D672–D680 stay reserved for A4's follow-ups (the Deferred items below).

### A5. Teams and team bundles (D681–D700)

- A **team spec** names a team's agents (role, runtime, model, skills,
  instructions), its lead, its culture (a Markdown file on how it works
  together) and its lore. It is config, so it is layered and validated by a
  Zod schema.
- `teams.up` creates the team's agents from the spec on a node or across
  nodes, and `teams.down` stops them. A team's agents get addresses like
  `builder@workshop` as aliases of their full address.
- A **team bundle** is the spec plus its files (skills, culture, lore, starter
  context), packaged as an npm package with a `"jhin"` manifest like a plugin,
  so it installs the same way.
- **Escalation**: the owner talks to the lead. Leads ask leads, and decisions
  only the owner can take reach the owner through A2.

### A6. Orchestration and refocus (D701–D720)

- An **orchestrator workflow** walks a mission's process: it knows which
  slice is next, hands it to its assignee, waits for the proof, and moves on.
  The orchestrating agent still decides. The workflow only keeps the plan out
  of its head. Built on W10's workflows, not beside them.
- **Refocus**: on a compaction, on an interval or on request, the agent gets
  the intent chain of its current work: slice spec → mission outcome →
  project intent. The question is whether what it does now serves that
  ([moonbase](../lore/doghouse-moonbase.md)). The intervals are config.

### A7. Health: ceremony against progress (D721–D740)

- Sensors over the event log: ceremony (messages, asks, approvals, proof
  edits, queue activity) against progress (slices done, commits, merged pull
  requests), per team and per mission.
- A threshold crossed raises a **health warning** (event and notification to
  the owner) and asks **an agent that has the team's context** (its lead by
  default) to analyse it. A random agent is never asked.
- client, in Civilization mode (D741): a Health view with the warnings and a drill-down into the events
  behind them.
- Recursive proof loops (proof edits after a slice is done) and repeated
  wrong ideas ([mind virus](../lore/mind-viruses.md)) are the first two
  named detectors.

### A8. Modes and the Civilization shell (D742–D760)

- A client capability for **modes** (`client.modes@1` or similar): a mode
  has an id, a title, an icon and its own sidebar and main-area slots. The
  mode is in the route (`navigation`), a keybinding and the command palette
  switch it, and each mode remembers its own last place.
- The **mode switcher** sits in the app chrome. With a single mode it is
  hidden, so a node without the agents plugins looks like today.
- **Threads mode**: today's layout moved under the mode, with no change of
  behaviour, slot ids or contribution ids (AGENTS.md rule 8). Check the
  e2e tests before and after. W14 changes the sidebar in parallel, so keep
  the move mechanical and rebase often.
- **Civilization shell**: the layout and the empty slots the other
  workstreams fill. Sidebar sections: projects run as civilizations, teams
  and agents (A1, A5), missions (A3), inbox (A2) and health (A7). Main area:
  the conversation with the lead, plus whatever the sidebar opens. Ship it
  with empty states that say which workstream fills each slot.
- The server-side filter of D741: thread lists and catalogs leave out
  threads marked as an agent's generation unless asked to include them. If
  A1 has not landed the mark yet, agree on the field with A1.

- **D742. `client.modes@1` and the route.** A mode is `{id, title,
  description?, order?, icon?, sidebarSlot, mainSlot}`, registered with
  `modes.register` (a disposable). `list` sorts by `order`, then id; the
  first is the default. The route carries the mode as `mode` (`m=` in the
  fragment); a route without one, or with a mode that is gone, is the default
  mode's. `ui-host` renders the active mode's two slots in place of
  `app.sidebar` and `app.main`; `app.panel`, `app.overlay` and `app.global`
  are the page's and stay in every mode (a thread's terminal or browser
  panel stays open beside the Lead view). Switching unmounts the other
  mode's sidebar and main area: what they store (a thread's composer draft)
  comes back, local view state such as scroll positions does not.
- **D743. Threads mode is `app.sidebar` and `app.main`.** The plugin
  `jhin.modes` registers it (`threads`, order 0) with today's slots, so every
  slot and contribution id stays as it was; without `client.modes@1` the
  layout falls back to the same slots.
- **D744. Each mode remembers its last place** for the life of the page.
  Every route change is kept as its mode's place, in kernel-scoped state; `ui.mode.switch {mode}`
  opens a mode there, on the node the page is on: a place on another node,
  or none yet, opens the mode at the node alone. Pressing the active mode
  leaves an app page for its place. A shown mode that goes away (its node
  closes, its config turns it off) sends the page to the default mode's own place, so it
  does not take the page back when it returns; a link naming a mode not
  registered yet still opens it once it is. An app page
  (D748) is never kept as a place, so switching back leaves Settings. The
  default mode writes no `m`, so links made before modes still open where
  they did.
- **D745. Generations are left out of Threads mode's lists.** The threads
  plugin keeps `generationOf` (D606) on the record and takes it on
  `threads.create`; `threads.list` and `threads.catalog` leave such threads
  out unless `includeGenerations: true`. This narrows the default answer of
  two public commands: a caller that needs every thread (a plugin, the CLI,
  an MCP client) must pass the flag, as `source-control` does for the
  worktrees in use. Old clients lose nothing they had, since only
  `agents.rotate` (D606) creates marked threads. `threads.get` and
  `projects.delete` stay unfiltered. The client's `threads-store` drops a
  thread from the catalog when an index event carries the mark.
- **D746. Switching exists only with two modes or more.** The switcher (a
  `Modes` group at the foot of the left column, the contribution
  `jhin.modes.switcher` of `jhin.mode-switcher` to the slot
  `app.sidebar.modes`), the palette's "Switch
  mode..." submenu and `ui.mode.next` (default `mod+alt+m`, outside the
  terminal) appear only then; `ui.mode.switch` is always registered. A node
  without the agents plugins looks as it did.
- **D747. Civilization mode is offered by `jhin.civilization`.** Its section
  `enabled`: `auto` (default) offers the mode once an open connection's node
  has a defined agent (`agents.catalog` lists one), asked once per opening
  (an unknown answer is asked again on the next change of the connections,
  at most three times; a missing command or `PERMISSION_DENIED` means none);
  `on` always; `off` never. The offer is the client's, not a node's: one
  node with agents offers the mode for every node. The agents plugin ships with every node, so
  having the command is not enough: a node without agents looks as before.
- **D748. Settings and connecting are the app's, in every mode.** In
  Civilization mode the `settings` and `connect` panels, and a client with
  no node, render `app.main`; the route keeps its mode, so Back returns to
  the shell.
- **D749. The Civilization sidebar is slots.** A Lead entry, then one
  section per workstream, each its own slot with an empty state naming who
  fills it: `civilization.sidebar.projects` (A3), `.inbox` (A2), `.missions`
  (A3), `.teams` (A5), `.agents` (A1), `.health` (A7); the footer is the
  slot `civilization.sidebar.footer`, where the plugin contributes Settings
  (`jhin.civilization.settings`) and the palette (`jhin.civilization.palette`).
- **D750. The Civilization main area is two slots.** Without a panel it
  shows `civilization.lead`, the conversation with the lead; with one it
  shows `civilization.views`, whose contributions render the panel they own
  (an agent page, a mission). Each says "No lead yet" or "Nothing here" until
  filled. The shell's
  components are a chunk of their own, loaded once the mode shows, as are
  the switcher's buttons once there are two modes (D440).

## Deferred

- Pods (groups inside a team).
- A registry of shared team bundles (like openrig.dev/rigs). Bundles install
  from npm or a path first.
- An epidemiology team that traces a wrong idea through files and agents and
  fixes every copy ([`lore/mind-viruses.md`](../lore/mind-viruses.md)), as a bundle once A5 lands.
- Chat integrations (Slack, Telegram) for reaching the owner. Notifications
  come first.
- Agents of runtimes without MCP.
- Skills per agent: installing or limiting a runtime's skills for one agent
  (D613).
- An `agent.directory@1` service for plugins that read agents in process;
  the `agents.*` commands serve them for now.
- Archiving or settling earlier generations automatically on rotate (D606).
- A2: asks to an agent that outlive the caller's call. An ask waits for its
  answer inside the call (D624); an agent that cannot wait asks with
  `agents.send` and gets the reply as a message.
- A2: a side turn that forks the runtime's own session (Claude Code's
  `forkSession`) instead of handing the fork its parent's turns as history
  (D625).
- A2: dismissing an inbox item without answering it (D626).
- A2: the transcript showing a message as from its sender, with a link back.
  The turn carries `origin` (D623); until a view renders it, the header line
  of the message names the sender and the trace.
- A2: a count of open inbox items on the mode switcher or the page title
  (D630 notifies once per item).
- A1: starting a generation (`agents.rotate`), defining, editing or
  removing an agent from Civilization mode's views. Defining and editing go
  through the settings page (D604); the commands do the rest.
- A1: agents of a mesh member reached through another node (`remote` in
  the route): the roster follows the client's open connections only (D617),
  as D747 does.
- A1: starting the agents feed of a node over again with backoff when its
  stream breaks; today the roster shows the error with a Retry button.
- A1: a generation's own status in the page's list of generations
  (`agents.generations` has it); the list marks the current one only.
- A3: the Projects section (`civilization.sidebar.projects`) with a
  project's intent of its own; the Missions section groups by project and a
  mission shows its project's intent (D654, D656).
- A3: missions of a mesh member (`route.remote`): the view reads the route's
  connection's node only (D654); a slice's thread on a member is read through
  the mesh (D656).
- A3: proof screenshots shown inline: a screenshot item is a link (D646 keeps
  URLs only) until proof files live on the node.
- A3: an agent's title for an assignee (`agents.catalog`); the view shows
  the agent id from the address (D645).
- A3: deleting missions and slices (D651 drops them), and what happens to
  the missions of a deleted project (they stay in the stream, unseen).
- A3: editing intent, missions and slices from the client; the view reads
  (D656), the commands edit.
- A3: which slice is ready or next (its dependencies done): A6 computes it
  from `missions.get`.
- A3: proof stored on the node (screenshot files); a proof item names a URL.
- A3: a project deleted between the project check and the append of
  `missions.create` or `missions.intent.set` (D643) still gets its record;
  closing that needs a projects capability the writer can hold.
- A3: what to do with the open dependants of a dropped slice (D651): A6
  re-plans them; `missions.get` shows them.
- A3: fencing an agent's `missions.write` to the slices that link its own
  thread (D652); agents are node-wide like the rest of D341 for now.
- A4: the lore brief after a compaction (`reason: compaction`). No runtime
  reports a compaction yet; whoever adds that event (A6's refocus) calls
  `lore.brief` there, as D671 does on start.
- A4: team lore (`lore.list { team }`), once A5 settles where a team's files
  live.
- A4: detecting conflicts between sections (two pages saying different
  things). Only the ranks to settle one exist.
- A4: a client view of the library (browse by address, the reachability
  report, the lore), in Civilization mode's slots (A8, D741).
- A4: dropping the cached library of a removed project when `jhin.threads`
  reports the removal (its project-deleted event). Today it is dropped on the
  next call with a `projectId` or when the plugin deactivates.
- A4: opening every directory of a skill's path without following links
  (`openat`-style), so a parent swapped for a symlink between the check and
  the write cannot redirect it. Today the path is checked again after
  `mkdir` and the file is opened with `O_NOFOLLOW`; only the project's own
  processes could race it.
- A4: reading the library off the event loop (`fs/promises`, or a cache
  kept by file watching). `context.map` and the lore commands read the
  library synchronously, which is quick for a docs tree of this size.
- A4: a bound on how long a generation's first turn waits for its lore
  brief (D671); `lore.brief` reads local files, so it ends.
- A4: reference-style links (`[x][ref]`) and HTML links as routes; events
  when pages change (pages are re-read when their mtime changes).
- A8: mode places that survive a page reload (D744 keeps them for the page's
  life); a mode per window or per node.
- A8: offering Civilization mode for a mesh member reached through another node
  (D747 asks only the client's open connections), and as soon as the first
  agent is defined (D747 asks again only when the connection reopens).
- A8: a Threads-mode view of an agent's generations for debugging, through
  `includeGenerations` (D745).
- A8: one footer for both modes' sidebars: Civilization contributes its own
  Settings and palette buttons (D749) beside the Threads sidebar's, which
  `sidebar` still renders itself.
- A8: asking a node for its agents again when what was missing arrives (an
  `agents` event, the agents plugin activating) rather than on the next
  change of the connections: today an unknown answer on a connection that
  stays open is asked again only when some connection changes (D747), and a
  node still activating its plugins answers `COMMAND_NOT_FOUND`, taken as
  none until it reopens.
- A8: Civilization mode per node: the route's node without agents opens the
  shell with its empty states today (D747); the views A1 and A3 contribute
  choose their node.
- A8: leaving generations out of `threads.search` as well: D745 filters the lists
  and catalogs only, so a search can still find a generation's text.

## Landing

Each workstream lists its PRs here as they merge.

- A1 #90: the contract in `@jhin/agent-api` (`agents.ts`: definitions,
  records, generations, `GenerationOf`, events, the `agents.*` schemas;
  `agent.runtime@1.3` adds `runtimeId`, `role` and `TurnRequest.instructions`).
  D602–D614 recorded.
- A1 #93: the `jhin.agents` plugin (D602–D613); `generationOf` on threads and
  `threads.create` (D606); `agents.list` grows `kind`, `runtimeId`, `role`,
  and turns record `runtimeId` (D610). The Civilization-mode UI (D614) waits
  for A8's shell.
- A1 #175: Civilization mode's agents, `jhin.agents-view`: the roster by
  home project and an agent's page with its generations read through
  `thread.transcript` (landed with #174; its chat component and the agents
  store now load with their chunks, D440), stop and resume, and
  `civilization.agent.open` (D614–D617).
- A2 #172: the messaging contract in `@jhin/agent-api` (`messages.ts`:
  owner and thread addresses, `AgentMessage`, `MessageOrigin`, the
  `agents/messages` and `agents/inbox` streams, the schemas of `agents.send`,
  `agents.ask` and `agents.inbox.*`). D621–D629 recorded; the server side and
  the inbox follow.
- A2 #177: `agents.send`, `agents.ask` (side turns for earlier
  generations), `agents.inbox.list` and `agents.inbox.answer` in
  `jhin.agents`, across nodes through `mesh.call`; `origin` on queued
  messages and `agent.turn.started`, and forks of generations keep
  `generationOf` (`jhin.threads`); `agents.read` and `agents.message` for
  agents over MCP (D621–D629).
- A2 #179: `jhin.inbox`, the owner's inbox in Civilization mode: open items
  of every node in `civilization.sidebar.inbox`, an item's page with the
  answer box in `civilization.views`, a toast or system notification per new
  item, `civilization.inbox.open` (D630).
- A3 #104: `@jhin/missions-api` (records, the `missions` stream's events and
  fold, intent chain, Markdown) and the `jhin.missions` plugin: `missions.*`
  and `slices.*` commands, the stream guarded by `missions.read`, agents
  reaching it (D641–D652). The mission view in Civilization mode waits for
  A8's slots (#105).
- A3 #174: the mission view in Civilization mode, `jhin.missions-view`: the
  Missions section and mission → slice → thread, read only, on the
  `missions` stream (D653–D656); with A1's `thread.transcript` seam (D614).
- A4 #91: `jhin.context` (D661–D670), and the lore brief on a generation's
  start in `jhin.agents` (D671).
- A8 #105: `client.modes@1` and the `jhin.modes`, `jhin.mode-switcher` and
  `jhin.civilization` client plugins: Threads mode on today's slots, the
  Civilization shell with empty slots for A1, A2, A3, A5 and A7, and
  `includeGenerations` on `threads.list` and `threads.catalog` (D742–D750).
