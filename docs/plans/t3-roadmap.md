# T3 Code roadmap

Status: **in progress**. This file splits what is left of T3 Code into
workstreams that run in parallel, one branch (or a stack of branches) each.

## Goal

T3 Code is Jhin's starting point: every feature of it moves into Jhin's
plugin system, and from there it changes however the owner wants. What
`t3-parity.md`, `source-control.md`, `terminal.md`, `providers.md` and
`config-ui.md` list as Deferred, and the T3 features no plan names yet, are
done here. Only what needs T3's own hosted service stays out: T3 accounts,
billing, and pairing or remote access through a T3 account (T3 Connect).
Pairing a device with a node and remote access without T3 are in scope (W13).

The reference is T3 Code (D53). A feature missing from the D53 tag is taken
from the latest nightly; the plan that ports it names the tag it used.

## Rules for every workstream

- Read `AGENTS.md`, `docs/map.md`, `docs/plans/foundation.md`,
  `GLOSSARY.md`, the plan the workstream continues and this file first.
- Decisions are numbered from the workstream's range below, so parallel
  branches never take the same number. A workstream that needs more numbers
  takes the next free block of 20 after D760 and writes it here.
  D600–D760 belong to the agent workstreams A1–A8 in `agents.md`.
- Each workstream records its decisions in the plan it continues (or in a new
  plan named below), moves the items it finishes out of that plan's
  Deferred list, and adds what it leaves to Deferred.
- New public API (capabilities, commands, events, slots) is additive; a
  capability that changes shape gets a minor version.
- Rebase onto `main` before merging; when two workstreams touch the same
  files, the later one adapts.

## Workstreams

| Id  | Workstream                                                    | Plan                     | Decisions |
| --- | ------------------------------------------------------------- | ------------------------ | --------- |
| W1  | Server-side queue and steering                                | `t3-parity.md`           | D200–D219 |
| W2  | Thread history: edit, regenerate, fork, merge back, search    | `t3-parity.md`           | D220–D239 |
| W3  | Checkpoints, reverting to a turn, worktrees per thread        | `source-control.md`      | D240–D259 |
| W4  | Git actions, linking and watching pull requests, other forges | `source-control.md`      | D260–D279 |
| W5  | Diff panel                                                    | `source-control.md`      | D280–D289 |
| W6  | Composer                                                      | `t3-parity.md`           | D290–D309 |
| W7  | Codex runtime                                                 | `providers.md`           | D310–D324 |
| W8  | OpenCode runtime                                              | `providers.md`           | D325–D339 |
| W9  | Claude Code follow-ups                                        | `providers.md`           | D340–D359 |
| W10 | Delegated tasks and workflows                                 | `orchestration.md` (new) | D360–D379 |
| W11 | Scheduled tasks and webhooks                                  | `orchestration.md` (new) | D380–D389 |
| W12 | Browser preview, devices, rendered HTML                       | `preview.md` (new)       | D390–D409 |
| W13 | Pairing, remote access, scoped tokens, secrets                | `security.md` (new)      | D410–D439 |
| W14 | Sidebar                                                       | `t3-parity.md`           | D440–D459 |
| W15 | Terminal follow-ups                                           | `terminal.md`            | D460–D474 |
| W16 | Config and settings sync                                      | `config-ui.md`           | D475–D494 |
| W17 | Mesh live streams                                             | `mesh-streams.md` (new)  | D495–D509 |
| W18 | Desktop app                                                   | `desktop.md` (new)       | D510–D529 |

### W1. Server-side queue and steering

A message sent while a turn runs is queued on the node, survives a closed
page, and can be edited, reordered, cancelled or promoted to a steer that goes
into the running turn (Claude Code's live session, D98). Also idempotent
`threads.create` (an id chosen by the client) and one write for a record and
its index event.

### W2. Thread history

Editing a sent message, regenerating an answer, forking a thread at a turn,
merging a fork's result back, a thread operation that drops later turns
(threads are append-only today; W3 needs it to revert) and searching thread
contents from the palette and the sidebar.

### W3. Checkpoints and worktrees

A public hook around a turn's start and end in `jhin.threads`, checkpoints
under `refs/jhin/checkpoints/<thread>/<turn>`, T3's "Latest turn" and
"Turn N" diff scopes and the card's latest-run diff, reverting to a turn (with
W2's drop of later turns), worktrees per thread (the workspace selector,
"New worktree", "Start from origin", cleanup, handing a thread over to a
worktree) and agent runtimes running in the thread's working directory.

