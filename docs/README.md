# The Jhin context library

This is where everything Jhin knows about itself lives, and the routes to
it. `AGENTS.md` is the trailhead: it sends every agent here. This page is the
map of maps; it does not repeat what the pages it points to say.

## Find your way

| You want to…                                       | Go to                                                          |
| -------------------------------------------------- | -------------------------------------------------------------- |
| know what already exists before building anything  | [`map.md`](map.md)                                             |
| know what a word means                             | [`../GLOSSARY.md`](../GLOSSARY.md)                             |
| know why something is the way it is                | the plan that owns it, see [Plans](#plans)                     |
| pick up or check a running workstream              | [`plans/t3-roadmap.md`](plans/t3-roadmap.md)                   |
| learn the failure modes agents fall into, by story | [`lore/`](lore/README.md)                                      |
| read outside research that shaped how we work      | [`research/`](#research)                                       |
| write a plugin                                     | [`../plugins/example/README.md`](../plugins/example/README.md) |
| run Jhin from a checkout                           | [`../scripts/t3/README.md`](../scripts/t3/README.md)           |

If what you need is not on any map, say so in your PR and add the route
(see [Adding knowledge](#adding-knowledge)). Search is the fallback, not the
first move: you cannot search for something you do not know exists.

## Plans

A plan records decisions (numbered `D<n>`), what was left out on purpose,
what is deferred, and how it landed. Plans are canon once implemented.

| Plan                                           | Owns                                                                   | Status      |
| ---------------------------------------------- | ---------------------------------------------------------------------- | ----------- |
| [`foundation.md`](plans/foundation.md)         | kernel, plugins, config, mesh, transport, storage, process             | implemented |
| [`t3-parity.md`](plans/t3-parity.md)           | T3 Code's client, threads, sidebar, machine icons                      | implemented |
| [`providers.md`](plans/providers.md)           | agent runtimes (Claude Code), agent registry, sessions                 | implemented |
| [`source-control.md`](plans/source-control.md) | git status, diffs, branches, pull requests                             | implemented |
| [`terminal.md`](plans/terminal.md)             | PTY terminals and the terminal drawer                                  | implemented |
| [`config-ui.md`](plans/config-ui.md)           | settings forms generated from config schemas                           | implemented |
| [`agents.md`](plans/agents.md)                 | persistent agents, messaging, missions, teams, refocus, health (A1–A7) | in progress |
| [`t3-roadmap.md`](plans/t3-roadmap.md)         | the W1–W18 workstreams porting the rest of T3 Code                     | in progress |

Workstreams add new plans (`orchestration.md`, `preview.md`, `security.md`,
`mesh-streams.md`, `desktop.md`); `t3-roadmap.md` names who owns which.

## Research

- [`research/openrig.md`](research/openrig.md): how OpenRig runs hundreds of
  coding agents as persistent teams, the coordination failures it hit and the
  context engineering it built against them. The source of this library's
  shape and of most of `lore/`.

## How knowledge is arranged

The library follows the world-building approach in
[`research/openrig.md`](research/openrig.md#world-building). An agent arrives
knowing the world in general, not Jhin; the library is the diff.

- **Wide before deep.** [`map.md`](map.md) lists every package, plugin,
  capability and command in one line each. Knowing that a thing exists costs
  a few tokens; not knowing it costs a parallel reimplementation
  ([reinvent the wheel](lore/reinvent-the-wheel.md)).
- **Routes, not piles.** Every page is reachable from the trailhead
  (`AGENTS.md` → here → the page). A fact nobody can reach does not help.
- **One source of truth per fact.** Link to it instead of copying it. When it
  changes, it changes in one place and every link reads the new version.
- **Stories for lessons.** A rule covers one case; a story carries the lesson
  into cases nobody wrote down. Recurring lessons live in [`lore/`](lore/README.md)
  under a short name, so "moonbase" is enough to recall the whole story.

### Addresses

Knowledge has stable addresses, like code ids (AGENTS.md rule 8):

- a file: `docs/plans/terminal.md`;
- a section: `docs/plans/terminal.md#deferred` (the heading's anchor) — read
  only that section, not the whole file;
- a decision: `foundation.md#D11`, found by searching for `**D11.`;
- a story: `lore/doghouse-moonbase.md`, or its name, "moonbase".

Do not rename headings, files or decision numbers that others link to. Move
a section only with a link left at the old place.

### Maturity

Not everything written down deserves the same trust. From least to most:

| Level       | What it is                               | Where it lives                                          |
| ----------- | ---------------------------------------- | ------------------------------------------------------- |
| exhaust     | logs, scratch notes, session transcripts | never committed                                         |
| observation | something seen once, not yet understood  | a PR description or review comment                      |
| note        | an observation with a cause              | a plan's Deferred list, or a code comment               |
| insight     | a lesson that applies beyond one change  | `lore/`, `research/`                                    |
| canon       | what the project relies on               | `AGENTS.md`, `GLOSSARY.md`, implemented plans, `map.md` |

Canon is about how established something is, not how old. When canon and a
note disagree, canon wins until someone changes canon on purpose, in a PR
that says so. When canon and the code disagree, the code is the territory:
fix whichever is wrong and say which.

## Adding knowledge

- A new package, plugin, capability or command → a line in [`map.md`](map.md).
- A new word → [`GLOSSARY.md`](../GLOSSARY.md).
- A decision → the plan that owns the area, with the next free `D<n>`.
- Something left out → that plan's Deferred section (AGENTS.md rule 4).
- A failure that keeps coming back in new shapes → a story in
  [`lore/`](lore/README.md), not one more rule.
- A new kind of page → a row in [Find your way](#find-your-way), so it has a
  route.
