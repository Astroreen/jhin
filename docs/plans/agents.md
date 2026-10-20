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

Decisions are recorded here as they are taken.

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

## Deferred

- Pods (groups inside a team).
- A registry of shared team bundles (like openrig.dev/rigs). Bundles install
  from npm or a path first.
- An epidemiology team that traces a wrong idea through files and agents and
  fixes every copy (`lore/mind-viruses.md`), as a bundle once A5 lands.
- Chat integrations (Slack, Telegram) for reaching the owner. Notifications
  come first.
- Agents of runtimes without MCP.

## Landing

Each workstream lists its PRs here as they merge.