### W4. Git actions and pull requests

T3's GitActionsControl (commit, push, create a pull request, stacked
actions), linking pull requests to threads (`git.pr.linked`, D34), several
pull requests per thread and stacks, watching a pull request (checks done, a
comment, a conflict) and telling the thread, other forges (GitLab, Bitbucket,
Azure DevOps, Forgejo), GitHub Enterprise hosts and forks.

### W5. Diff panel

Syntax highlighting, split view, the file tree, comments on lines (sent to
the chat), opening a file in an editor and the base ref picker of the
"Changes" scope, as T3 renders them with `@pierre/diffs`.

### W6. Composer

`@` file mentions, slash commands and skills (from the runtime's
initialization), rich text (tiptap), pasted files other than images, image
compression and HEIC conversion, attachments as blobs in storage (not data
URLs in the turn's first event), per-turn model options (effort, fast mode,
context size) and the proposed-plan card with "implement this plan".

### W7, W8. Codex and OpenCode

Runtimes of `agent.runtime@1.1` with T3's behaviour: models, access and
interaction modes, approvals, questions, plans, tool calls, usage, resumed
sessions. Each in its own plugin.

### W9. Claude Code follow-ups

Everything in `providers.md` Deferred that is not steering (W1), per-turn
options (W6) or the plan card (W6): attaching the node's MCP server to
Claude Code, subagent transcripts, a cap on live sessions, keeping
background work alive, live flag settings, the interrupt and uuid edge cases,
an environment allow-list, deleting session files, the first probe, identical
blocks and the SDK warning.

### W10. Delegated tasks and workflows

A thread delegates child work to an agent of any runtime and model and
follows it by task id (status, cancel, result), the way T3 Code's
`delegate_task` does; launching top-level threads in a chosen workspace;
workflows that run several agents from a script. All commands, so reachable
over MCP.

### W11. Scheduled tasks and webhooks

Recurring work in a node's scheduler: an interval, a time of day on chosen
weekdays, or a webhook with a URL (optionally signed). A run goes to the
thread that scheduled it or to a new thread each time.

### W12. Browser preview and devices

A browser preview pane the user and the agent drive (open, navigate, click,
type, scroll, snapshot, screenshot, recording), devices (open, screenshot)
and self-contained HTML pages an agent renders into the chat.

### W13. Pairing, remote access, scoped tokens, secrets

Pairing a device with a node by QR or one-time code, giving it a device
token (foundation Deferred), remote access without T3's hosted relay,
scoped tokens and permissions (`projects.browse`, `host.config.read`,
`host.identity`, `git.*`, `terminals.*`, subscriptions to the event log),
scoped mesh calls, redacting secrets in `host.config.get`, an `Origin`
allowlist and keeping tokens out of `localStorage`. Pairing through a T3
account is out of scope.

### W14. Sidebar

Everything left in the sidebar item of `t3-parity.md` Deferred (settling on a
merged pull request, per-thread auto-settle, the node's sweep, one write per
drop, the Working shelf, multi-select, undo of a pin, collision detection,
jump-number hints, discarding a draft from its card), the branch-mismatch
warning, the Icon submenu for mesh members, warnings for conflicting
keybindings and code splitting of the web client.

### W15. Terminal follow-ups

Everything in `terminal.md` Deferred except terminals on mesh members (W17)
and scoped permissions (W13).

### W16. Config and settings sync

Everything in `config-ui.md` Deferred except secrets (W13), pushing a node's
config changes to its clients, and syncing visits, drafts and device
settings across devices.

### W17. Mesh live streams

Mirroring live streams between mesh members, so the source-control stream
and terminals of threads on members work like local ones, and truncation of
`storage.eventlog@1` streams (the source-control stream, `mesh/outbox`).

### W18. Desktop app

T3's desktop app on Jhin: an Electron shell that runs a local node and the
web client, with its window chrome, native menus, notifications and
auto update.
