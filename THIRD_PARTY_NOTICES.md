# Third-party notices

Jhin is licensed under Apache-2.0 (see `LICENSE`). Parts of it are derived
from the projects below; their notices are reproduced as their licenses
require.

## T3 Code

Source: https://github.com/pingdotgg/t3code

Used for: the web client's visual layer (components, layout, styles) and
parts of its logic (keybindings, command palette search, work-log summaries,
prompt history, timestamps, thread status, settings forms, the sidebar's
thread order, settling, pinning, snoozing and dragging, with the threads
plugin's rules for them, the thread cards' branch, pull request and diff
indicators, the branch toolbar, the git actions control and the diff panel with
its file tree, base ref picker, turn scopes and comments on lines (T3's
`reviewCommentContext.ts`, `composerContextLegacySend.ts` and
`DiffCommentAnnotation.tsx`), T3's file icons (`apps/web/src/lib/pierre-icons.ts`,
`pierre-entry-icon.tsx`; their sprite keeps T3's Lucide (ISC) and Simple
Icons (CC0) symbols with those notes), find in the diff (T3's patch of
`@pierre/diffs` at T3's commit `eb7b35ac`, `patches/@pierre%2Fdiffs@1.5.2.patch`), a
turn's changed files card, the
workspace selector, the worktree icon and clean-up, the worktree setup card
(`plugins/source-control/worktree-setup.tsx`) with its tracker and setup
script runner (`plugins/source-control/src/setup.ts`, the contracts in
`packages/source-control-api/src/worktree-setup.ts` and
`packages/agent-api/src/project-scripts.ts`), the worktree cleanup rules and
sweep (`plugins/source-control/src/cleanup.ts`), the "Checkout pull request"
dialog, the forges' icons, the terminal drawer, its
links (with the targets of path links, T3's `fileLinks.ts`), selection menu and right-panel placement, tabs and splits and the terminal indicator of a thread's card, node machine
icons, the composer and its proposed-plan card: `apps/web/src/lib/proposed-plan.ts`,
`plugins/chat/proposed-plan-card.tsx` and `plan-follow-up.ts`, its tiptap
prompt editor, menus, attachments and model options, its context chips
(`packages/ui/src/components/context-chip.tsx`, `plugins/chat/composer-chips.tsx`,
`plugins/chat/context-chips.tsx`), quotes of an agent's message
(`packages/agent-api/src/citations.ts`, `apps/web/src/lib/assistant-text-selection.ts`,
`plugins/chat/citation-chips.tsx`, `plugins/chat/cite-selection.tsx`) and a message's context records
(`packages/agent-api/src/context.ts`, `plugins/threads/src/context.ts`,
`apps/web/src/lib/composer-context.ts`), editing from a
message, forks and merging them back, searching thread contents, the
find in a thread with its highlights (`plugins/chat/thread-find.tsx`, `thread-find-bar.tsx`), the
thread details panel and its Lineage section (`plugins/chat/thread-details-panel.tsx`,
`lineage.tsx`, `packages/ui/src/components/thread-details-section.tsx`), the
scheduled tasks settings page (its base branch picker
`plugins/scheduler/base-branch.tsx` too), the subagent, workflow and created-thread rows
of delegated work, the "N subagents" row and a subagent's hover card, and
their Lineage rows in `plugins/orchestration`, the
subagent bar `plugins/chat/subagent-bar.tsx`, the thread's automations
`plugins/scheduler/automations.tsx`), the
threads plugin's merge-back handoff and search snippets
(`plugins/threads/src/history.ts`) and the context and prompt of a
regenerated title (`plugins/threads/src/title.ts`), source control (`plugins/source-control`:
reading git status and diffs, pull requests and their checks through the
GitHub CLI, git actions: committing, pushing, creating pull requests, naming
feature branches and the prompts that write commit messages and pull
requests, linking and watching pull requests, and the drivers of GitLab,
Azure DevOps, Bitbucket and Forgejo, checkpoints of a thread's working tree
and when they are taken, worktrees of a thread, handing a thread over to one,
reverting a thread's files to a turn and checking a pull request out), the editors plugin (`plugins/editors`: T3's editor
list, finding and starting editors), the detection
of a node's machine kind (`packages/node-host/src/machine.ts`), the Claude
Code agent runtime (`plugins/agent-claude`: query options, permission modes,
tool, question and plan mapping, result errors, the model catalog, live
sessions kept between turns, the node's MCP server attached to Claude Code),
the agent credentials of the MCP server plugin (`plugins/mcp-server`), the
Codex agent runtime (`plugins/agent-codex`: the app-server protocol and
handshake, runtime and interaction modes, approval, question, plan, tool and
usage mapping, the status probe and its messages, the model names and
preferred defaults, usage limits and their windows in
`plugins/agent-codex/src/usage-limits.ts`, MCP elicitations in
`plugins/agent-codex/src/elicitation.ts`, thread goals and `/goal` in
`plugins/agent-codex/src/goal.ts`), the goal banner
(`apps/web/src/lib/goal.ts`), an agent's usage limits and the composer's
`/usage-limits` banner (`packages/agent-api/src/usage-limits.ts`,
`apps/web/src/lib/usage-limits.ts`), the OpenCode agent runtime
(`plugins/agent-opencode`: starting and reaching an OpenCode 2 server, its
version probe, session rules, permission, form and tool mapping, usage and
interrupts, reverting and forking a session, its pending requests after a
reconnect), the
terminal plugin (`plugins/terminal`:
loading node-pty, the shell's environment, sizes, scrollback and its
history files, the limit on exited sessions and finding the program a
terminal runs), orchestration (`plugins/orchestration`: the
contracts, rules and messages of delegated tasks, thread launches and their
capabilities, and the script contract of workflows), scheduled tasks
(`packages/scheduler-api`, `plugins/scheduler`: triggers and their next runs,
run bookkeeping, webhook tokens, signatures, prompt placeholders, rate limits
and the delivery log), the browser preview (`plugins/preview` and
`@jhin/preview-api`: the server browser's tabs, their control by agents and
viewers, page operations, snapshots, recordings, viewport presets, URL
normalisation, the tools' wording, the local server scan, the pinned
headless shell, browser profiles and the import of the machine's browser cookies: its sources, key handling, decryption, cookie readers and the import wizard), rendered HTML (`plugins/html-render` and
`@jhin/preview-api`: the page's bootstrap, theme variables and guides, image
inlining, the public proxy, console capture and measuring; the web client's
frame), devices (`plugins/devices`: finding the Android SDK, the device tools'
wording and the Device panel), pairing (`plugins/auth-token`:
pairing codes, the pairing and session endpoints, a device's metadata; the web client's pairing
links, saved nodes in IndexedDB, Authorized clients settings and QR code
component; `packages/qr-code`: the terminal rendering of a QR code;
`apps/jhin`: `jhin pair`, its output, notes and Tailscale Serve flow), secrets (`packages/secrets-api`, `plugins/secrets`: the secret
store's shape, secret requests and their card, one-use secretRefs, their
statuses, lifetime and messages) and the desktop app (`apps/desktop`, `plugins/desktop`,
`packages/desktop-api`: the window and its chrome, the application and context
menus, the notification badge, the update flow, its state machine and its
controls, the nightly release notes, the quit hold and its hint;
`scripts/desktop-release.ts` and `.github/workflows/release-desktop.yml`: the
packaging configuration, signing and the release workflow).
`packages/qr-code/src/qr-code.ts` is Project Nayuki's QR Code generator (MIT,
copyright Project Nayuki) as T3 Code vendors it; its notice is kept in the
file. Files derived from T3 Code say so in a header comment.

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## heic-to

Source: https://github.com/hoppergee/heic-to (npm `heic-to`, LGPL-3.0, built
on libheif). Used unmodified by the web client to convert HEIC and HEIF
images to JPEG before they are attached (`t3-parity.md` D296), as T3 Code
does. It is a separate chunk that the browser loads only when a HEIC image is
attached, so it can be replaced with another build of the library. Its license
text ships with the package (`node_modules/heic-to/LICENSE`).

## selfhst/icons (Azure DevOps mark)

Source: https://github.com/selfhst/icons/blob/main/svg/azure-devops.svg
(CC BY 4.0, https://creativecommons.org/licenses/by/4.0/). The Microsoft Azure
DevOps mark in `apps/web/src/plugins/source-control/forge-icons.tsx`
(`AzureDevOpsIcon`) is adapted from that SVG as T3 Code ships it: turned into
a React component with JSX attribute names, and its gradient ids made unique
per instance (`useId`) so two marks on one page do not share them. Its shapes
and colours are unchanged. "Azure DevOps" is a trademark of
Microsoft, used only to name the forge a repository is on.
