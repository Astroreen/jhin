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
Done: git actions (D260–D266, #54), linked pull requests and stacks
(D267–D270, #77), watching a pull request (D271–D274, #80) and other forges,
GitHub Enterprise and forks (D275–D279, #85); what is left is under
`source-control.md#deferred`.

### W5. Diff panel

Syntax highlighting, split view, the file tree, comments on lines (sent to
the chat), opening a file in an editor and the base ref picker of the
"Changes" scope, as T3 renders them with `@pierre/diffs`.

Done: rendering with `@pierre/diffs`, split view, the file tree, the base
ref picker and diff scopes as contributions, with W3's turns among them
(D280–D284, D288, #83); opening a file in an editor (D286–D287, #92);
comments on lines sent to the chat through `chat.composer.insert` (D285).
Done except T3's comment chips in the composer, the comments shown inline in
the diff and the timeline's review comment card (they wait for composer
contexts); those and the rest are under `source-control.md#deferred`.

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

Done: the node's browser with T3's preview tools (D390–D402, #49), the right
panel (D403, D404, #96), rendered HTML pages (D405–D407, #110) and devices
(D408, #116). What is left is in `preview.md#deferred`.

### W13. Pairing, remote access, scoped tokens, secrets

Pairing a device with a node by QR or one-time code, giving it a device
token (foundation Deferred), remote access without T3's hosted relay,
scoped tokens and permissions (`projects.browse`, `host.config.read`,
`host.identity`, `git.*`, `terminals.*`, subscriptions to the event log),
scoped mesh calls, redacting secrets in `host.config.get`, an `Origin`
allowlist and keeping tokens out of `localStorage`. Pairing through a T3
account is out of scope.

### W14. Sidebar

Done: code splitting of the web client (D440), warnings for conflicting
keybindings (D441), the Icon submenu for mesh members (D442), the
branch-mismatch warning (D443), settling by the node: per-thread
auto-settle, its sweep and settling on a merged pull request (D444–D447),
T3's collision detection and one write per drop (D448–D449), T3's undo
notice (the undo of an unpin among it) and discarding a draft from its card
(D450–D451), the Working section (D452), the jump-number hints (D453),
multi-select (D454) and T3's sweep over several rows (D455). What W14 left
is in the sidebar item of `t3-parity.md` Deferred.

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
`storage.eventlog` streams (the source-control stream, `mesh/outbox`).

### W18. Desktop app

T3's desktop app on Jhin: an Electron shell that runs a local node and the
web client, with its window chrome, native menus, notifications and
auto update.

## Round 2

W1–W18 have landed their main scope. What a T3 Code user would still miss
sits in the plans' Deferred lists. Round 2 takes it on in these workstreams;
each continues the plans named and moves what it finishes out of their
Deferred lists. Internal hardening that no user sees stays in Deferred
unless a workstream needs it.

| Id  | Workstream                                              | Plans                                                        | Decisions |
| --- | ------------------------------------------------------- | ------------------------------------------------------------ | --------- |
| W19 | Steering and thread history leftovers                   | `t3-parity.md`                                               | D800–D819 |
| W20 | Delegated work in the UI, subagent threads, automations | `orchestration.md`, `providers.md`                           | D861–D880 |
| W21 | Worktree, git and pull request leftovers                | `source-control.md`                                          | D901–D920 |
| W22 | Diff panel leftovers                                    | `source-control.md`                                          | D921–D940 |
| W23 | Composer leftovers                                      | `t3-parity.md`, `terminal.md`                                | D841–D860 |
| W24 | Codex and OpenCode parity                               | `providers.md`                                               | D881–D900 |
| W25 | Preview, devices and the desktop app                    | `preview.md`, `desktop.md`                                   | D941–D960 |
| W26 | Pairing, sidebar, terminal and config leftovers         | `security.md`, `t3-parity.md`, `terminal.md`, `config-ui.md` | D961–D980 |

W23 first had D680–D699, which `agents.md` gives to A4 and A5; it took the
free block D841–D860 instead. W19 first had D600–D619, which `agents.md`
gives to A1; it took D800–D819.
W20 first had D620–D639, which `agents.md` gives to A1 and A2; it took
D861–D880. W24 first had D700–D719, which `agents.md` gives to A5 and A6; it
took D881–D900. W21 first had D640–D659, which `agents.md` gives to A2 and
A3; it took D901–D920. W22, W25 and W26 first had D660–D679, D720–D739 and
D740–D759, inside `agents.md`'s D600–D760; they take D921–D940, D941–D960
and D961–D980. A workstream that needs more numbers takes the next free
block of 20 after D980 and writes it here.

- **W19:** T3's restart dispatch for agents that cannot steer, steering a turn
  that waits for an approval, foreground subagents moved to the background
  before a steer; find in a thread (`mod+f`), "Resume thread" for a stopped
  turn, the Lineage panel of forks. Also clears the stale entries of
  `t3-parity.md` Deferred.
- **W20:** subagent rows and child threads hidden from the sidebar, the
  workflow progress tree with its Stop button, a task's completion steered
  into the parent's turn, per-turn options for a child, worktree isolation for
  launches, `resumeFromRunId`, `budget`, nested and saved workflows; Claude
  Code subagents shown as child threads; the thread's automations panel, the
  editor's workspace and model pickers, `secretRef` webhook secrets through
  `request_secret`.
- **W21:** worktree setup scripts and their progress card, a temporary branch
  named from the first message, cleanup rules, one worktree per model of a
  multi-model send, `composer.workspace`; the pull request right panel, chat
  header rows, native stacks with "Dismiss from thread", review comments on
  lines, required checks as the gate, the sidebar's "Waiting", "Checkout pull
  request", watching and icons for other forges, "Publish repository",
  cancelling a git action, the per-file menu and icons on the changed files
  card, "Roll back" in the item inspector.
- **W22:** comment chips, comments shown in the diff with "Delete comment",
  the review comment card in the timeline, in-app file preview, loading a
  truncated diff file by file, expanding unchanged lines, find in the diff,
  T3's file icons, "Reveal in file manager", remote editor URLs, the pop-out
  panel.
- **W23:** Shiki highlighting and the language picker, Tab indents, headings,
  rules and task lists, citation and context chips with popovers, `#` pull
  request mentions and threads in `@`, bracket and quote wrapping, plain-text
  and literal modes, the hide-skills setting, file previews in the composer
  and messages, video attachments, captured window context, thumbnails of
  queued images, the inline terminal-context chip.
- **W24:** for Codex: per-turn effort and fast mode, `/goal`, `/compact`,
  `/feedback`, skills and `$skill`, revert, fork and rollback, async
  questions, subagent threads and background terminals, MCP elicitations and
  apps, the node's MCP server attached, usage windows and retry progress,
  ChatGPT sign-in and several accounts, newer model slugs. For OpenCode: 1.x
  support, reconnecting a lost event stream, per-turn variants, steering,
  fork, rollback and subagent transcripts.
  Landed so far: Codex per-turn effort and service tier (D881, #120),
  `/compact`, skills and retry progress (D884–D886, #127); OpenCode
  variants and steering (D882–D883, #128). The rest stays in the Codex and
  OpenCode Deferred lists of `providers.md`.
- **W25:** the browser preview and devices inside the desktop app (preview.md
  and desktop.md each defer it to the other; W25 owns it), browser profiles
  and logins, `chrome-headless-shell` on first use, discovered local servers,
  the mini player, touch input, uploads and downloads, rendered-page
  extras, the device hub with input and video, SSH hosts and the setup wizard;
  packaging, signing, notarization and a release workflow so auto update has a
  feed, app icons, release notes in the update control, Paste as Text, the
  quit-hold shortcut, WSL and SSH backends, the CLI shim.
- **W26:** `jhin pair` with a terminal QR code, pairing links for a
  `jhin client` page, device metadata and live updates in the authorized
  clients list, an OS keychain store, Tailscale Serve, MCP OAuth, permission
  titles; "Keep threads with a PR", per-project settle overrides,
  "Regenerate titles (N)", the "Custom…" snooze, dragging a selection into the
  chat, undo of a drag unpin or settle, the X that clears a draft; provider
  environments for a terminal, clickable paths in terminal output,
  right-panel terminals as surfaces; T3's color and font pickers, dragging
  list items.
