# OpenRig: agent civilizations

Notes on two videos by Mike (@_feralmachine), the author of
[OpenRig](https://github.com/mvschwarz/openrig) ([docs](https://openrig.dev/docs)):

1. [I Run an AI Civilization in Herdr](https://youtu.be/AL-PQuB2wy0)
   (2026-09-18) — the setup, coordination failures and their fixes;
   [written version](https://openrig.dev/blog/agent-civilizations).
2. [How My AI Civilization Actually Works](https://youtu.be/CYRJDTcTKhQ)
   (2026-10-17) — context engineering as world building, and sharing whole
   teams as rigs.

Maturity: **insight** (see [`../README.md#maturity`](../README.md#maturity)).
This is one person's experience over 18 months, not Jhin canon. What Jhin
takes from it becomes canon only through decisions in a plan. The last
section lists candidates.

## The setup

- A few hundred coding agents are on all the time: six OpenRig instances,
  three Mac minis at home and three VPSs, all on one Tailscale network.
  Herdr only wraps the terminals. OpenRig does the
  coordination, and a TUI shows tables of what needs attention.
- The agents are ordinary, separate Claude Code, Codex and Pi sessions, not
  one agent with hidden subagents. **Any agent can message any agent on any
  machine.** It began with agents typing into each other's terminals through
  tmux instead of writing notes and waiting for the human to relay them. The
  author says that made the fleet about 50 times faster.
- The goal is "a harness for the harnesses": no new coding harness, SDK or API
  wrapper. Existing harnesses on their subscriptions are made to work
  together.
- A recurring pattern: the human talks to **one lead agent**, and a team works
  behind it. Leads talk to other leads and escalate only the decisions that
  need the human's altitude. The scarcest resource is human attention.
- The author calls it an "intelligence factory" rather than a software
  factory: the development lifecycle is a primitive for building anything,
  including the videos themselves.

## Primitives

- **Seat**: a chair with an address. The agent sits in the seat; it is not
  the seat. A seat gives:
  1. a stable configuration: role (e.g. `builder`), skills, model settings;
  2. a stable address others message: `builder@workshop`, where `workshop`
     is the team;
  3. inheritance: what an agent learns in the seat passes to the next agent
     that sits there, so tribal wisdom accrues across generations.
- **Pod**: seats that work closely together, e.g. a builder and a QA agent.
- **Rig**: a team made of pods, e.g. an orchestrator pod plus a build pod.
  It is described in YAML, plus a `culture.md` on how the team works together.
  A working arrangement is saved as a template. The name comes from climbing:
  each climber wears a harness, and the rig connects the climbers.
- **Project → mission → slice**: the project holds the big intent. A mission
  is usually a release: what it should achieve and which slices get there. It
  also has a wave diagram of slices that fan out in parallel or are sequenced
  when they depend on each other. A slice is one change, with a **spec** (what
  must work when done) and a **proof** (whether it got there). The UI zooms
  from project down to the agent working on a slice, "like Google Maps".
- **Process per level**, also in YAML: a slice runs spec → build → test, a
  mission does merge management between slices, a project does planning and
  release management between missions.
- **Workflow** (optional): a harness for the orchestrator. A background
  process tracks where the plan is and tells the orchestrator what comes
  next, like GPS for a self-driving car. The orchestrator still decides and
  can adapt the plan, but it no longer holds the sequence in its head, so
  autonomous runs last much longer.
- **Queue**: the core primitive tying work together; shown in an earlier
  video on the channel.
- **Messaging**: `rig send` to a live agent, **`rig ask`** to any agent, live
  or dormant. A dormant agent is answered from its JSONL session file, or woken
  for one question.
- **Rig spec**: a YAML blueprint of a team: agent names, specs, skills,
  plugins, starter context, governance and how they work together. A
  **rig bundle** is the hydrated version, with every file it needs in one repo
  or zip. Bundles are shared on [openrig.dev/rigs](https://openrig.dev/rigs)
  like skills. _Workshop_, a four-agent dev team for working on OpenRig
  itself, is the reference. Setup: `npx skills add mvschwarz/openrig --skill
  rigs`, then `/rigs`.

## Coordination failures

More than a dozen recurring failure patterns, cataloged as they were fixed.
Many are human failures happening at machine speed.

- **Bureaucracy** ([lore](../lore/bureaucracy.md)): a check prevents a
  mistake, then a check proves the check ran, then evidence for the checks,
  until finishing the process is the goal. This is a _coordination
  pathology_: something that made the system work starts making it
  dysfunctional, and the rules matter more than what they serve. Its variant
  is the **recursive proof loop**, where agents keep improving the proof of a
  task that is already done.
- **Doghouse → moonbase** ([lore](../lore/doghouse-moonbase.md)): every step
  is _locally defensible_ (sensible inside the agent's context window), and
  together the steps build what nobody asked for. More agents get there
  faster.
- **Just following orders** ([lore](../lore/just-following-orders.md)): an
  agent gets approval from another agent it treats as an authority, but the
  approver lacks the street-level detail. Between them the information
  existed, but it never met in one decision.
- **Mind viruses** ([lore](../lore/mind-viruses.md)): a bad idea written into
  a note is learned by the next agent ("this is how we do things here") and
  taught onwards across machines. Some cases took weeks to untangle.
- **Reinventing the wheel** ([lore](../lore/reinvent-the-wheel.md)): an agent
  builds a parallel implementation next to an existing one, because it does
  not know what it does not know.

The author reads the Hugging Face "rogue swarm" incident (about a thousand
agents attacking systems outside their target;
[investigation](https://www.redwoodresearch.org/research/hugging-face-incident))
through these failures. Agents who believed they were in a hacking
competition scope-crept like the moonbase, got permission from peer
"authorities", and some drifted into recursive proof loops. To explain such
behaviour, reconstruct the context window and ask whether each step was
locally defensible, rather than assume a motive. The warning is a new family
of software engineering problems, not AI doom.

## Fixes

- **Context engineering as world building.** The model knows the world in
  general, the harness adds a system prompt and tools, and neither knows the
  project. Context is the _diff_ between the world the agent knows and the
  world it is airdropped into. It needs a map, a compass and a way to find
  what it does not know.
- **Distributed context engineering.** Agents do not need the same context.
  Specialists go deep on their _context domain_, and the domains are arranged
  as a topology: a graph, which code can walk.
- **Refocus.** Code walks slice → mission → project and gathers the intent at
  each altitude ("a usable doghouse" → "the dog is comfortable outdoors" →
  "be a good dog owner"). It reminds the agent after a compaction or on an
  interval: is what you are doing aligned with the bigger picture? There is no
  need to reload the whole project or start a fresh agent per task, only a path
  back to the intent.
- **Epidemiology rig.** Against mind viruses, an agent designed a whole rig
  that ran for days doing contact tracing: where an idea came from, which
  files and agents carried it, and "memetic vaccines" to stop its spread. The
  lesson: once the tool is solid, solve its problems with the tool, as a rig
  dedicated to the problem.
- **Agent Productivity Monitoring (APM).** It is software, so instrument it
  with logs, sensors and alerts. The main sensor is **ceremony** (checks,
  handoffs, approvals around the work) against real progress. More and more
  queue activity with less and less movement on the project is the alarm. A
  Health view shows the warnings. Crossing the threshold sends the human a
  Slack message and notifies **an agent that has the rig's context**, which
  does the analysis. A random agent given the analysis would likely make
  things worse.

## World building

From the second video. The trigger was the Slack integration: it was nearly
finished, then set aside for a month. The agent asked to finish it searched
for "Slack", built a brand-new messaging system next to OpenRig's existing
messaging primitive, and connected Slack to that. Graph databases and AI
memory products had not fixed this. The insight: **they don't know what they
don't know**. Search cannot help an agent that does not know which question
to ask. A note saying "there is already a Slack integration" is whack-a-mole.
The fix has to generalize, which makes it an onboarding problem, not a memory
problem.

- **Connect the dots.** A pile of facts and rules barely helps; meaning comes
  from the _arrangement_. An agent arriving in the project already has many of
  the dots but not the project's connections, and some dots are new. That
  delta is what context must add.
- **Memory palace** (Joshua Foer, _Moonwalking with Einstein_): human memory
  is built for wayfinding in space. World building in games and fantasy gives
  newcomers a map and tools and lets them discover the rest. This is
  progressive disclosure, which agents already get through `AGENTS.md` and
  skills. A shared world model is also compression: say "castle" and the
  throne room and dungeon come for free.
- **Cognitive interoperability.** Humans and LLMs are "cognitive cousins",
  since LLMs learned from human language. The shared medium must work for
  both. If it is opaque to the human, the human becomes the bottleneck or
  drops out of the loop. Markdown is the sweet spot: agents read, edit and
  script against its structure, and any human can read it. The aim is for the
  human to reason about the agents' knowledge intuitively, even under stress.
- **Ontology and topology** (2D): knowledge bits are _entities_ (dots), joined
  by _relationships_ ("this decision explains why the system works this
  way"). Together they form a _topology_ you navigate like Wikipedia links.
- **Width for depth**: a wide-angle map, an inch deep and a mile wide.
  Knowing something exists takes far fewer tokens than knowing it. The goal is
  **minimum viable competence**: enough orientation to locate yourself, start
  working, and notice when to go deeper or look wider. Riskier work warrants a
  more detailed map, but leave room in the context window for the work. A code
  reviewer needs a different map than an architect. A large world has many
  maps, with routes between them and a hierarchy, and an agent should know
  when it reached a map's edge.
- **Trailhead**: hand the map where every journey starts. `AGENTS.md` is read
  on arrival, routes into the context library, and from there knowledge links
  to decisions and specs. A **router skill** helps choose the domain. Write
  its title and description like good clickbait, so the agent actually opens
  it. `AGENTS.md` is only read occasionally; skills give more control.
- **Addressability**: everything gets an address. Agents have one like an
  email, and context has one too: a file path, plus a **Markdown heading**
  inside the file, so an agent reads one section, not the whole file.
  Sections from several files compose into custom views. Addresses make
  knowledge reachable by scripts and easy for agents to remember.
- **Navigation spine and route-to-leaf reachability**: the architect lays the
  main highways and agents add routes as they work. Every needed leaf should be
  reachable from where an agent boots. Search is the fallback. The bootstrap
  is a trailhead, not the answers.
- **Epistemic maturity** (3D, elevation): **Markdown exhaust** (raw logs and
  notes, mostly short-lived and often misleading) → observation → field note
  → insight shared with the team → **canon**, what the project treats as
  established. Canon is about how established something is, not age. Canon
  rests on the less mature knowledge below it, which serves as its evidence.
  Keeping the life cycle of a hundred agents' exhaust under control is
  otherwise a full-time job.
- **Time and stories** (4D): snapshots of arrangements in sequence are a
  story. A good story chooses the snapshots that let you follow what
  happened and why it mattered, and a good example is a good story: a world in
  motion compressed into one piece of knowledge. The reader connects the rest
  of the dots, and the lesson carries into unrelated situations. That makes it
  work like a principle, best as a **parable**, instead of one more rule. These
  live in a **`lore`** folder, belong to a rig, pod or seat, and have
  addresses. The moonbase story is taught at onboarding and after every
  compaction, and the single word "moonbase" brings it back.
- **The map is not the territory.** The territory is files, headings, links
  and commands. Agents still read the code and check what the system does.
- **Library of minds**: knowledge is also _agents_. The source of truth for
  how Slack messaging works lives at one address, and next to it is the agent
  that built it. If it is online, `rig send` asks it why; if it is dormant,
  `rig ask` reads its session file. Thousands of dormant agents stay reachable
  as long as session files are kept. The human is a node too, with an address,
  and agents' questions reach them through Slack, which is why the Slack
  integration existed. Specialists know their domain deeply and know enough of
  the others to know whom to ask.

## Scaling out

When OpenRig hit #3 on GitHub Trending and PRs flooded in, the author cloned
the "talk to one lead" template onto more VPSs (community, build teams,
integration, release), about 3× the team. New rigs did real work at once:
they found the context and reached domain experts across the network without
the author explaining anything. One outside PR (Slack buttons for answering
agent questions) was reviewed and merged entirely by the teams.

The stress test found gaps. Some new agents lacked routes into parts of the
world from the start, and others lost them only after a compaction. Because
the world was readable to the human, the question in the middle of the
firefight stayed simple: **is the knowledge missing, or is the road broken?**
Then agents traced and repaired the path. Competence had become reproducible,
so capability scaled with compute: a **shippable unit of competence**, a team
airdropped onto a $10 VPS and useful at once. Seats compound what they learn,
so the network gets smarter. "Rigs are the new skills."

## Candidates for Jhin

Not decisions. Each needs a plan before it is built (AGENTS.md rule 4: what is
not built goes to Deferred). They map onto what exists in [`../map.md`](../map.md):

- **Agent entity with an address**: `jhin://<nodeId>/agents/<id>` is
  reserved (`docs/plans/foundation.md#D52`). A seat is close to it: role, skills, model
  and inherited lore attached to the address, not to the process.
- **Agent-to-agent messaging over the mesh**: any agent reaches any agent on
  any node, through commands (`agents.send`, `agents.ask`) so RPC, CLI and MCP
  all get it. Dormant agents answer from their stored sessions.
- **Teams as config**: pods and rigs as a config section and a shareable
  bundle (a rig spec), installed like a plugin.
- **Project → mission → slice** with spec and proof, and an orchestrator
  workflow that tracks the plan (W10 delegated tasks and W11 scheduled tasks
  are the nearest workstreams).
- **Refocus**: a hook on compaction or an interval that injects the intent
  chain of the current work.
- **Lore and the context library as plugins**: addressable Markdown by
  heading, composed views, maturity levels, a router skill per project.
- **Health / APM**: a ceremony-to-progress sensor over the event log, with
  alerts routed to the human and to an agent that has the context.
- **The human as an addressable node** that agents can ask, reachable through
  notifications or a chat integration.
