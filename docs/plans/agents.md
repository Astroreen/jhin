# Agents plan: teams of persistent agents

Status: **in progress** (A1–A8 and phase 2, C1–C3, landed; phase 3, L1–L3, running). This file records how Jhin grows from "one thread,
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

A1–A8 landed by 2026-10-22 (see [Landing](#landing)). They left
Civilization mode mostly read-only: it shows agents, teams, missions, the
inbox and health, but the owner cannot yet run a civilization from it.
[Phase 2](#phase-2-a-civilization-the-owner-can-run) closes that gap:

| Id  | Workstream                         | Stacks on | Decisions   |
| --- | ---------------------------------- | --------- | ----------- |
| C1  | The owner's console                | `main`    | D1061–D1080 |
| C2  | Missions from the client           | `main`    | D1081–D1100 |
| C3  | Dogfood: a civilization end to end | `main`    | D1101–D1120 |

C1, C2 and C3 start together. C3 drives the scenario through commands first
and through C1's and C2's UI as it lands.

Phase 2 landed by 2026-10-23. Its real run ([C3 run](#c3-run)) closed a
mission in minutes, but showed that a team cannot yet be left alone: the
owner heard nothing back, a public id was dropped without asking, and a
change was committed without a review after it.
[Phase 3](#phase-3-trusting-a-long-run) makes a long unattended run safe:

| Id  | Workstream                    | Stacks on | Decisions   |
| --- | ----------------------------- | --------- | ----------- |
| L1  | The lead reports to the owner | `main`    | D1221–D1240 |
| L2  | Guards in the process         | `main`    | D1241–D1260 |
| L3  | A long run                    | L1, L2    | D1261–D1280 |

L1 and L2 start together; L3 starts once both have landed.

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
- **D1272. The page's list of generations shows each one's status.** The page
  reads `agents.generations` when it opens and again whenever its agent's
  record or the turns of its generations' threads change (the `agents` and
  `threads` feeds the store already follows; no polling), and each row shows
  its own status (the roster's dot and `STATUS_LABELS`) beside the mark of the
  current one. While the next answer is read the last one stands; when the call
  fails the list shows as before, without statuses, and says they are
  unavailable.

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
  Changed with A7 (#190, D731), since the inbox follows its nodes through the
  feed it shares with health (`lib/node-feeds.ts`):
  - A dropped inbox stream is read again, at once and then at most once a
    minute. The re-read tells up to the three newest items that came
    meanwhile.
  - A feed that stays failed keeps its items, marked not live, where the
    inbox used to empty itself.
  - With no focus and no system notification sent, a toast is left on the
    page (unless `inApp` is off), where before nothing was told. This is
    deliberate: an ask nobody is told about is the inbox failing silently,
    and the item stays in the sidebar either way. The toast may be stale
    when the owner returns (the item answered meanwhile); that is accepted.

- **D1274. The owner dismisses an inbox item without answering it.**
  `agents.inbox.dismiss {messageId}` (permission `agents.inbox`, serialized
  with `agents.inbox.answer`) closes an open item: the `agents/inbox` stream
  gets `agents.inbox.dismissed`, and `InboxItem.status` and the
  conversation's `inbox` gain `dismissed` (additive; `agents.inbox.list`
  takes `status: "dismissed"`). Dismissing an ask sends its asker an
  `answer` message from the owner, inReplyTo the ask, saying it was
  dismissed, so a waiting agent wakes (a lead's escalation stops holding its
  mission, D1223); dismissing a plain message tells nobody. An item that is
  not open is refused with `ITEM_CLOSED` (answering a dismissed item too).
  The inbox page has a Dismiss button beside Send answer; the Lead view
  shows the item as "Dismissed". The input is `messageId`, like answer's.

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

Decisions are recorded here as they are taken. The contract (the spec, the
roster, aliases, `teams.bundles@1` and the schemas of the `teams.*`
commands) is `packages/agent-api/src/teams.ts`.

- **D681. A team spec** is `{title?, description?, lead, culture?, project?,
  dir?, agents: {<member>: TeamMember}}` (`TeamSpec`). A member is an A1
  definition (role, runtime, model, modes, instructions, skills, home
  project) plus `node`, the node its agent runs on (the node running
  `teams.up` when unset). `lead` names one of the members; `project` is the
  home project of members that name none. Team ids and member names are
  slugs of at most 30 characters (`TeamId`, `MemberId`).
- **D682. Specs are layered config.** The section `jhin.teams` holds
  `{teams: {<id>: TeamSpecLayer}}` on the node or project layer, any part of
  a spec, so the settings page edits it with no new UI. A bundle's spec
  (D686) is the layer below the node's: the layers merge key by key as
  config layers do (arrays replaced), and the merge is validated as a
  `TeamSpec`. A team whose merge is invalid is listed with its `error` and
  cannot go up (`TEAM_INVALID`).
- **D683. A member is a defined agent `<team>-<member>`** on its node
  (`workshop-builder`), an A1 agent like any other: its generations,
  knowledge, stop and messages are A1's and A2's. Its id is taken only by
  the team that put it there (the node keeps which team it is): any other
  definition of that id is `AGENT_EXISTS`.
- **D684. What a member is told.** `teams.up` writes each member's
  definition with `instructions` made of the team's part (the team, its
  role in it, the lead's and teammates' aliases and addresses, how to
  escalate, D688), the culture, and the member's own instructions. The
  culture is the spec's `culture`, else `culture.md` of the team's files.
  The definition is A1 config, so the owner sees what the agent is told.
- **D685. `teams.up` and `teams.join`.** `teams.up {teamId}` on the node with
  the spec computes the roster (each member's address on its node), then
  puts each member on its node with `teams.join` (`mesh.call` for another
  node): `join` defines the agent or updates it to the spec (A1's
  `agents.define`/`agents.update`, `unset` for what the spec dropped),
  resumes it when it was stopped, keeps the roster, and writes the team's
  files into the agent's knowledge folder: `agents/<member>/*.md` as starter
  knowledge, `lore/*.md` into its `lore/` (A4 D666 reads the agent's own
  lore, so the lore brief has the team's). Only files missing there are
  written: what the agent learnt is never overwritten. `up` is idempotent;
  a member that fails is reported with its error, and the others go on.
- **D686. A team bundle is a plugin.** An npm package with a `"jhin"`
  manifest (`side: server`, `requires: {"teams.bundles": "^1"}`) whose entry
  registers its own folder with the `teams.bundles@1` service of
  `jhin.teams` (`register(root, pluginId)`, a disposable). The folder holds
  `team.json` (`TeamBundleSpec`: the team's `id` and its spec), `culture.md`,
  `lore/` and `agents/<member>/`. It installs where plugins install (a
  plugin location such as `~/.jhin/plugins/<id>/` or `.jhin/plugins/`, or a
  dependency of the distribution) and the node finds it as it finds plugins
  (D14, D15): no second install path. Removing it takes the team off
  `teams.list`; agents that are up stay, as A1 D611 keeps a removed
  agent's work.
- **D687. Aliases.** `<member>@<team>` (`builder@workshop`) is an alias of
  the member's full address. Every node a team's member was put on keeps its
  roster, and so does the node that ran `up`: `teams.resolve {alias}` reads
  it there (`TEAM_NOT_UP` when the node has none). `agents.send` and
  `agents.ask` take an alias in `to` and resolve it through `teams.resolve`
  when the node has it; the message carries the full address.
- **D688. Escalation goes through the lead.** The lead is told that the
  owner talks to it, that it asks other teams' leads (`teams_list` names
  them, `agents_ask` reaches them), and that a decision only the owner can
  take goes to the owner with `agents_ask` to `jhin://<node>/owner`, which
  lands in A2's inbox (D626). Members are told to ask their teammates and
  their lead, not the owner. The owner reaches the lead with `agents.send`
  or its alias. This is told, not fenced (see [Deferred](#deferred)).
- **D689. `teams.down` stops a team through its agents** (D612): `agents.stop`
  on each member's node, through `mesh.call` for another node. The roster
  and the definitions stay; `teams.up` resumes them. The `teams` stream
  records `teams.team.changed` (a spec appeared, changed or went),
  `teams.team.up` (the roster) and `teams.team.down`; `teams.list` returns
  its head, as `agents.catalog` does.
- **D690. Permissions.** `teams.list`, `teams.get`, `teams.resolve` and the
  `teams` stream need `teams.read`; `teams.up`, `teams.down` and
  `teams.join` need `teams.write` and `agents.write`, since they define and
  stop agents. Agents get `teams.read` through their
  node's MCP server (`AGENT_PERMISSIONS`), so a lead finds other leads; never
  `teams.write`. A member on another node is put there with the caller's
  grants (D416), so a member node without `teams.write` refuses.

- **D691. Teams in Civilization mode** are the client plugin
  `jhin.teams-view`, a chunk of its own (D440). `jhin.teams.sidebar` fills
  `civilization.sidebar.teams` with the teams of the route's node (title,
  agent count, up or stopped), from `teams.list`, listed again on each event
  of the `teams` stream. A team's page is the route panel `team` with the
  team id as `section`, in `civilization.views` (`jhin.teams.view`): its
  agents (alias, role, runtime and model, node, the lead marked) with their
  status from `teams.get`, its culture, **Start team** (`teams.up`) or
  **Stop team** (`teams.down`), and a message to the lead (`agents.send` to
  its alias, D688). `civilization.team.open {node, teamId}` opens it.
  Nothing of it goes into Threads mode (D741).

### A6. Orchestration and refocus (D701–D720)

- An **orchestrator workflow** walks a mission's process: it knows which
  slice is next, hands it to its assignee, waits for the proof, and moves on.
  The orchestrating agent still decides. The workflow only keeps the plan out
  of its head. Built on W10's workflows, not beside them.
- **Refocus**: on a compaction, on an interval or on request, the agent gets
  the intent chain of its current work: slice spec → mission outcome →
  project intent. The question is whether what it does now serves that
  ([moonbase](../lore/doghouse-moonbase.md)). The intervals are config.

Decisions:

- **D701. One plugin, `jhin.orchestrator`** (`plugins/orchestrator`, server
  side). It requires `host.identity@^1`, `storage.kv@^1` and
  `storage.eventlog@^1`, folds the `missions` stream as any client does
  (D641) and reaches missions, agents, threads, workflows and lore only
  through their commands. It adds no second runner: the orchestrator is a W10
  workflow (D705–D707), and refocus is a message in the agent's own thread
  (D710).
- **D702. Readiness is a function of the mission** (`missionProgress` in
  `@jhin/missions-api`; `missions.next { missionId }`). Waves run one after
  another: only the earliest wave with open slices moves. Its planned slices
  are **ready** once they have an assignee on this node; its active ones are
  **working**; the rest wait for a **decision** of whoever runs the mission:
  `unassigned`, `blocked` (the assignee said it cannot go on), `elsewhere`
  (an assignee of another node), and, in any wave, `orphaned` (a dependency
  was dropped, D651: the lead re-plans it). `missions.next` adds the stream's
  `head`, the mission's own steps and the project's. `slicesDone` means no
  slice is open; it never sets the mission done.
- **D703. `slices.handoff { sliceId }` hands a ready slice to its
  assignee** with A2's `agents.send` (D623), as the caller: an agent of this
  node gets it in its current generation (its first is started when it has
  none), queued while it works, and that thread is linked to the slice; the
  owner gets it in the inbox (D626). Either way the slice becomes `active`
  at its slice process's first step. The message is the slice, what it
  serves (mission outcome, project intent), its process, and how to close
  it: `slices_update` for each step, `slices_prove` once with the smallest
  proof, `blocked` when stuck. Its message id is the slice as it was
  planned, so a retry after a node stopped delivers it once. Handing an
  active slice again changes nothing (`handed: false`); a slice that is not
  ready is `SLICE_NOT_READY` (with the decision it waits for) or
  `AGENT_ELSEWHERE`. It takes `missions.write` and `agents.message`, which
  a thread's agent holds, and every write runs as the caller (so `by` and
  the message's sender name it).
- **D704. `missions.wait { missionId, after, timeoutMs? }`** returns when
  the mission or one of its slices changes after the stream's sequence
  `after` (`changed: true`), or after `timeoutMs` (default 10 minutes, at
  most 60). It reads what came before the call first, so nothing between
  `missions.next` and the wait is missed. Nothing polls: the wait is an
  event of the stream.
- **D705. W10's scripts get `command(name, input)`**, Jhin's addition like
  `agentId` (orchestration.md D373): it runs a command of the node as
  whoever started the run (its grants, trace and thread) and returns its
  output, or throws with the command's `code` and message. A stop ends the
  wait at once. A script already runs with the node's rights (D375), so this
  adds none; resuming a run (D872) runs its commands again.
- **D706. `missions.orchestrate { missionId, parentThreadId? }`** runs the
  orchestrator workflow (`ORCHESTRATOR_WORKFLOW`, named `mission`) through
  `workflows.run` from the calling thread, the lead's: the workflow shows in
  its chat (W20) and its end wakes it (D376). A thread is required
  (`THREAD_REQUIRED`), the mission must be open (`MISSION_CLOSED`), and a
  mission already being orchestrated returns its running workflow
  (`existing: true`). The script is this plugin's own and its only argument
  a mission id, so the caller does not need `workflows.run` itself: the
  plugin adds that one grant to the caller's for this run, and the script's
  `command()` calls run with the caller's own grants. W10's other rules hold
  (a full-access thread, no mesh caller).
- **D707. What the orchestrator does, and where it stops.** Per wave: it
  hands every ready slice (`slices.handoff`), then waits for the mission to
  move (`missions.wait`) and looks again. It decides nothing: it ends, and
  wakes the lead, with an `outcome` for each decision the lead must take:
  `decide` (the decisions of D702 and handoffs that failed), `wave-done` (a
  wave it watched is over and the mission has steps between waves, such as
  merge: the lead runs them, then orchestrates again), `slices-done` (the
  mission's and the project's steps; the lead sets the mission done when its
  outcome holds, D651) or `closed`. Its state is the mission, so running it
  again goes on from there; a run the node stopped fails (D376) and is
  started again the same way.
- **D708. `refocus.brief { sliceId } | { threadId, nodeId? }`** renders
  the intent chain (`intentChain`, D650: slice spec → mission outcome →
  project intent) with the moonbase question: does what you are doing now
  serve it? For a thread it takes the open slice changed last.
  `refocus.send { threadId, reason? }` hands a thread of this node that
  brief: steered into its running turn when its agent steers (W1), else as
  its next queued message, so a refocus never stops a turn.
- **D709. Runtimes report a compaction.** `agent.runtime@1.6` adds the item
  `context.compacted { trigger? }` (`auto` or `manual`); the threads plugin
  (`agent.registry` 1.3) records it as `agent.context.compacted { turnId,
  trigger? }` in the thread's stream. Claude Code's `compact_boundary`
  message, Codex's completed `contextCompaction` item and the fake agent's
  `/compact` emit it.
- **D710. Refocus comes by itself.** The plugin follows the streams of this
  node's threads linked to open slices. After an `agent.context.compacted`
  it sends the brief (D708) with the lore brief for a compaction
  (`lore.brief`, reason `compaction`, D671): the item A4 left to whoever
  reports compactions. Every `refocusEveryTurns` turns of such a thread it
  sends the brief again. Turns are counted per thread in `storage.kv`, and a
  compaction starts the count over.
- **D711. Config `jhin.orchestrator`:** `refocusOnCompaction` (default on)
  and `refocusEveryTurns` (default 10, 0 off). The interval is counted in
  turns, not minutes, so an idle agent is never woken to be refocused.
- **D712. No UI of its own yet.** The orchestrator is a workflow, which
  W20 already shows in the lead's chat (phases per wave, its log of
  handoffs, its result); its Civilization-mode view waits (Deferred).
- **D1271. The chat shows a compaction as a quiet row.** `createTimeline`
  turns `agent.context.compacted` into a `compaction` item of its turn, in
  the order of the stream, and the chat renders it as a separator reading
  "Context compacted", with "automatic" or "manual" when the event names its
  trigger (D709). It stays visible when a finished turn folds its work, as a
  steered message does.

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

Decisions are recorded here as they are taken. The contract (the `health`
stream, warnings, ideas, groups, config) is `packages/health-api`; the
sensors and detectors are `plugins/health/src/sensors.ts`.

- **D721. One `health` stream per node, folded.** Sensors read the log the
  other plugins already write; nothing is counted twice into a second store.
  What health concludes is an event of the node's `health` stream
  (`health.warning.raised`, `.analysed`, `.dismissed`,
  `health.idea.corrected`, `health.progress.recorded`), and the state is its
  fold (`applyHealthEvent`), on the node and in clients alike, as D641 does
  for missions. `health.catalog` returns the head to follow it from;
  following it takes `health.read`. The counts themselves are not stored: on
  start the plugin reads the streams again and keeps the window in memory.
- **D722. Ceremony and progress are read from the streams that hold them.**
  Ceremony: a message, ask or answer delivered (`agents/messages`, D627), a
  proof recorded again on a done slice (`missions`, D642/D646), and, on the
  threads slices link (D647), an approval asked (`agent.request.opened` of
  kind `approval`) and a queue change (`threads.queue.updated`). Progress: a
  slice becoming done (`missions`), a linked thread's pull request merging
  (`git.pr.linked`/`git.pr.updated` with state `merged` on `source-control`,
  once per thread and pull request) and turns that commit (D723). An event counts for
  the missions of the slices whose thread it is on; a message without one
  counts for one slice: the open slice of its recipient, else of its sender,
  changed last (one message is not multiplied over an agent's missions);
  every event counts for the node. A slice becoming done again after it was reopened counts again: the
  rework is progress, while a proof recorded again on a done slice is a
  proof edit, ceremony. A project counts what its missions count.
  Attribution is the missions as they were when the event happened: on start
  the streams are replayed merged in time order, so a restart counts as the
  live node did. A thread no slice links any more is no longer followed;
  linked again, it is read on from where it was left, so nothing is counted
  twice. `health.status` returns the counts per group and per kind
  over the window. Health's own asks to an analyst (message id
  `health.<warningId>.<time>` (the ask's time in ms), naming a warning health raised before) are
  no ceremony: an ask from this node's owner, whom no agent can send as
  (D622), whose id names a warning health raised before. An agent that
  copies such an id is counted like any other. The analyst's first reply to
  an ask health delivered (`inReplyTo` its message, from the warning's
  analyst) is health's conversation too: no ceremony, and no carrier of the idea it was asked to trace. The
  analyst's answer ends its turn (D624) and is not a delivered message.
- **D723. Commits are the one progress no stream holds.** Every turn records
  its `HEAD` before it starts (turn-start hook,
  kernel-scoped state, so a plugin reload keeps it; a start older than a day
  is forgotten), since its thread may be linked to a slice during the turn;
  at its end, on a thread a slice links by then, it appends
  `health.progress.recorded` with the
  commits since on the first-parent line (`git rev-list --count
  --first-parent`), only when the start is an ancestor of the new `HEAD`: a
  reset, rebase or branch switch inside the turn is no progress of its own.
  A turn that commits counts as one piece of progress, however many commits
  it made (the count is kept on the record): a large rebase or import is not
  more progress, and empty commits buy no room under the ceremony threshold.
  Health runs `git` itself: `source-control.git@1` offers no read of `HEAD`
  or count of commits to depend on, and its `TurnCheckpoint` records what the
  turn changed in the working tree (files, insertions, deletions), not the
  commits it made. The hooks never fail a turn: the start reads `HEAD` once (2 s at most),
  the end counts off the turn's path and then emits the kernel event
  `health.commits.counted { turnId, count }`; a directory without git counts
  nothing.
- **D724. A warning per detector and subject; the narrowest group warns.**
  A detector raises a warning (`health.warning.raised` on the stream and the
  same kernel event, for server plugins that tell the owner elsewhere, such
  as a chat integration). The owner is told by the client, which follows the
  stream: `jhin.health` in the web client toasts or notifies each new warning
  the way the inbox tells an ask (D630, D731). A warning is raised once
  for its subject (a group, a slice, an idea) while that warning is open.
  The owner dismisses it (`health.warnings.dismiss`); a dismissal starts the
  count of its subject again, so it warns again only when what came after the
  dismissal alone crosses the threshold. The dismissal records the log's head
  of each followed stream (`dismissedAfter`), also of events not delivered to
  health yet, and the count goes on
  from the events after them: an exact cut, where the clock's milliseconds
  would not order a dismissal against events of the same millisecond. A
  stream it did not follow yet (a slice's thread linked later) counts from the
  dismissal's time. Every detector counts over the
  window (`windowHours`). Of ceremony warnings the narrowest group crossing
  warns: while a mission crosses over the window, dismissed or not, its
  project and the node stay quiet, so one cause makes one warning; once it no
  longer crosses, they count again. A warning keeps the
  last 50 events behind it (`EventRef`: stream, sequence, type, time, kind);
  `health.warnings.get` reads them back from the log for the drill-down, a
  trimmed one marked `missing`.
- **D725. The analyst is asked with `agents.ask`.** On a new warning health
  asks its analyst (D726) through `agents.ask` (A2, D624) as this node's
  owner, with the warning, its measures, its last events and what to look at
  (the lore of bureaucracy or of mind viruses), and records the answer
  (`health.warning.analysed`, the answer cut at 8000 characters: `answered`; `failed` with the error, when the ask is not answered (an ask
  that only waits, `pending`), or after
  `analysisTimeoutMinutes`, or `none` when no agent has the context). An ask
  past its timeout is not cancelled (commands have no abort); its late answer
  is dropped. An ask cut short by a deactivation records nothing. On activation an open
  warning without an analysis, or analysed by nobody (`none`), is asked again
  (also when the `jhin.health` config changes, so an analyst named later or
  health turned on is asked; an ask under way is asked once, and looked at
  again when it ends), unless its ask had already
  been delivered (`agents/messages`): then its analysis is recorded `failed`,
  pointing to the analyst's thread, so no analyst is asked twice. Asks wait
  for `agents.ask` to be registered (or for `kernel.started`), so a node
  starting, or health enabled on a running node, asks once the agents plugin
  can take it. The core streams
  (`health`, `missions`, `agents/messages`, `source-control`) must be read on
  activation, or it fails; a slice's thread that cannot be read is tried again
  on the next change of the slices' threads. Agents hold `health.read` over MCP
  (`AGENT_PERMISSIONS`), so the analyst can open the drill-down itself.
- **D726. Who has the context.** In order: the agent address configured for
  the project in `jhin.health.analysts` (or for `*`; an address that is no
  agent's, such as the owner's, is skipped with a warning in the log); else
  the lead of the team (A5, `teams.list`) holding most of the group's slices
  that are not dropped, by their assignees; else the agent assigned the most
  of them, a tie going to the first address in order. A node-wide warning
  without a configured analyst has none. Never a random agent.
- **D727. A mind virus is a corrected idea coming back.** The owner names a
  wrong idea by a phrase when correcting it (`health.ideas.correct { idea,
  correction?, projectId? }`), the vaccine; the project must exist, the same
  phrase for the same project is the same idea, and one named by mistake is
  withdrawn (`health.ideas.withdraw`). Each later message of a sender
  other than an owner, and each slice title or spec an agent writes later
  (not the owner or the owner's devices, `client:<id>`), that
  contains the phrase as whole words (case-insensitive, punctuation and
  whitespace collapsed; a phrase of two words at least) is an
  occurrence; a project's idea counts only in its own slices and their
  messages. `mindVirus.minOccurrences` occurrences within the window raise a warning naming
  the carriers; the analyst is asked to trace the written source and every
  copy ([mind virus](../lore/mind-viruses.md)). The agent health asked to
  trace an idea is no carrier of it: quoting the phrase is that work. Copies written before the
  correction are the analyst's to find, not the detector's.
- **D728. A recursive proof loop is proof edits on a done slice.** Every
  `missions.slice.proved` of a slice already done is a proof edit (D646 keeps
  them visible); `proofLoop.maxEdits` of them on one slice within the window
  raise a warning
  for its mission, with those edits as evidence
  ([bureaucracy](../lore/bureaucracy.md)).
- **D729. Thresholds are config.** The `jhin.health` section: `enabled`,
  `windowHours` (24), `ceremony.ratio` (10) and `ceremony.minCeremony` (30):
  a group warns when its ceremony in the window reaches both the minimum and
  ratio × progress (no progress counts as 1); `proofLoop.maxEdits` (2),
  `mindVirus.minOccurrences` (2), `analysisTimeoutMinutes` (30, a day at most) and
  `analysts`. A shorter window forgets what falls out of it; a longer one
  counts from what was kept, so it fills as new events come. An invalid layer keeps the
  last good thresholds.
- **D730. Permissions.** `health.read` reads status, warnings, ideas and the
  stream; `health.write` dismisses warnings and names corrected ideas, the
  owner's. Agents get `health.read` only. `health.read` is no way around the
  permissions of the streams behind a warning: `health.warnings.get` returns
  an event's record only to a caller who holds what its stream's own guard
  asks (`rpc.streams` `guardOf`, e.g. `agents.read`, `missions.read`,
  `threads.read`; `events.read` for an unguarded stream), and names what it
  lacks (`withheld`) otherwise. The analyst's answer is health's own record and is
  read with `health.read`: the analyst writes it for whoever watches health,
  agents included, as an agent writes any message. So are a warning's
  summary and group (a mission's title, an idea's phrase and its carriers'
  addresses): what health concludes is health's to read.
- **D731. Health in Civilization mode is the client plugin `jhin.health`.**
  It follows `health.catalog` and the `health` stream of every open
  connection (the same per-node feed as the inbox, `lib/node-feeds.ts`), so a
  new warning is told in any mode the way an ask is (`lib/tell-owner.tsx`: a
  toast with focus, else a system notification, as `jhin.notifications`
  allows, else a toast left on the page); both open it. The open warnings of every node, newest first, and
  an entry to the overview fill `civilization.sidebar.health`
  (`jhin.health.list`). The route panel `health` renders in
  `civilization.views` (`jhin.health.page`): without a `section` the overview
  of ceremony and progress per group (`health.status`), with a warning id as
  `section` the warning: what crossed which threshold, its measures, the
  analyst's answer, Dismiss, and the events behind it
  (`health.warnings.get`), each opening to its stream, sequence and record.
  `civilization.health.open {node, warningId?}` opens it. The views are a
  chunk of their own, loaded once Civilization mode shows them (D440). The
  inbox shares the feed, so it changed with it. A dropped stream is read
  again and tells what came meanwhile, at most once a minute: a drop or a
  failed read within that minute marks the feed not live, keeping its items
  where the inbox used to empty itself, and it is read again once the minute
  is over. A first load that fails (a node busy at start) is tried again the
  same way, telling nothing of it as new. A re-read tells at most the three
  newest of what came meanwhile; the rest is in the sidebar. A permission taken back, or a node
  without the feed (a node read before that restarted on a build without
  it included), is not retried; a read feed keeps its items, not live. Nor
  is a feed that failed ten times in a row with no read between (an error
  that will not pass, such as an answer failing its schema): it is given up
  until its connection is replaced.

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
  fills it (now: saying that no plugin does, D1107):
  `civilization.sidebar.projects` (A3), `.inbox` (A2), `.missions`
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
- **D1276. `threads.search` leaves generations out too.** It takes the same
  optional `includeGenerations` as `threads.list` and `threads.catalog`
  (default false) and, unless it is true, skips threads with `generationOf`,
  the predicate of D745. The input is additive and the output unchanged. The
  web client's thread search (Threads mode) keeps the default; nothing else
  calls the command.

## Phase 2: a Civilization the owner can run

The goal of phase 2: the owner opens Civilization mode on an empty project,
sets an intent, brings up a team, gives it a mission and from then on only
talks to the lead and answers the inbox, while the team works the mission
slice by slice. Everything below is Civilization mode only (D741), lazily
loaded (the entry chunk budget of D440), and built from the commands A1–A8
landed.

### C1. The owner's console (D1061–D1080)

- **The conversation with the lead** in `civilization.lead` (A5 left it
  deferred): the owner writes to the team's lead, sees its answers, and sees
  what the lead escalates. It is the owner's way into a running team, so it
  is the one place in Civilization mode with a composer. It goes through
  `agents.send` and `agents.ask` (A2), not through the lead's thread
  composer: the owner talks to the agent, not to one of its generations.
- **Defining agents and teams from the client**: create and edit an agent
  definition (title, role, runtime, model, skills, instructions), start a new
  generation, and bring a team up or down from a spec or an installed
  bundle. The commands exist (`agents.define`, `agents.update`,
  `agents.rotate`, `teams.up`, `teams.down`); the client has no UI for them.
  A command that turns out to be missing is added first, so the CLI and MCP
  get it too.
- Takes from Deferred: "A1: starting a generation (`agents.rotate`),
  defining, editing …" and "A5: the conversation with the lead in
  `civilization.lead`".

Decisions (C1):

- **D1061. `agents.conversation` reads the owner's conversation with an
  agent.** `agents.conversation {with, limit?}` (an address or an alias such
  as `lead@workshop`) returns the messages between this node's owner and
  `with`, oldest first, the newest `limit` (200 by default), and the head of
  `agents/messages` they reflect, so a client lists it again on the stream's
  next event. It is folded from what the node already records (D627): the
  owner's messages and asks as delivered on the agent's node, the agent's
  messages and asks to the owner as delivered here, each of those with its
  inbox item's state (`inbox: open | answered`, D626). An ask carries its
  answer: `agents.message.answered` now records the answer's text (`answer`,
  additive; older events have none), the answering turn's (D624) or the
  owner's (D626). It needs `agents.inbox` and `agents.read`: it shows the
  owner's inbox, so agents never read it (D628). Only this node's records
  count: with the agent on another node, the owner's messages to it are
  recorded there and missing here ([Deferred](#deferred)).
- **D1062. The Lead view** is the contribution `jhin.teams.lead` of
  `jhin.teams-view` to `civilization.lead`, a chunk of its own (D440): the
  lead is a team's (D681), so the teams plugin owns talking to it. It talks
  to the route's team: the route has no panel and names the team as
  `section` (`#m=civilization&s=workshop`), and a named team that is gone
  or invalid is "No such team", never another lead; without one, the first
  team that is up, else the first. With several teams a picker (`Team`) switches
  between them; `civilization.lead.open {node, teamId?}` opens it. The
  conversation is `agents.conversation` with the lead's alias, read again on
  each event of `agents/messages` after its head (D1061); a read that a
  newer one overtook is dropped, failure included, and a feed that failed
  shows Retry. A team that is not
  up shows **Start team** (`teams.up`) and a closed composer; a node without
  teams says "No team yet" where the shell said "No lead yet".
- **D1063. The owner asks the lead.** The composer (`Message to the lead`,
  Enter sends, Shift+Enter breaks the line) calls `agents.ask` with the
  lead's alias: the answer is the last message of the lead's turn (D624),
  recorded with the ask (D1061), so it arrives even when the page was closed
  meanwhile. The page names the ask (`messageId`), so it says the lead is
  working on an answer only for the asks it still waits on; any other ask
  without an answer (a silent turn, a stopped team, an ask before a reload)
  says "No answer from the lead". A silent turn is a toast; an ask that did
  not reach the lead is a toast and gives its text back to an empty
  composer. What the lead
  sends the owner shows as the lead's text; what it asks the owner (an
  escalation, D688) is a card with its inbox state and **Answer**, which
  opens the item in the inbox (`civilization.inbox.open`): answering stays
  the inbox's (D630), in one place.
- **D1064. The Lead view is the one composer of Civilization mode.** The
  team page's message to the lead (D691) gives way to **Talk to the lead**,
  which opens the Lead view on that team.
- **D1065. Defining and editing an agent** is a form in `civilization.views`
  (`jhin.agents.form`) on the route panel `agent-definition`, the agent's id
  as `section` to edit it, none for a new one; `civilization.agent.define
  {node, agentId?}` opens it, and the roster ends with **New agent** (for the
  route's node, else the first with agents); a new agent's page opens once
  the roster has it. It holds the id (new only),
  title, role, runtime (the node's runtimes from `agents.list`, its default
  chosen first; a list that fails says so), model (the runtime's, or its
  default; kept across a change of runtime only when the new one offers it), home project (a
  project of the node, or the scratch project), skills and instructions. A
  new agent is `agents.define` on the node layer; an edit is `agents.update`
  with only the changed fields, an emptied one in `unset`, so D604 writes it
  where the agent is defined. Runtime and interaction modes stay in Settings.
- **D1066. An agent's page starts a generation and removes the agent.**
  **New generation** is `agents.rotate` with the reason `started by the
  owner` (refused while stopped, D612, so the button is off); **Remove** asks
  first and is `agents.remove`, which keeps the generations and knowledge
  (D611). **Edit** opens D1065's form.
- **D1067. Teams come up and down where they are shown.** A team from a
  spec and one from an installed bundle are both in `teams.list` (D686), so
  the team page's Start and Stop (D691) and the Lead view's Start team
  (D1062) bring either up or down: no command was missing. Writing a team
  spec from the client is left ([Deferred](#deferred)).

### C2. Missions from the client (D1081–D1100)

- **Editing the intent chain**: the project intent, missions (outcome,
  process per level) and slices (spec, assignee, dependencies) from the
  mission view, through the existing `missions.*` and `slices.*` commands.
  The view keeps reading the stream; editing goes through commands only.
- **The orchestrator beside the mission view** (A6 left it deferred, D712):
  which slice is next, who has it, what the run waits for, and start, pause
  or stop the orchestrator run of a mission.
- Takes from Deferred: "A3: editing intent, missions and slices from the
  client", "A3: an agent's title for an assignee" and "A6: the orchestrator
  in Civilization mode".

Decisions (C2):

- **D1081. The owner plans from the mission view, through the commands.**
  `jhin.missions-view` adds New mission to the Missions section (any project
  of the node's threads catalog; the shown mission's project first), Edit
  intent, Edit mission and Add slice on a mission, and Edit slice on a slice.
  Each is a dialog that calls `missions.create`, `missions.update`,
  `missions.intent.set`, `slices.create` or `slices.update` on the view's
  node and closes; what the view shows still comes from the stream (D655),
  so nothing is written to the fold by hand and an edit made elsewhere shows
  the same way. Creating a mission opens it. A done or dropped mission takes no new
  slice (`MISSION_CLOSED`, D651), so it has no Add slice; its slices still
  edit, as the commands allow.
- **D1082. An assignee is shown by its agent's title.** The view reads
  `host.identity` and `agents.catalog` of its node once per view: an address
  the node lists shows its agent's title, the node's owner shows as Owner,
  and any other address (an agent of another node, one not defined yet) its
  id, as before (D645). The assignee picker offers Unassigned, Owner and the
  node's agents, and keeps an assignee it does not list.
- **D1083. A dialog sends only what changed, and the command decides.**
  `missions.intent.set`, `missions.update` and `slices.update` get the
  fields the owner changed (`null` clears an assignee or a step), so an
  untouched process is never checked again, and a dialog saved unchanged
  calls nothing (`changes.ts`). The client checks nothing the command checks: a refusal
  (`SLICE_ORDER_INVALID`, `SLICE_STEP_INVALID`, `PROOF_REQUIRED`, …) stays in
  the dialog as an alert with the command's message, and the dialog stays
  open.
- **D1084. A process is edited as one line of step ids** (`spec → build →
  test`; arrows, commas and spaces separate), for the project between
  missions, a mission's slices and the mission between waves. A step keeps
  its description when its id stays; descriptions themselves are not edited
  here (Deferred).
- **D1085. Done takes a proof, dropped stays dropped.** The slice dialog
  offers Done only to a slice that is done already (D646: proof is recorded
  with `slices.prove`), a new slice is planned, active or blocked, Dropped
  reads "Dropped (final)", and a dropped slice has no Edit (D651). An edited
  slice's wave cannot be emptied, and a step its process no longer has
  still shows.
- **D1086. `missions.orchestration { missionId }`** (`jhin.orchestrator`)
  names a mission's run: the last workflow `missions.orchestrate` started for
  it, with its thread, status, current phase, last five log lines, result and
  error, plus the head of the `orchestration` stream, read before the run.
  It takes `missions.read` and `threads.read`. It reads `workflows.list`, not
  `workflows.status`, so a client looking never acknowledges the run's
  wake-up (D376): the lead is still woken. A client follows the
  `orchestration` stream after that head. When a mission run it has not seen
  shows up (the lead orchestrating again), the client asks again. A run
  the node no longer lists (`workflows.list` lost it, e.g. after a restart)
  reads as none, so the panel offers Start; its outcome is in the lead's
  chat (W20).
- **D1087. Beside a mission is a slot.** The mission page renders
  `civilization.mission.aside` (the mission, its slices, the node's id and
  the assignee titles) to the right of the mission on wide screens and above
  it on narrow ones. `jhin.missions-view` contributes the orchestrator to it
  as `jhin.orchestrator.panel`, a chunk of its own (D440). The panel is a
  contribution, so another plugin can add to it or replace it.
- **D1088. What the panel shows.** Next is `missionProgress` (D702) over
  the client's fold: the wave, its ready slices with their assignee, the ones
  at work and with whom, and what waits for a decision. Waits for follows
  from the run: the proofs of the working slices while it runs, and the lead
  once it ended with an outcome (D707: a decision, the mission's steps after
  a wave, its last steps). A run reads as Not running, Running, Paused (W10's
  `stopped`), Waiting for the lead (`completed`) or Failed.
- **D1089. The owner starts a run from an agent's thread.** The owner has
  no thread of their own, so Start (or Resume) calls `missions.orchestrate`
  with `parentThreadId` set to the current generation of the agent picked
  under Run from (D706 takes a named thread from a caller that has none).
  Only agents with a generation can be picked. The default is the last run's
  agent, then a team's lead (`teams.list`), then an agent of the mission's
  project, then the first that can. W10 refuses a thread that is not full access, and the panel shows
  that refusal.
- **D1090. Pause ends the run, Stop halts the mission's work.** W10 has no
  pause, and the orchestrator keeps no state (D707), so Pause is
  `workflows.stop`: the slices already handed out keep going, and Resume
  orchestrates again from where the mission is. Stop mission, once confirmed,
  stops the run and calls `agents.stop` on every agent of this node working
  on an active slice of the mission. `agents.stop` stops an agent as a
  whole, in every mission, and the dialog says so. Those agents are resumed
  on their own page (D612). Stop does not change the mission's status; that stays an
  edit (D1081). After a Stop the run reads Paused too (W10 has one `stopped`),
  and the stopped agents show on their pages. Without a dialog host
  (`ui.dialogs`) there is no Stop, since it is never done unconfirmed.
- **D1277. The view says why titles fall back to ids.** `useDirectory` keeps
  what failed and the command's message, and the mission page, the slice
  page, the slice dialog (beside the assignee picker) and the orchestrator
  panel show one quiet line for each source that failed: "Owner unavailable:
  `host.identity` failed: …", "Agent titles unavailable: `agents.catalog`
  failed: …". A node that has no such command (no agents plugin) says
  nothing, as before: that is not a failure. A source is read once per view,
  with no retry.

### C3. Dogfood: a civilization end to end (D1101–D1120)

- **An end-to-end scenario in `e2e/`** on the fake runtime: bring up a team
  from a spec, set an intent and a mission with slices, start the
  orchestrator, let the fake agents hand in proof, have one agent ask the
  owner (inbox) and one push ceremony over the threshold (health warning).
  It asserts on persisted records and events, not on timing. It starts on
  commands and moves to the UI as C1 and C2 land.
- **A real run** on Jhin itself: a small team on Claude (lead, builder,
  reviewer) takes a real mission from a plan's Deferred list. The owner only
  talks to the lead and answers the inbox. What goes wrong is fixed in
  small PRs or written down as lore in `docs/lore/`; what is missing goes to
  [Deferred](#deferred) with the run as its evidence.

C3 decisions:

- **D1101. One scenario, one node, `e2e/tests/civilization.spec.ts`.** A
  team of three fake agents (lead, builder, reviewer) from a `jhin.teams`
  spec in config, `teams.up`, the intent, a mission with two waves of
  slices, `missions.orchestrate` from the lead's generation, proofs, an ask
  to the owner answered through the inbox, and a ceremony warning: the
  builder reports to the owner again and again. It ends when the mission is
  set done, which is the lead's decision (D651), sent for it (D1102). It
  follows the `missions`, `orchestration`, `agents/messages`,
  `agents/inbox` and `health` streams from their start
  (`e2e/tests/support/streams.ts`) and waits for the record it expects; it
  never waits for time.
- **D1102. The fake agents' own acts are commands sent for them.** The fake
  runtime calls no tools, so the test calls what an agent's MCP tools call:
  `slices.prove`, `missions.update`, and `agents.ask` and `agents.send`
  with the agent as `from` (D622). Everything the node does by itself
  (handoffs, thread links, the inbox item, the warning, its analysis, the
  orchestrator's outcomes) is asserted, never driven.
- **D1103. The scenario proves the threshold, not just a warning.** Health
  runs with a low `ceremony` config. Health takes each event as the log
  appends it, so once the last handoff is in the log `health.status` is
  exact: the test sends exactly the messages that reach `limitOf` (D722),
  reads the mission's count after each (one more each time, so the limit is
  reached with the last and not before), and asserts the warning's
  `measures` and that the agent with the context analysed it (D725).
- **D1104. Commands first, the UI where it exists.** Until C1 and C2 land,
  every step is a command; the test ends in Civilization mode on what A3
  and A7 already show (the mission view, the health section). Steps move to
  C1's console and C2's mission editing as they land.
- **D1105. `teams.up` adds a home project named by a folder's path.** A
  team or member whose `project` is the absolute path of a folder the node
  has no project for gets it through `projects.create` when the member
  joins, so the team works there from its first message; before, the team
  came up `defined` and its first message failed with `PROJECT_NOT_FOUND`,
  and its files in that project were not read (the C3 run). A folder that
  does not exist is the member's error (`PROJECT_PATH_INVALID`); an id the
  node does not know stays the agent's `unavailable` (D608). The project is
  added as the caller, so it takes the caller's own `projects.write`: putting
  a team up (D690) grants no more than before, and a caller without it gets
  the member's `PERMISSION_DENIED`; a member on another node gets
  `projects.write` with the caller's other grants (D416) when the caller
  holds it. Files the team keeps in that project
  (`dir`, D686) are read once it is there.
- **D1106. The orchestrator's handoffs come from the lead.**
  `missions.orchestrate` starts its run with the calling thread as the
  invocation's thread, so the run's `command()` calls act from it (D705) and
  `slices.handoff`'s message is sent as the lead's thread (D622). Before, the
  run carried the caller's grants but no thread, and `agents.send` fell back
  to the owner: in the C3 run every handoff reached the builder and the
  reviewer as a message from the owner. A caller without a thread that names
  `parentThreadId` (the owner's token) acts from it only when it holds every
  permission and so could send as that thread anyway; any other keeps its own
  sender.
- **D1107. An empty section says that no plugin fills it.** A section of
  the Civilization sidebar shows its own empty text only while no plugin
  contributes to its slot; each plugin's slot says itself when it has
  nothing ("Nothing waits for you."). So the shell's text names the missing
  plugin's subject ("No plugin shows missions here."), not a workstream that
  has landed, and never "No missions yet", which is false with the plugin
  off and missions on the node. This replaces D749's "naming who fills it".
  `civilization.sidebar.projects` stays: a slot id is public API (AGENTS.md
  rule 8), and no plugin fills it yet (A3's Deferred, "the Projects
  section").

Where C3 stands: the scenario (its first bullet) runs on commands, with every
part the bullet names; the real run (the second bullet) is done, see "C3
run" below. Left: the scenario's steps through C1's console (the
conversation with the lead, bringing the team up) and C2's mission editing
and orchestrator view once they land.

#### C3 run

On 2026-10-22 a team `crew` of three Claude Code agents (lead, builder,
reviewer, all Sonnet 5.5, full access) ran on a node started from a checkout
(`jhin serve --ui` with its own home), in a throwaway worktree of this
repository. The owner only sent the lead one message and read the streams.
The mission was the C3 Deferred item on the Projects section's empty text.

- **What went right.** The lead set the intent, planned a mission of two
  slices (build, then review) with a `commit` step, and ran it with
  `missions_orchestrate`. The orchestrator handed out each wave, the builder
  proved its slice with `vp check`, the web typecheck and the affected unit
  tests, the reviewer sent four findings, and the lead committed and closed
  the mission. It took 3 min 22 s from the owner's message to the closed
  mission, with six messages and no health warning.
- **Fixed.** `teams.up` came up `defined` with a home project the node did
  not have, and the first message failed (D1105, #199). Every handoff
  reached the builder and the reviewer from the owner, not the lead
  (D1106, #200).
- **Not landed as made.** The lead dropped the Projects section and its slot
  id (`civilization.sidebar.projects`), a public id (AGENTS.md rule 8),
  without asking the owner. The C3 Deferred item, written by this
  workstream, offered "or drop the section" and named no rule. The reviewer
  checked the list the lead gave it ("Projects removal leaves no dead
  import"), not whether the removal was allowed
  ([own homework](../lore/own-homework.md)). The texts said "No missions
  yet", which is false whenever the section shows, since it shows only
  without the plugin. The reviewer half caught that ("Health fallback
  claims healthy"). The lead then made the texts vaguer after the review
  ("Nothing here yet.") and committed them without another review. The
  builder changed `e2e/tests/modes.spec.ts` without running it. The owner
  landed D1107 instead, from the same diagnosis.
- **Records.** The mission was `927129bd-4bb9-40e3-9638-e27f790107b5` on a
  node whose home was thrown away with the run; the crew's two commits
  (`ba7dbedd`, `45d40100`) are kept on the branch
  `pr-assets/docs/c3-run-crew`. The streams as the owner read them, message
  bodies cut:

  ```
  14:59:28 message owner -> crew-lead: Hi, I'm the owner. One small mission …
  14:59:41 missions.intent.set
  15:00:03 missions.mission.created  Civilization sidebar: honest empty texts
  15:00:22 message owner -> crew-builder: [Slice handed to you] …  (D1106)
  15:01:25 workflow mission completed: wave-done, wave 1
  15:01:27 message crew-builder -> crew-lead: Slice … done and proven …
  15:01:35 message owner -> crew-reviewer: [Slice handed to you] …
  15:02:03 message crew-reviewer -> crew-lead: … 2 findings to fix, 2 minor
  15:02:05 workflow mission completed: slices-done
  15:02:50 missions.mission.updated  done
  15:03:00 answer crew-lead -> crew-builder: … committed as ba7dbedd; mission closed
  ```

- **Missing.** The owner heard nothing back: the lead reported to the
  builder, and its turn's answer stayed in its thread (Deferred, C1). No
  agent wrote to its knowledge folder in so short a run.

## Phase 3: trusting a long run

The goal of phase 3: the owner can give a team a mission of hours, walk
away, and come back to a report, a merged result that broke no rule, and an
honest record of what happened. Rules a team must keep are enforced by the
process and CI, not by asking agents nicely in a prompt
([just following orders](../lore/just-following-orders.md),
[own homework](../lore/own-homework.md)).

### L1. The lead reports to the owner (D1221–D1240)

- When a mission closes, fails or stops, the lead's report reaches the
  owner: an item in the Lead view (C1) and in the inbox (A2), with the
  mission, its slices, their proof and what was committed or merged.
- Escalations the lead decides to send up (a decision only the owner may
  take, a rule it would have to break) reach the owner the same way, and the
  team waits for the answer instead of deciding alone.
- A turn's answer meant for the owner never stays only in the lead's thread
  (the C3 run's "Missing").

Decisions (L1):

- **D1221. An agent's answer to the owner's message comes back to the
  owner.** A message (not an ask) from this node's owner to an agent of this
  node starts a turn like any message (D623); what that turn answers (its
  last assistant message, D624) is recorded with the message as
  `agents.message.answered`, as an ask's answer is, and
  `agents.conversation` (D1061) shows it under the owner's message, so the
  Lead view does too. Nobody waits for it: `agents.send` returns at once, and
  a failed, interrupted or silent turn records nothing. It takes the C3
  Deferred item: the turn records it, instead of the lead's instructions
  asking it to report.
- **D1222. The orchestrator sends the lead's mission report.** The thread a
  mission's last `missions.orchestrate` ran from is its **lead** (kept with
  the run). When the mission becomes done or dropped, or that run fails or
  is stopped while the mission is open, `jhin.orchestrator` sends the owner
  the report with `agents.send` as the lead's thread (D622), so it lands in
  the inbox (D626) and in the Lead view's conversation (D1061): the
  mission, its outcome, its slices wave by wave with status, assignee and
  proof (commands cut to their first lines), what was committed or merged,
  and for a run that ended the error and that the mission is still open.
  Its first line, `Mission report: <title>, <end>`, is what the inbox lists.
  It is built from the records, not from the lead's memory. The lead adds
  its word with **`missions.close {missionId, status: done | dropped,
  summary?}`**: `missions.update` with what was committed or merged and
  where; the orchestrator's `slices-done` outcome names it. A plain
  `missions.update` is reported too, saying the lead said nothing about
  it. The message id is the mission and how it ended (`report-<mission>-…`),
  so it is delivered once. Only the mission's current run is reported when
  it ends; an older one ending late is not. A mission no lead's thread ran
  is not reported,
  and only what happens after the node caught up with the `missions` stream
  is.
- **D1223. An escalation holds the lead's mission.** The lead escalates as
  D688 tells it, with `agents_ask` to the owner, and the escalation shows
  as before (the inbox, D630; a card in the Lead view, D1063). While an ask
  from a mission's lead to the owner is open in the inbox,
  `missions.next` lists it in `escalations` (additive), `slices.handoff`
  refuses with `ESCALATION_OPEN`, and the orchestrator ends with the outcome
  **`waiting`**: the team waits for the owner instead of the lead deciding
  alone. Slices already handed go on. The answer comes to the lead as a
  message (D626), which wakes it to orchestrate again. Every open ask of the
  lead holds its mission, about the mission or not: the lead decides what it
  asks.
- **D1275. The inbox is listed by sender.** `agents.inbox.list` takes an
  optional `from`, a sender's full address as the item stores it, beside
  `status` (additive). The orchestrator's escalations (D1223) ask for
  `{status: "open", from: <lead>}` and keep the asks, so `missions.next` and
  `slices.handoff` no longer read every open item of the inbox.

### L2. Guards in the process (D1241–D1260)

- **Review after the last change**: a mission's commit or merge step is
  refused while a slice has changes made after its last review. The process
  data (A3, A6) says which steps need a review; the orchestrator enforces it.
- **The reviewer reviews against the project**, not against the list the
  lead hands it: its brief is built from the project's rules (`AGENTS.md`,
  the plan that owns the area, the lore) through the context library (A4),
  plus the diff. The lead's notes are added, never a replacement.
- **Public ids in CI**: a check that fails when a capability id, command
  name, slot id, contribution id or event type present on `main` is renamed
  or removed without a deprecation (AGENTS.md rule 8). It runs for every PR,
  agents' and humans' alike.

Decisions (L2):

- **D1241. A step that needs a review is refused until the work is
  reviewed after its last change.** Which mission steps need a review is
  data in two places: the orchestrator's config `reviewSteps` (the owner's,
  default `commit` and `merge`, whatever a mission says, so the lead does not
  choose its own guard ([own homework](../lore/own-homework.md))) and
  `review: true` on a step of a mission's process (the default process's
  `merge` has it, D648). A mission takes a step of its own process with
  `missions.update { missionId, step }` (the mission records `step`; a step
  of no process is `MISSION_STEP_INVALID`), and the missions plugin runs the
  `missions.step` hook (`MISSION_STEP_HOOK`) before it, also for the same
  step taken again. `jhin.orchestrator` refuses there with
  `REVIEW_REQUIRED` and the slices in the way, and answers the same check as
  `missions.review.check { missionId, step? }`. Its workflow's `wave-done`
  and `slices-done` carry that check (`review`) and tell the lead to take
  each step before running it. A node without the orchestrator takes any
  step: A6 drives the process (D701).
- **D1242. A review is recorded with the files it saw.**
  `slices.review { sliceId, verdict, notes?, threadId? }` records the
  slice's last review (`approved` or `changes-requested`, notes on what was
  checked and found, who and when) as `missions.slice.reviewed`, with the
  git tree of the files where the work lives (the thread named, else the
  slice's first thread of this node, else its project): the new
  `git.tree { projectId | threadId }` of `jhin.source-control`, the working
  tree's content committed or not, written through a scratch index as a
  checkpoint is (D243), so a commit of the same files keeps the tree. A done
  slice is reviewed (`reviewCheck` in `@jhin/missions-api`) when its last
  review approved it after its proof and its files are still the tree the
  latest review of that place saw: a later review of the same files covers
  every slice living there, and a change after it, by anyone, the lead's
  included, is `changed-after-review`. Files that cannot be read now are
  `work-unknown`; a review without files (a node without `git.tree`, a
  project outside git) is checked by its time alone.
- **D1243. Review slices are data too.** A slice names the slices it
  reviews (`reviews`: slices of its mission in earlier waves,
  `SLICE_ORDER_INVALID` otherwise; a new slice's wave follows them as it
  follows `dependsOn`). A review slice needs no review itself, and its
  handoff tells its assignee to record each review with `slices_review`.
- **D1244. The reviewer's brief is built from the project.**
  `review.brief { sliceId }` (`jhin.orchestrator`, `missions.read`, so the
  reviewer can read it again) composes it for a review slice
  (`NOT_A_REVIEW` otherwise). The sources come in this order: the
  project's trailhead (`context.map`'s `trailhead` through `context.read`:
  this repository's `AGENTS.md`), the plans that own the changed files, the
  lore brief (`lore.brief`, reason `request`), the reviewed slices with their
  spec, proof and changed files, then the lead's notes (the review slice's
  spec) under their own heading, then the diff. The lead's notes are added,
  never a replacement. The owning plans come from the map: a row naming a
  changed package (`@jhin/<dir>`), plugin (`jhin.<dir>`) or client plugin
  (`<dir>` of `apps/web/src/plugins/`) in backticks gives the plan addresses
  it links, and a changed plan owns itself (`owningPlans`). The diff is
  `git.diff` of where the reviewed slice's work lives, its branch against
  the base (commits and edits), else its uncommitted edits. The node reads
  them, since an agent holds no `context.read`. A source that is missing (no
  `jhin.context`, no git) is named with the reason, never dropped silently.
- **D1245. The brief fits one message.** Every part has a share of
  `REVIEW_BRIEF_LENGTH` (26 000 characters, under `agents.send`'s 32 000).
  The diff takes what the others leave, and a part that is cut names where
  the rest is (its address, `git_diff`, `review_brief`), so the reviewer
  reads it from the checkout.
- **D1246. A review slice's handoff sends it.** `slices.handoff` of a slice
  with `reviews` sends the handoff and then the brief. The brief asks the
  reviewer to begin with "should this be done at all?", to name the rules
  and decisions it checked
  ([just following orders](../lore/just-following-orders.md)), to treat a
  renamed or removed public id as the owner's decision, and to record a
  verdict on each slice with `slices_review`.
- **D1247. Public ids are read from the source, at the merge base and
  now.** `scripts/public-ids.ts` reads string literals where each kind is
  declared: capabilities from the `provides` of a plugin's `package.json` and
  `*_CAPABILITY` constants; commands from `commands.register({ name })` and
  command definitions; slots from `<Slot name>`, `useSlot`,
  `slots.contribute`, `slot:` keys and `*_SLOT` constants; contributions
  from the `id` of `slots.contribute`; event types from `*Events` objects
  and `events.emit`. Tests, fixtures and builds are left out. It compares the
  merge base with `origin/main` (read from git's objects) with the working
  tree. No snapshot of the ids is committed, so parallel branches adding ids
  never conflict. Ids built at run time are not seen. On today's main it
  finds 44 capabilities, 325 commands, 41 slots, 70 contributions and 87
  event types, and no removal against any earlier commit except one it
  missed until it read command definitions (`mesh.call`).
- **D1248. A deprecation is an entry in `deprecations.json`, on main
  first.** An entry names the `kind`, the `id`, `since`, `removeAfter` and
  optionally `replacedBy` and the `decision`. An id may be gone only when
  the merge base already lists it and the day is after its `removeAfter`.
  Deprecating and removing in the same change is refused, so a rename always
  passes through a period in which both ids work. How to deprecate is
  written in `docs/README.md#deprecating-a-public-id` and AGENTS.md rule 8.
- **D1249. It runs for every PR and in `pnpm verify`.** CI's "Public ids"
  job (full history, `node scripts/public-ids.ts`) is required through the
  `CI` job. `pnpm verify` runs it too, and `--affected` skips it when only
  Markdown changed.
- **D1278. The mission view shows the process and the reviews.** The mission
  page marks the mission's own `step` in its "Mission process" steps. A slice
  row shows its latest review's verdict, and the slice page a "Review"
  section (verdict, who, when, notes) and, for a review slice, links to the
  slices it `reviews`. A "Reviews" section on the mission page shows
  `missions.review.check`: clear, or the slices not reviewed after their
  last change with the reason; it is asked again when the mission or one of
  its slices changes on the `missions` stream, and a node without the
  orchestrator (or a refusal) says "not known", a failed call says why.
  Editing `reviews` stays out of C2's dialogs.

### L3. A long run (D1261–D1280)

- After L1 and L2: a mission of 6–10 slices on Jhin itself, run for hours,
  with an Opus lead and the C3 team shape. The owner talks only to the lead
  and answers the inbox.
- What it must exercise: refocus (A6) across compactions, health (A7) over
  a long stream, knowledge kept across generations (A1, `agents.rotate`),
  and L1's report at the end.
- Fixes go into small PRs, new failure stories into `docs/lore/`, the rest
  into [Deferred](#deferred); an "L3 run" note records the run like the C3
  run.

## Deferred

- Pods (groups inside a team).
- A registry of shared team bundles (like openrig.dev/rigs). Bundles install
  from npm or a path first.
- An epidemiology team that traces a wrong idea through files and agents and
  fixes every copy ([`lore/mind-viruses.md`](../lore/mind-viruses.md)), as a bundle once A5 lands.
- Chat integrations (Slack, Telegram) for reaching the owner. Left out of
  phase 2 by the owner (2026-10-22). Notifications
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
- ~~A2: dismissing an inbox item without answering it (D626).~~ A2, D1274.
- A2: the transcript showing a message as from its sender, with a link back.
  The turn carries `origin` (D623); until a view renders it, the header line
  of the message names the sender and the trace.
- A2: a count of open inbox items on the mode switcher or the page title
  (D630 notifies once per item).
- C1: `agents.conversation` folds the node's whole `agents/messages` stream
  on each call (D1061); an index of messages by party once it grows.
- C1: telling the lead something without waiting for an answer
  (`agents.send`) from the Lead view: it asks (D1063); a message's answer
  comes back too (D1221), but the composer has no way to send one.
- C1: a lead's message (not an ask) to the owner stays an open inbox item
  until it is answered there; the Lead view shows it without closing it
  (dismissing an item is A2's, done: D1274).
- C1: an agent's runtime and interaction modes in D1065's form; Settings
  edits them (D604).
- C1: writing a team spec from the client (a `teams.define` writing the
  `jhin.teams` section); Settings edits the section, and a bundle installs as
  a plugin (D686, D1067).
- C1: the owner's conversation with an agent on another node: the owner's
  messages are recorded on the agent's node (D627), so `agents.conversation`
  here misses them (D1061). Reading both nodes, through `mesh.call`, joins it.
- A1: agents of a mesh member reached through another node (`remote` in
  the route): the roster follows the client's open connections only (D617),
  as D747 does.
- A1: starting the agents feed of a node over again with backoff when its
  stream breaks; today the roster shows the error with a Retry button.
- ~~A1: a generation's own status in the page's list of generations
  (`agents.generations` has it); the list marks the current one only.~~ A1, D1272.
- A3: the Projects section (`civilization.sidebar.projects`) with a
  project's intent of its own; the Missions section groups by project and a
  mission shows its project's intent (D654, D656).
- A3: missions of a mesh member (`route.remote`): the view reads the route's
  connection's node only (D654); a slice's thread on a member is read through
  the mesh (D656).
- A3: proof screenshots shown inline: a screenshot item is a link (D646 keeps
  URLs only) until proof files live on the node.
- ~~A3: an agent's title for an assignee (`agents.catalog`); the view shows
  the agent id from the address (D645).~~ C2, D1082.
- A3: deleting missions and slices (D651 drops them), and what happens to
  the missions of a deleted project (they stay in the stream, unseen).
- ~~A3: editing intent, missions and slices from the client; the view reads
  (D656), the commands edit.~~ C2, D1081–D1085.
- C2: editing a step's description (D1084 keeps it by id), and proving a
  slice from the client (`slices.prove` stays the agent's).
- C2: titles and the assignee picker for agents of other nodes of the mesh;
  the view lists its own node's agents, read once per view (D1082).
- ~~C2: saying why titles fall back to ids: a failing `host.identity` or
  `agents.catalog` leaves the picker without Owner or agents, silently
  (D1082).~~ C2, D1277.
- A3: proof stored on the node (screenshot files); a proof item names a URL.
- A3: a project deleted between the project check and the append of
  `missions.create` or `missions.intent.set` (D643) still gets its record;
  closing that needs a projects capability the writer can hold.
- A3: fencing an agent's `missions.write` to the slices that link its own
  thread (D652); agents are node-wide like the rest of D341 for now.
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
- A5: fencing escalation: refusing a member's ask to the owner, so only
  the lead reaches the inbox. D688 tells members, it does not enforce it.
- A5: removing a team's agents. `teams.down` stops them (D689); removing
  each member is `agents.remove` on its node.
- A5: a member moved to another node: `teams.up` puts it on the new node and
  rewrites the rosters, but its agent on the old node stays defined (stop it
  with `teams.down` before the move).
- A5: installing a plugin, and so a bundle, from npm with a command. Today the
  unpacked package goes into a plugin location (D686).
- A5: a bundle's skills installed for its members; skills stay names (D613).
- A5: members' statuses followed live on the team page; it asks `teams.get`
  when it opens and when the team changes (D691). A1's roster (D614) owns
  live status.
- A7: the team group (D722): a team counting what its agents' messages and
  slices count, beside missions and projects; its lead is already the
  analyst (D726).
- A7: health for a mesh: each node counts its own streams; a team across
  nodes needs the counts of every node, through `mesh.call` or shared
  streams.
- A7: detecting a repeated wrong idea nobody named yet (phrases recurring
  across agents' notes and messages); D727 needs the correction first.
- A7: an agent naming a corrected idea (`health.write` for an epidemiology
  team, see the item above) and tracing copies written before the correction.
- A7: warnings that clear themselves when the measure drops back under the
  threshold; today the owner dismisses them (D724).
- A7: queue activity of threads no slice links (an agent's other
  generations); D722 follows only the threads slices link.
- A7: linking a late answer back to its warning. An ask past
  `analysisTimeoutMinutes` is recorded `failed` and not cancelled (D725); an
  answer that comes later stays in the analyst's thread, and the warning is
  not asked again.
- A7: a feed whose read permission was taken back, or whose node lost the
  feed, recovering by itself when it is granted (or installed) again; today it stays not live until the connection is
  replaced (D731).
- A7: a growing pause between retries of a feed whose node keeps failing,
  and telling a lasting error from a passing one by its code: today any
  error but a missing command or a permission is read again once a minute,
  up to ten failures in a row (D731).
- A7: reading a turn's commits through `source-control.git@1` once it offers
  a read of `HEAD` and a count of commits; health runs `git` itself until
  then (D723).
- A7: commits of turns that overlap in one checkout (two linked threads, or
  a person committing meanwhile): each turn counts what landed between its
  start and its end (D723).
- A7: telling the owner, after a reconnect (a connection replaced or
  reopened), the warnings and the inbox items (D630) that arrived while it
  was down. The new feed loads them into the sidebar without telling them;
  within one feed, a stream that drops and is read again tells what came
  meanwhile (D731).
- A7: commits made outside a turn (by hand, by a workflow) and pull requests
  merged without a link to a thread (D722, D723).
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
- ~~A8: leaving generations out of `threads.search` as well: D745 filters the lists
  and catalogs only, so a search can still find a generation's text.~~ A8, D1276.
- A6: handing off a slice whose assignee is on another node (D702's
  `elsewhere`): `agents.send` reaches it, but the slice's thread link and
  refocus follow only this node's threads.
- A6: refocus as an `agents.send` message rather than a steer or queued
  message of the thread (D708), once a message can be steered.
- A6: an orchestrator that survives a node restart by itself; today the run
  fails (D376) and the lead starts it again (D707).
- A6: refocusing threads of other nodes linked to a slice; only this node's
  threads are followed (D710).
- A6: a refocus interval in minutes for long turns (D711 counts turns).
- ~~A6: a row in the chat for `agent.context.compacted` (D709).~~ A6, D1271.
- ~~A6: the orchestrator in Civilization mode, beside A3's mission view (D712).~~
  C2, D1086–D1090.
- C2: a real pause in W10 (a run that stops between steps and continues
  itself); Pause ends the run for now (D1090).
- C2: stopping agents of other nodes that hold a mission's slices, and
  running the orchestrator from a thread on another node (D1089, D1090).
- A6: ending a `missions.wait` when its caller goes away: commands get no
  cancellation signal (as W10's waits), so a stopped run's wait ends at its
  timeout.
- A6: journaling `command()` results (D705) so a resumed run reuses them.
- C3: a fake runtime that calls the agent's own tools (`slices_prove`,
  `agents_ask`, `agents_send`) on a slash command, so the scenario runs the
  agents' path through MCP instead of commands sent for them (D1102).
- C3: a node warning raised before its mission's stays open beside it. The
  owner's messages to the lead count only for the node (the lead holds no
  slice), so the node crosses first, and when the mission crosses later the
  node is quiet but its open warning stays: two warnings for one cause, which
  D724 means to avoid. Seen running the scenario (D1101): its Health
  section lists both; the test asserts only the mission's.
- L1: the answer to the owner's message (D1221) is followed while the node
  runs; a node that stops before the turn ends records none for it. Only
  this node's owner is answered: a message the owner of another node sends
  here stays unanswered in its conversation, which misses it anyway (C1's
  item on agents on another node).
- L1: a mission closed, or a run that ended, while the node was catching up
  (or down) is not reported (D1222); a mission no lead ran from a thread
  (handed out by hand, never orchestrated) has no lead to report from.
- L1: a member's escalation that the lead passes up holds the mission only
  as the lead's own ask (D1223); members asking the owner directly hold
  nothing (fencing them is A5's Deferred item).
- ~~L1: `missions.next` and `slices.handoff` read the open inbox to find the
  lead's escalations (D1223); a filter by sender on `agents.inbox.list`
  once inboxes grow.~~ L1, D1275.
- L1: the report as a card of its own in the Lead view (today the lead's
  Markdown text). ~~A way to clear a report from the inbox without an
  answer~~ A2, D1274.
- L2: a commit made in a shell is not refused: the guard holds the mission's
  step (D1241), not git itself. A `pre-commit` hook in the node's managed
  worktrees asking `missions.review.check`, or refusing `git.action.run`'s
  commit for a thread of a mission, would close it.
- ~~L2: the mission view shows a mission's `step`, its slices' reviews and
  `missions.review.check`.~~ L2, D1278.
- L2: editing a slice's `reviews` in C2's dialogs.
- L2: the owning plan is found by the map's rows (D1244); a project whose
  map names plans differently, or a change in a directory no row names,
  gets none, and the reviewer finds it through the trailhead. An agent's own
  `context.read` (D670 gives agents no grant) would let it read further
  through the library instead of the checkout.
- L2: which files a slice owns. A review covers the whole place a slice
  lives in (D1242), so in a shared checkout a change by one slice asks for
  another review of every slice there.
- L2: public ids the source does not spell out (template literals such as
  `sidebar.thread.jump.${jump}`, D1247), and hook names and permission names,
  which rule 8 does not list yet.

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
- A5 #185: the teams contract in `@jhin/agent-api` (`teams.ts`: the team
  spec and its config layer, the roster, aliases, `teams.bundles@1`, the
  `teams` stream and the schemas of `teams.*`). D681–D690 recorded; the
  server side and the Civilization-mode views follow.
- A5 #186: the `jhin.teams` plugin: specs from `jhin.teams` and bundles
  (`teams.bundles@1`), `teams.list`, `.get`, `.up`, `.down`, `.join`,
  `.resolve` and the `teams` stream, members on other nodes through
  `mesh.call`; aliases in `agents.send` and `agents.ask` (`jhin.agents`);
  agents hold `teams.read` (D681–D690). A bundle fixture in
  `plugins/teams/test/fixtures/workshop` is the example of a bundle.
- A5 #188: `jhin.teams-view`, teams in Civilization mode: the Teams
  section, a team's page with its agents, culture, Start and Stop team and a
  message to the lead, `civilization.team.open` (D691).
- A7 #189: `@jhin/health-api` (the `health` stream, warnings, ideas, the
  `jhin.health` config) and the `jhin.health` plugin: sensors of ceremony
  against progress per mission, project and node, the ceremony, recursive
  proof loop and mind-virus detectors, the analyst asked with `agents.ask`,
  `health.*` commands; agents read health over MCP (D721–D730). The owner's
  notification of a warning is the client's (#190, D731).
- A7 #190: `jhin.health` in the web client: warnings in Civilization
  mode's sidebar, the overview, a warning's page with its analysis and the
  events behind it, a notification per new warning; the inbox and health
  share `lib/node-feeds.ts` and `lib/tell-owner.tsx` (D731).
- A8 #105: `client.modes@1` and the `jhin.modes`, `jhin.mode-switcher` and
  `jhin.civilization` client plugins: Threads mode on today's slots, the
  Civilization shell with empty slots for A1, A2, A3, A5 and A7, and
  `includeGenerations` on `threads.list` and `threads.catalog` (D742–D750).
- A6 #181: the `jhin.orchestrator` plugin (`missions.next`, `missions.wait`,
  `missions.orchestrate`, `slices.handoff` through `agents.send`,
  `refocus.brief`, `refocus.send`), `missionProgress` in `@jhin/missions-api`, `command()`
  in W10's workflow scripts, and `context.compacted` from Claude Code, Codex
  and the fake agent (`agent.runtime@1.6`, `agent.registry` 1.3)
  (D701–D712).
- C1 #192: `agents.conversation`, the owner's conversation with an agent
  folded from `agents/messages` and the inbox, and the answer's text on
  `agents.message.answered` (D1061).
- C2 #194: planning from the mission view (`jhin.missions-view`): New
  mission, Edit intent, Edit mission, Add slice and Edit slice through the
  `missions.*` and `slices.*` commands, assignees by their agent's title
  (D1081–D1085).
- C3 #193: the civilization scenario in `e2e/tests/civilization.spec.ts`
  on the fake runtime, through commands, with `e2e/tests/support/streams.ts`
  (D1101–D1104); what it exposed went to Deferred.
- C2 #197: the orchestrator beside a mission: `missions.orchestration`
  (`jhin.orchestrator`), the `civilization.mission.aside` slot and
  `jhin.orchestrator.panel` with next, waits for, and start, pause and stop
  (D1086–D1090).
- C3 #199: `teams.up` adds a member's home project named by a folder's path
  (D1105), found by the C3 run.
- C3 #200: the orchestrator's handoffs are sent as the lead's thread, not as
  the owner (D1106), found by the C3 run.
- C1 #195: the Lead view, `jhin.teams.lead` in `civilization.lead`: the
  conversation with a team's lead, the composer asking it, its escalations
  with the way to the inbox, Start team, `civilization.lead.open`; the team
  page opens it instead of a message box of its own (D1062–D1064).
- C1 #196: defining and editing agents from Civilization mode
  (`jhin.agents.form`, `civilization.agent.define`, New agent in the roster),
  and New generation, Edit and Remove on an agent's page (D1065–D1067).
- C3 #201: the C3 run, its report and D1107 (honest empty sections in
  Civilization mode), the lore story "own homework".
- L1 #233: the answer of an agent's turn to the owner's message is recorded
  with it and shows in the owner's conversation and the Lead view (D1221).
- L1 #235: the lead's mission report from `jhin.orchestrator` (done,
  dropped, a run failed or stopped) to the inbox and the Lead view,
  `missions.close`, and the mission held while the lead's escalation is
  open (`escalations`, `ESCALATION_OPEN`, outcome `waiting`); the
  civilization scenario asserts both (D1222, D1223).
- L2 #236: public ids in CI: `scripts/public-ids.ts`, `deprecations.json`,
  the "Public ids" CI job and `pnpm verify` step; how to deprecate in
  `docs/README.md` and AGENTS.md rule 8 (D1247–D1249).
- L2 #234: review after the last change: `missions.update { step }` runs
  the `missions.step` hook and `jhin.orchestrator` refuses a step that needs
  a review (`reviewSteps`, `review: true`) with `REVIEW_REQUIRED`;
  `missions.review.check`, `slices.review` with the files' tree from
  `git.tree` (`jhin.source-control`), review slices (`reviews`)
  (D1241–D1243).
- L2 #237: the reviewer's brief from the project: `review.brief`
  (trailhead, owning plans through the map, lore, the reviewed work and its
  diff, then the lead's notes), sent by a review slice's handoff
  (D1244–D1246).
