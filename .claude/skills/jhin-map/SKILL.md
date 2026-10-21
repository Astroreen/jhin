---
name: "jhin-map"
description: "Before you add a plugin, capability, command, package or UI piece to Jhin, open this — Jhin probably already has most of it, and this shows where. Also the way in to Jhin's decisions (D-numbers), vocabulary, running workstreams and the lore of how agents go wrong here."
---

# jhin-map

Generated from `docs/map.md` by `jhin context.skill.install`; regenerate it instead of editing it.

## Find your way

From `AGENTS.md#find-your-way`:

This file is the trailhead. It does not hold the answers; it points to them.

1. `docs/map.md` — everything Jhin already has, one line each. Read it
   before building anything, so you extend what exists instead of building
   it twice.
2. `docs/README.md` — the context library: which page knows what, how
   knowledge is addressed, and how much to trust it.
3. `GLOSSARY.md` — the vocabulary. Use exactly these words.
4. The plan that owns your area (`docs/plans/`, listed in `docs/README.md`),
   and `docs/plans/t3-roadmap.md` to check whether a workstream already
   builds it.
5. `docs/lore/` — short stories of how agents go wrong. Read them on arrival
   and again after a compaction. In review a name is enough: "moonbase".

Read only the section you need (`docs/plans/terminal.md#deferred`), not
whole files. If something you need is not reachable from here, add the route
in your PR.

## The map

Read one section, not the whole page: `jhin context.read --path docs/map.md#<section>`.

- `docs/map.md#shape` — Shape
- `docs/map.md#packages-packages` — Packages (`packages/`)
- `docs/map.md#server-plugins-plugins` — Server plugins (`plugins/`)
- `docs/map.md#client-plugins-appswebsrcplugins` — Client plugins (`apps/web/src/plugins/`)
- `docs/map.md#apps-tests-scripts` — Apps, tests, scripts
- `docs/map.md#in-progress` — In progress

Added a page? Give it a route and check with `jhin context.map`: it lists pages the trailhead does not reach and routes that lead nowhere.

## Lore

In review a name is enough. Read the story with `jhin lore.get --name <name>`.

- **bureaucracy** (`docs/lore/bureaucracy.md`): checks that prove checks; finishing the process became the goal
- **moonbase** (`docs/lore/doghouse-moonbase.md`): every step was reasonable; together they built what nobody asked for
- **just following orders** (`docs/lore/just-following-orders.md`): an approval from someone who lacked the context is not an approval
- **mind virus** (`docs/lore/mind-viruses.md`): a wrong idea written down spreads to every agent that reads it
- **reinvent the wheel** (`docs/lore/reinvent-the-wheel.md`): you cannot search for what you do not know exists; read the map first
