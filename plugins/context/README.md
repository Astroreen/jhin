# jhin.context

A project's Markdown as an addressable context library
(`docs/plans/agents.md#a4-context-library-and-lore-d661d680`).

```sh
jhin context.read --path docs/plans/terminal.md#deferred   # one section
jhin context.read --path docs/plans/foundation.md --heading D11
jhin context.view --input '{"sections":["AGENTS.md#architecture-rules","docs/map.md#shape"]}'
jhin context.map                                           # unreachable pages, broken routes
jhin lore.list
jhin lore.get --name moonbase
jhin lore.brief --reason compaction                        # what an agent reads after a compaction
jhin context.skill                                         # the router skill, generated
jhin context.skill.install                                 # ...and written to .claude/skills/<name>/SKILL.md
```

Every command takes `projectId` for another project of the node; by default
it reads the directory the node runs in (`jhin --cwd`).

The `jhin.context` config section says how the project is arranged:
`trailhead`, `map`, `library` (directories whose pages must be reachable),
`lore`, `maturity` (path prefix → level for pages without front matter) and
`skill` (`name`, `description`, `route`, `dirs`). This repository's own
settings are in `.jhin/config.jsonc`.

A page marks its maturity in front matter:

```md
---
maturity: canon
maturity.deferred: note
---
```
