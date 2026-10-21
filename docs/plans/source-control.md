# Source control plan

Status: **implemented** (status, diffs, branches, pull requests, the card's
indicators, the branch toolbar and the diff panel); W3 (checkpoints,
reverting, worktrees, D240–D259) **in progress**: the turn hooks and a
thread's own working directory (D241, D242) are done; git actions (W4 of
`t3-roadmap.md`, D260–D266) **implemented**; linking and watching pull
requests and other forges (D267–D279) **in progress**. This file records how
Jhin reads the git repositories of a node's projects, how the web client
shows them as T3 Code does, what was left out and what is deferred.

## Goal

T3 Code's thread cards show real data: the thread's branch, its diff and its
pull request with its state. Behind them sit source control features: a
project's branch, ahead/behind, uncommitted changes, the diff itself and the
pull request of a branch. Everything is a plugin on the public API, every
operation a command (RPC, CLI, MCP), and the UI is slots and contributions,
so a terminal plugin (or any other) puts its own indicator on the same cards.

## Decisions

### Reference

- **D110. T3 Code nightly `eb7b35ac` (D53) is the reference**:
  `apps/server/src/vcs/GitVcsDriverCore.ts` (how status and diffs are read),
  `packages/source-control-github` (pull requests through `gh`, the check
  rollup), and in `apps/web` the card's branch row in `Sidebar.tsx`,
  `ThreadStatusIndicators.tsx` (the pull request badge), `BranchToolbar.tsx`,
  `BranchToolbarBranchSelector.tsx`, `BranchPicker.tsx`, `DiffPanel.tsx`,
  `DiffPanelShell.tsx`, `chat/DiffStatLabel.tsx`, `chat/ComposerSurface.tsx`
  (the context strip), `ui/middle-truncate.tsx` and `pullRequest/*`. Derived
  files name their origin and are covered by `THIRD_PARTY_NOTICES.md`. T3's
  Effect services, its other forges (GitLab, Bitbucket, Azure DevOps, Forgejo)
  and its GraphQL reads are not ported.

### Server

- **D111. `source-control.git@1`, provided by `jhin.source-control`**
  (`plugins/source-control`, server side). Its contract, the Zod schemas and
  event types, is `@jhin/source-control-api`; the capability id follows the
  `<area>.<interface>` form of the others (`storage.kv`, `agent.runtime`). The
  plugin requires `storage.kv@^1` and `storage.eventlog@^1` and nothing of the
  threads plugin: no capability describes projects, so it reads them with the
  `projects.list` command and follows the node's `threads` index (D57), both
  public API. Until a threads plugin answers (it may activate later), the
  first request reads the projects again. The scratch project (D51) is never
  a repository: its folder lives in the node's home, which may itself sit
  inside one.
- **D112. Commands**, each with Zod input and output, so RPC, CLI and MCP
  reach them (MCP tools `git_status`, …): `git.status` (every project's
  status and every thread's branch, with the stream head they reflect;
  `refresh` reads git and the pull requests again now), `git.thread.status`
  (a thread's branch, whether it is checked out, its pull request and its
  project's status), `git.diff` (a project's or a thread's project's diff:
  `uncommitted` against `HEAD`, or `branch` against the merge base with
  `base`, the default branch by default; each file's status is git's own
  name-status of that diff, so a branch's added and deleted files say so;
  untracked files count as added;
  `ignoreWhitespace`), `git.branches` (local and remote, the current one
  first) and `git.checkout` (a branch, a remote branch as a local one
  following it, or `create` a new one from `HEAD`; `threadId` moves that
  thread to it). Reads need `git.read`, a checkout `git.write`. Errors carry
  codes: `PROJECT_NOT_FOUND`, `THREAD_NOT_FOUND`, `THREAD_PROJECT_MISMATCH`
  (a checkout's `threadId` names a thread of another project; nothing is
  checked out then), `NOT_A_REPOSITORY`,
  `BRANCH_NOT_FOUND`, `BRANCH_INVALID` (also any name starting with `-`, even an
  existing ref, so git never reads a branch name as an option),
  `GIT_FAILED` (git's own refusal, e.g. a checkout that would lose changes,
  with git's message). A status is T3's `VcsStatusResult` shape: branch,
  upstream, ahead/behind, default branch, remote URL, the working tree's files
  (at most 200 listed, totals over all) with insertions and deletions, the
  pull request provider and the pull request of each branch looked up. A
  repository whose read fails is read again on the next request rather than
  kept failing, and in `git.status` it is listed as unreadable
  (`isRepo: false`, "Could not read the repository: …") without failing the
  other projects.
- **D113. A thread's branch is recorded, not guessed.** It is the branch
  checked out in the thread's project when the thread is created, again when
  one of its turns starts (the agent works on what is checked out) and when it
  ends (the agent may have switched), and whatever `git.checkout` with its
  `threadId` switched to. Each of these reads the repository then, not the
  last status: a checkout made a moment before, or with the watcher off or
  past its limit, would otherwise pin the thread to the old branch. The
  record lives in `storage.kv`, so it survives
  restarts; a deleted thread or project drops it. A thread whose branch is no
  longer checked out keeps it (`checkedOut: false`), as T3 keeps
  `thread.branch`.
- **D114. Changes reach clients on the node's `source-control` stream**:
  `source-control.status.changed` (a project's whole status),
  `source-control.project.removed`, `source-control.thread.changed` and
  `source-control.thread.removed`. A status is appended only when it differs
  from the last one (the time it was read aside), so re-reading an unchanged
  repository writes nothing. Clients read `git.status`, then follow the
  stream after its head, as they do with `threads.catalog` (D57).
- **D115. Repositories are watched, not polled.** One non-recursive
  `fs.watch` per directory of the working tree that git does not ignore
  (`git check-ignore`), so `node_modules` and build output cost nothing, plus
  the git directory and its `refs` (checkouts, commits, fetches, pushes); new
  directories are watched as they appear, at most 4000 per repository. Changes
  settle for 150 ms (at most 1 s while writes keep coming) before the
  repository is read again. Untracked files have their lines counted 8 at a
  time in 64 KiB reads (binary decided from the first 8000 bytes, as git
  does), so a tree of generated files costs neither memory nor file
  descriptors. Reads never take the index lock
  (`GIT_OPTIONAL_LOCKS=0`), so they neither fight the user's git nor wake the
  watcher themselves. A turn's end reads the repository too, so a node with
  `watch: false` (or a tree beyond the limit) still shows what a turn changed.
  Turning `watch` off stops the watchers and drops a read still waiting for
  changes to settle; the next request or turn end reads the repository.
- **D116. Pull requests through the GitHub CLI**, as T3's
  source-control-github reads them: `gh pr list --head <branch> --state all
  --limit 1 --json number,title,url,state,isDraft,headRefName,baseRefName,updatedAt,statusCheckRollup`
  in the repository, for remotes whose host is in `githubHosts`
  (`github.com`). Checks roll up as T3 rolls them up: failing if any failed or
  was cancelled, pending if any runs or waits for action, passing if any
  passed. The branches looked up are the checked-out one and the threads'
  branches, never the default branch; answers are kept and read again every
  `pullRequestRefreshSeconds` (60; 0 = only on request). Without `gh`, signed
  out, or failing, the status says so (`provider.available: false` with the
  reason: "GitHub CLI (gh) is not installed on this node", "GitHub CLI is not
  signed in: run `gh auth login` on this node") and pull requests stay
  unknown; the rest of the status is unaffected. `gh` is asked again once a
  refresh period has passed (by the timer or the next change of the
  repository), so a `gh auth login`, or a network that comes back, brings
  the pull requests back without a forced refresh. The `jhin.source-control`
  config section (`watch`, `pullRequestRefreshSeconds`, `githubHosts`,
  `gitPath`, `ghPath`) is edited on the settings page like any other.

### Client

- **D117. The card's indicators are contributions to
  `sidebar.thread.indicators`** (props `ThreadIndicatorProps`: target — node
  and remote member —, thread, project, whether the card is active), rendered
  on the card's last line between where T3 shows the branch and the node's and
  agent's icons. Contributions sit right-aligned unless one takes the free
  width (the branch does). The builtin client plugin `jhin.source-control`
  contributes, in T3's order, `jhin.source-control.branch` (order -100, the
  thread's branch, middle-truncated as T3 does), `jhin.source-control.pull-request`
  (100, T3's badge: the state's icon and tone and the number, linking to the
  pull request; its tooltip names it and its checks) and
  `jhin.source-control.diff` (200, T3's `+12 −3` in the diff colours). A
  terminal plugin takes an order between 0 and 100 to sit where T3 puts its
  terminal icon. The diff count is the uncommitted change of the thread's
  project while the thread's branch is the one checked out: T3 nightly shows
  the latest turn's diff there (`latestRunDiff`, which returns nothing until
  checkpoints exist), which needs checkpoints (Deferred).
- **D118. A node's source control is one feed per target** (`git.status`,
  then the stream after its head), shared by every card and view looking at
  it, dropped when the last one goes. A mesh member reached through a
  connection shares no such stream (only threads are mirrored, D26), so its
  feed reads `git.status` again whenever the member's thread catalog changes
  (a turn that ends, a thread created). A node without the plugin
  (`COMMAND_NOT_FOUND`) shows nothing. A refused subscription or a failed
  load shows as an error and the feed starts over (`git.status`, then the
  stream after its head; answers of the older start are dropped): at once,
  then backing off up to 30 s while it keeps failing.
- **D119. The branch toolbar is T3's strip under the composer**, the new
  slot `chat.composer.context` (props `ChatComposerContextProps`: target,
  thread, project; a draft has only its project). `ComposerSurface.ContextStrip`
  is ported with the composer's cut-out for it; the strip shows while a
  contribution renders something marked `data-composer-context-item`, so a
  project that is no repository has none. `jhin.source-control.branch-toolbar`
  shows the pull request badge and the branch picker: the thread's branch
  (the checked-out one for a draft), a tooltip saying where it stands against
  its upstream ("2 ahead, 1 behind origin/main") or what is checked out
  instead, and T3's picker ("Search refs...", the `current`, `remote`,
  `default` badges, "Create new ref "…"", "Failed to switch ref.").
  Choosing a ref runs `git.checkout` with the thread. T3's environment and
  workspace (local/worktree) selectors are not shown: there is one node per
  thread and no worktrees yet (Deferred). The composer's controls moved to
  `apps/web/src/lib/composer-control.tsx`, shared by the chat and this plugin.
- **D120. The diff panel docks right of the chat** (`app.panel`), open while
  the route's panel is `diff`: the `diff.toggle` client command ("Toggle diff
  panel", `mod+d` outside a terminal, as T3 binds it) and a toggle in
  `chat.header.actions` (`jhin.source-control.diff-toggle`, shown for
  repositories). It is T3's inline panel: the scope menu ("Changes" against
  the default branch, "Uncommitted"), "head → base" for the branch scope, the
  diff's totals, refresh, collapse all, line wrapping, whitespace, and T3's
  empty states ("No net changes in this selection.", "Turn diffs are
  unavailable because this project is not a git repository."). Files render
  as a stacked unified diff parsed on the client (`lib/diff.ts`), each
  foldable; it is read again whenever the project's status changes. T3 renders
  with `@pierre/diffs` (syntax highlighting, split view, file tree,
  comments); that is Deferred.

The proof: `plugins/source-control/test/status.test.ts` (temporary
repositories: a clean status, changes with untracked and binary files, a
project that is no repository, the scratch project inside a repository,
ahead/behind against a pushed upstream, a write on disk and a commit
published on the stream, nothing published when nothing changed, a removed
project; uncommitted and branch diffs; branches, checkouts, invalid and
unknown names, git's own refusal; a thread's branch at creation, at a turn,
through a checkout, read afresh with the watcher off, and forgotten with the
thread; a checkout refusing a thread of another project or none; counting
large and late-NUL files, at most 8 at once; parsing porcelain v2 and
numstat), `test/watch.test.ts` (ignored trees unwatched, new directories
watched, the limit) and `test/github.test.ts` (a fake `gh` on `PATH`: an open
pull request with its checks, merged, closed and draft ones, none, every
thread's branch, `gh` missing and signed out, `gh` asked again a refresh
period after it failed, remotes elsewhere; hosts and
the check rollup); `apps/web/test/source-control.test.ts` (the feed: stream
after the head, starting over after a refused subscription, a node without
the plugin, a mesh member re-read on catalog
changes, a refresh; parsing patches; labels) and
`source-control.browser.test.tsx` (the card's indicators in T3's order, the
pull request link not opening the thread, no diff for a branch not checked
out; the diff panel's files, folding and empty states); Playwright
`e2e/tests/source-control.spec.ts` (a real node with a fake `gh`: branch,
pull request and diff on the card, a file written on disk showing on it, the
diff panel's files and branch scope, switching branches from the toolbar,
with screenshots).

### Checkpoints, reverting and worktrees (W3, `t3-roadmap.md`)

- **D240. Reference: T3 Code `eb7b35ac` (D53)**: `apps/server/src/vcs/GitVcsDriver.ts`
  (the checkpoint operations), `checkpointing/CheckpointDiffQuery.ts` and `Diffs.ts`,
  `orchestration-v2/CheckpointService.ts`, `CheckpointCaptureService.ts`,
  `RunExecutionService.ts` (when checkpoints are taken), `CheckpointRollbackService.ts`
  and `CheckpointRestoreSafety.ts` (reverting), `vcs/GitVcsDriverCore.ts` (worktrees,
  fetching from origin), `worktreesDirectory.ts`, `ThreadLaunchService.ts` (the
  workspace strategy), `mcp/toolkits/worktree/*` (handing a thread over), and in
  `apps/web` `DiffPanel.tsx` (the turn scopes), `chat/ChangedFilesTree.tsx` and
  `MessagesTimeline.tsx` (the changed files card, "Edit from here"),
  `BranchToolbar*.tsx` (the workspace selector), `ThreadStatusIndicators.tsx` (the
  worktree icon) and `worktreeCleanup.ts`. T3's setup scripts and their progress
  card, branch names generated from the first message, cleanup rules, submodules
  and nested checkpoint scopes (subagents) are not ported (Deferred).
- **D241. `jhin.threads` has public hooks around a turn** (`ThreadHooks` in
  `@jhin/agent-api`, next to the existing `threads.title`): `threads.turn.start`
  runs once `agent.turn.started` is recorded and before the agent starts, with
  `TurnHookInput` (thread, project, turn, agent and the `cwd` the agent runs in);
  a hook that throws fails the turn with its error and the agent never starts.
  `threads.turn.end` runs once the agent is done or given up on, before the
  turn's last event is recorded, with the same input and how the turn ends
  (`completed`, `interrupted`, `failed`); a hook that throws is logged and the
  turn still ends. A client that sees a turn end therefore sees what the end
  hooks did (a checkpoint). The hooks hold the thread like the rest of the turn
  (a stop waits for them, so archiving or deleting a thread may wait up to a
  stuck hook's deadline instead of `STOP_TIMEOUT_MS`; the node's shutdown
  drain stays bounded by its own 5 s), but at most `turnHookTimeoutSeconds`
  (a `jhin.threads` setting, 60 s by default; 0 gives hooks no time): a start hook that has not answered by then fails
  the turn like one that throws (the agent never works without what the hooks
  do first), an end hook is logged and the turn ends; a stop that gives up
  meanwhile records no second end. A hook given up on is not cancelled (hooks
  get no abort signal, so their input stays serialisable): one whose work may
  overlap the thread's next turn keeps it apart itself.
- **D242. A thread may have a working directory of its own** (`worktreePath`, T3's
  field): an existing absolute directory, usually a git worktree of its project,
  set with `threads.create` or `threads.update` (`null` clears it; a running turn
  keeps the directory it started in). It is stored by its real path and, like
  `projects.create`'s path, may be any directory the node can read: whoever holds
  `threads.write` may point a thread's agent anywhere, as they may make any
  folder a project (scoped permissions are W13's). Its turns run there:
  `TurnRequest.cwd` is `worktreePath ?? project.path`, so every runtime of
  `agent.runtime@1` runs in it without a change (Claude Code's live session
  restarts when its directory changes, and a session it cannot resume there
  continues from the thread's transcript, D91). A turn whose directory is gone
  fails before the agent starts ("The thread's worktree … no longer exists"),
  after the start hooks had their chance to bring it back (D256).

#### Checkpoints

- **D243. A checkpoint is a commit of the whole working tree under
  `refs/jhin/checkpoints/<threadId>/<n>`**, `n` the thread's turn count: `0` before
  its first turn, `N` after turn `N` (T3's ordinals). It is written as T3 writes
  it, never touching the user's index, `HEAD` or branch: a scratch index
  `<git-common-dir>/jhin-checkpoint-index-<uuid>` (`GIT_INDEX_FILE`), `read-tree
  HEAD`, `add -A -- .` (untracked files in, ignored ones out), `write-tree`,
  `commit-tree -p HEAD -m "jhin checkpoint ref=<ref>"` as "Jhin"
  (`jhin@users.noreply.github.com`), `update-ref`, with T3's index guards
  (`core.fsmonitor=false`, `core.splitIndex=false`, …) and fsync flags; the scratch
  index is removed afterwards. Refs under `refs/jhin/` are never pushed, never
  listed as branches and keep the commits from `git gc`. Checkpoint operations run
  one at a time per working directory. T3's fast path (reusing the real index)
  and sparse-checkout handling are not ported.
- **D244. When**: the source control plugin hooks the turn (D241). At a turn's
  start, the checkpoint `N-1` is written if it is missing (normally the previous
  turn's end wrote it; the first turn writes `0`). At its end, a turn that
  completed or was interrupted writes `N`; a failed one writes nothing, and the
  next turn writes its own start. `N` counts the thread's turns as the plugin saw
  them start. A project that is no repository (or the scratch project) records
  the turn as `missing`; a write that fails records `error` and is logged; neither
  ever fails the turn. Checkpoints are taken in the turn's `cwd`, so a worktree
  thread's checkpoints live in its worktree's repository.
- **D245. A turn's checkpoint record** (`TurnCheckpoint` in
  `@jhin/source-control-api`): thread, turn id, turn count, ref, status
  (`ready`, `missing`, `error`, `stale` once reverted past), the files the turn
  changed (at most 200 listed, totals over all) and when. The files are the
  numstat of `N-1 → N` without what came from `HEAD` moving (T3's
  `listAuthoredPaths`: a pull, a rebase or a checkout the agent ran is not its
  authored change). Records live in `storage.kv`, survive restarts and go with
  their thread; each change is appended to the `source-control` stream as
  `source-control.checkpoint.changed`, and `git.status` returns each thread's
  latest one (`checkpoints`). `git.checkpoints { threadId }` lists a thread's,
  oldest first. The capability becomes `source-control.git@1.1`.
- **D246. Turn diffs**: `git.diff` takes the scope `turn` with `threadId` and
  `turn` (a turn count): the diff of `N-1 → N` of that thread, files filtered as
  in D245, `ignoreWhitespace` as for the other scopes; `fromTurn` widens it
  (`fromTurn → turn`, T3's full thread diff is `0 → N`). A turn without a ready
  checkpoint answers `CHECKPOINT_UNAVAILABLE` ("Turn N has no checkpoint").
- **D247. The diff panel offers T3's turn scopes**: the scope menu reads
  "Changes", "Uncommitted", "Latest turn" and the submenu "Turn" with "Turn N"
  items, newest first, each with its time; the trigger says "Latest turn" or
  "Turn N" for a turn. A thread without checkpointed turns shows "No completed
  turns yet."; loading a turn shows "Loading checkpoint diff...". The panel
  follows the thread's checkpoints, so "Latest turn" moves on when a turn ends.
- **D248. Under a turn that changed files, T3's changed files card**: "N changed
  file(s)", `+A -D`, the files as a folder tree ("Expand all folders" /
  "Collapse all folders" when there are folders) and "Open diff" (tooltip "Open
  the full diff"); a file or "Open diff" opens the diff panel on that turn. The
  card is the contribution `jhin.source-control.changed-files` to the new slot
  `chat.turn.footer` (props `ChatTurnFooterProps`: target, thread, turn id, its
  state), rendered after a turn's answer, so any plugin can put something under
  a turn.
- **D249. The card's diff count is the thread's latest turn** (T3's
  `latestRunDiff`, a stub in `eb7b35ac`): the `+A −D` of the latest checkpointed
  turn of the thread, nothing when it changed nothing. A thread without
  checkpoints keeps D117's count (its directory's uncommitted changes while its
  branch is checked out).

#### Worktrees

- **D250. Worktrees live under `<jhin home>/worktrees/<repository>/<branch>`**
  (`/` in the branch becomes `-`; T3's `~/.t3/worktrees`), or under the
  `worktreesDirectory` setting of `jhin.source-control` (absolute, `~` expanded,
  not a filesystem root). Commands: `git.worktree.create { projectId, baseRef,
  branch?, startFromOrigin? }` runs `git worktree add -b <branch> -- <path>
  <start>`, `<branch>` defaulting to T3's temporary `jhin/<8 hex>` (`jhin-<8 hex>`
  when a branch `jhin` exists); with `startFromOrigin` (and an `origin`) it first
  runs `git fetch --quiet -- origin +refs/heads/<base>:refs/remotes/origin/<base>`
  and starts from `origin/<base>` when that exists. `git.worktree.remove {
  projectId, path, force? }` (`git worktree remove`, an already missing one is
  pruned) and `git.worktree.list { projectId }` (`git worktree list
  --porcelain`). Errors: `BRANCH_EXISTS`, `BRANCH_INVALID`, `WORKTREE_INVALID`,
  `GIT_FAILED`. `git.write` for the first two, `git.read` for the list.
- **D251. A worktree thread's source control is its worktree's.** The plugin
  follows every directory a thread works in: the thread's branch (D113) is read
  there, and each worktree in use has its own status, appended as
  `source-control.worktree.changed` (a `ProjectStatus` with `worktreePath`) and
  `source-control.worktree.removed`, listed in `git.status` as `worktrees`.
  `git.diff`, `git.branches` and `git.checkout` with a `threadId` act on the
  thread's directory. Older clients ignore the new events.
- **D252. `threads.create` takes T3's `workspace`** (`ThreadLaunchService`'s
  strategy, as W10's launch passes it): `{ type: "root" }` (the default),
  `{ type: "worktree", baseRef, branch?, startFromOrigin? }` (the threads plugin
  runs `git.worktree.create` and records the new path; without a source control
  plugin it answers `WORKSPACE_UNSUPPORTED`) or `{ type: "existing_worktree",
  worktreePath, branch? }`. `branch` checks that branch out in a new worktree, or
  names the existing worktree's. The thread's branch stays the source control
  plugin's record (D113), not a field of the thread.
- **D253. The branch toolbar gets T3's workspace selector** (`aria-label
  "Workspace"`): "Current checkout" (or "Current worktree"), "New worktree" and,
  when another thread of the project has one, "Previous worktree" with its
  branch. With "New worktree" the branch picker picks the base ("From <ref>",
  `origin/<ref>` with "Start from origin") and its footer has T3's switch "Start
  from origin" (tooltip "Creates the worktree from the latest matching branch on
  origin instead of your local branch."). After the first message the selector
  is a fixed label: "Local checkout", "Worktree". The draft's first send creates
  the thread with that `workspace` through the new client hook `thread.create`
  (D252); the chat's thread start runs it.
- **D254. A worktree thread's card shows T3's worktree icon**
  (`jhin.source-control.worktree`, order -50 in `sidebar.thread.indicators`):
  `FolderGit2`, tooltip "Worktree: <folder> (<branch>)".
- **D255. Deleting a thread offers to delete its worktree**, as T3 asks: when no
  other thread works in it, "This thread is the only one linked to this
  worktree:\n<folder>\n\nDelete the worktree too?"; the thread is deleted first,
  then the worktree is removed with `force`; a failure shows "Failed to delete
  worktree" ("Could not remove <folder>. <reason>"). It runs through the new
  client hook `thread.delete` around the thread actions' delete.
- **D256. Handing a thread over to a worktree**: `git.worktree.handoff {
  threadId, branch?, baseRef?, startFromOrigin? }` creates a worktree (base: the
  branch checked out in the project; detached → "Could not determine the current
  branch of the project workspace (detached HEAD?). Pass baseRef explicitly.")
  and moves the thread there; it refuses a thread already in a worktree ("Thread
  '<id>' is already attached to worktree '<path>'.", `ALREADY_IN_WORKTREE`), an
  archived one and a project that is no repository. Called by an agent during its
  turn (MCP tool `git_worktree_handoff`), the turn finishes where it started and
  the next one runs in the worktree. A thread's managed worktree (one under the
  worktrees directory) that is gone is created again from its branch when the
  thread's next turn starts (T3's "provider turn start recreating missing
  worktree").

#### Reverting

- **D257. Reverting to a turn** (T3's "Edit from here" on a user message, built on
  W2's drop of later turns): the dialog "Edit from here?" ("Rewind chat to before
  this message. Your prompt and attachments return to the composer.", Cancel,
  "Revert files too", "Revert and keep changes"), refused while the thread runs
  ("Interrupt the current turn before reverting checkpoints."). Reverting drops
  the turns from that message on (W2), restores the files of checkpoint `N-1`
  when asked, deletes the later checkpoint refs and marks their records `stale`.
- **D258. Restoring files** is T3's: `git restore --source <checkpoint>
  --worktree --staged -- .`, `git clean -fd -- .`, `git reset --quiet -- .`
  (`HEAD`, the branch and ignored files untouched). Only a thread in a worktree no
  other thread works in may restore files; otherwise it fails with T3's "File
  restore requires an isolated worktree. This workspace may contain changes from
  another thread. Rewind the conversation without restoring files instead."
- **D259. The agent's own session goes back too**: a runtime that can rewind its
  conversation does it when its thread is reverted (Claude Code: a new session
  for turn 0, otherwise resuming at the target turn's last answer); others start
  the next turn from the thread's transcript (D91).

### Git actions (W4, D260–D266)

- **D260. The reference for git actions is T3 Code `eb7b35ac` (D53)**:
  `apps/web/src/components/GitActionsControl.tsx` and `.logic.ts` (the quick
  action, its menu, the dialogs and toasts), `apps/server/src/git/GitManager.ts`
  (`runStackedAction`), `apps/server/src/vcs/GitVcsDriverCore.ts` (staging,
  pushing, pulling), `packages/shared/src/git.ts` (feature branch names) and
  `packages/provider-core/src/server/textGenerationPrompts.ts` (the prompts).
  T3 renders the control in its thread details panel at D53 and in the chat
  header in its `toolbar` presentation; Jhin has no thread details panel yet,
  so it is the toolbar presentation.
- **D261. `git.action.run`** (`git.write`) runs one of T3's stacked actions,
  `commit`, `push`, `create_pr`, `commit_push`, `commit_push_pr`, in a project
  or a thread's project: a feature branch (`featureBranch`, commit actions
  only), the commit, the push and the pull request, each only when the action
  includes it (`create_pr` pushes first when the branch has no upstream of its own
  name or is ahead; a pull request from the default branch is refused before
  anything is committed), stopping at the first failure. As in T3: the commit takes every
  change (`git add -A`) or only `filePaths` (staged, then committed with
  `--only`, so whatever else the user staged stays staged);
  what it would hold is read through a temporary index, so the user's own
  staging is untouched until the commit; `commitMessage`'s first line is the
  subject; a push goes to the branch's own name on its push remote
  (`branch.<b>.pushRemote`, `remote.pushDefault`, `origin`, the first remote)
  with `-u` when it has no upstream, never with force, and a branch cut from
  another (`origin/dev`) gets its own remote branch and
  `branch.<b>.gh-merge-base`; a pull request goes into `gh-merge-base`, else
  the upstream's other branch, else the default branch, else `main`; an open
  one for the branch is opened instead of created. The result is T3's
  (`branch`, `commit`, `push`, `pr` with their statuses, and the toast: title,
  description, call to action "Push", "View PR" or "Create PR"). Errors carry
  `ACTION_UNAVAILABLE` (T3's messages: "Cannot push from detached HEAD.",
  "Cannot create a feature branch because there are no changes to commit.",
  "Cannot push because no git remote is configured for this repository.", …),
  `GIT_FAILED` (git's own refusal, a commit hook's included) and
  `PULL_REQUEST_FAILED` (the forge's). Actions, pulls and checkouts of one
  project run one at a time, so none moves `HEAD` under another; a failure
  before the first step still ends the action's progress with `action_failed`. A thread named with `threadId` is moved to a branch the action
  created; a feature branch whose commit fails is undone (back on the branch
  it came from, the changes kept). A pull request whose base would be its own
  branch (no default branch known) is refused. A commit hook's output is
  published whole line by line, at most 200 lines per action. `git.pull` pulls fast-forward only ("Pulled", "Already up to
  date"); `git.init` makes a project's folder a repository (T3's "Initialize
  Git"). `source-control.git` becomes 1.1 (`runAction`, `pull`).
- **D262. Commit messages and pull requests are written by an agent of the
  node**, as T3 writes them with its text generation: T3's prompts, in a turn
  of its own (no thread history, every tool call declined, in an empty folder of its own, since the
  prompt carries the repository's diff and template) of the
  `writerAgent` (config), else the thread's agent, else the first available
  runtime of `agent.registry@1`; the answer's JSON (`subject`, `body`,
  `branch`; `title`, `body`) is sanitized as T3 does (one line, no trailing
  period, 72 characters). Unlike T3, an agent that is missing, fails or
  answers no JSON, or takes longer than `writerTimeoutSeconds` (120; its
  turn is interrupted), does not fail the action: a plain writer names the files
  ("Update greet.ts", "Update 3 files") and lists the commits under T3's
  "## Summary" and "## Testing" headings. A repository's pull request
  template (`.github/pull_request_template.md` and GitHub's other places, read
  at the base) is handed to the writer. What would be committed goes to that agent as
  T3 sends it: every change git does not ignore, untracked files included,
  so a secret file that is neither ignored nor excluded from the commit
  reaches the agent too.
- **D263. Progress is a live stream**, `source-control/actions`
  (`rpc.streams@1`, `git.write`: a hook's output may hold secrets): T3's `GitActionProgressEvent` as
  `source-control.action.progress` events (`action_started` with its phases,
  `phase_started` with T3's labels "Preparing feature branch...",
  "Generating commit message...", "Committing...", "Pushing...",
  "Preparing PR...", "Generating PR content...", "Creating pull request...",
  `hook_output` with each line a commit hook prints, `action_finished`,
  `action_failed`), under the `actionId` the client chose. The node keeps the
  last 500; nothing survives a restart. A mesh member's live streams are not
  mirrored (W17), so its actions show "Starting source control action..."
  until they end.
- **D264. A status says what the actions need**: `aheadOfDefault` (commits the
  default branch lacks, 0 on the default branch; T3's `aheadOfDefaultCount`)
  and `hasPrimaryRemote`, both optional. Without an upstream the client counts
  `aheadOfDefault` as ahead, as T3 does.
- **D265. The control is the contribution `jhin.source-control.git-actions`
  to `chat.header.actions`** (order -100, before the diff toggle), for a
  thread or draft of a repository: T3's quick action ("Commit, push & PR",
  "Commit & push", "Push & create PR", "Create PR", "Pull", or a disabled one
  whose popover says why), the menu "Git action options" (Commit, Push,
  Create PR, each disabled with T3's reason), the "Commit changes" dialog
  (branch, files with their counts, "Edit" to exclude files, the optional
  message, "Commit on new branch", "Commit"), T3's default branch dialog
  ("Commit & push to default ref?", "Check out feature branch & continue"),
  the running action's phase, its elapsed time and a hook's last line on the
  button, and the result as a toast with its call to action ("Action
  failed" on failure). A project that is no repository shows "Initialize Git".
- **D266. What is not ported**: T3's "Publish repository" (creating the
  repository on a forge; the quick action says "Add an "origin" remote before
  pushing." instead), its writing style settings (Conventional Commits, custom
  instructions, the repository's conventions), the thread details panel's
  presentation and opening a changed file in an editor from the commit dialog
  (Deferred).

The proof: `plugins/source-control/test/actions.test.ts` (temporary
repositories pushing to a bare one and a fake `gh`: a commit with a message,
only some files, a written message, commit and push with an upstream and its
progress on the live stream, a refusing commit hook and its output, a
feature branch named after the changes moving the thread, the refusals, an
up-to-date push, commit, push and pull request with "View PR" and opening the
existing one, a branch cut from `dev` targeting `dev` with the template, a
refused pull request, pull, `aheadOfDefault`; branch names, messages,
upstreams, the writer's JSON and plain messages);
`apps/web/test/source-control.browser.test.tsx` (the quick action, the
result toast, the default branch dialog going to a feature branch, a disabled
quick action, "Initialize Git"); Playwright `e2e/tests/git-actions.spec.ts`
(a real node: the menu, the commit dialog, committing, pushing and creating a
pull request that then shows on the card, with screenshots).

## Deferred

- **Checkpoints and per-turn diffs** (T3's "Latest turn" and "Turn N"
  scopes, the card's latest-run diff): a snapshot of the working tree when a
  turn starts and ends (a commit of a temporary index under
  `refs/jhin/checkpoints/<thread>/<turn>`, as T3's CheckpointStore keeps
  them), taken through the turn hooks of D241 (W3, D243–D249).
- **Reverting to a turn**: restoring a checkpoint into the working tree and
  truncating the thread after it; needs checkpoints first, and a thread
  operation to drop later turns (threads are append-only today).
- **Worktrees per thread** (T3's "New worktree" workspace mode, the
  workspace selector, "Start from origin", worktree cleanup): needs a thread
  to carry a working directory of its own and the agent runtimes to run in
  it (`agent.runtime@1.1` gets the project's directory).
- Linking pull requests to threads (`git.pr.linked`, D34), several pull
  requests per thread and stacks; watching a pull request (W4, D267–D279, in
  progress).
- Git actions (D266): T3's "Publish repository", writing style settings, the
  thread details panel and opening a file from the commit dialog. Writer
  turns go through `agent.runtime@1`'s `startTurn` under a throwaway thread
  id, so a runtime that keeps live sessions (Claude Code) keeps one for it
  until its idle time ends; a one-shot text generation operation of the
  runtime would avoid it (W9).
- Cancelling a running git action: writes to a project queue behind it (its
  writer is bounded by `writerTimeoutSeconds`, a commit's hooks by ten
  minutes), with no way to stop it from the client.
- Other forges (GitLab, Bitbucket, Azure DevOps, Forgejo), GitHub
  Enterprise hosts beyond `githubHosts`, and forks: `gh pr list --head`
  matches the branch name only, so a same-named branch of a fork can match.
- The diff panel's syntax highlighting, split view, file tree, comments and
  opening a file in an editor (T3 renders with `@pierre/diffs`); the base ref
  picker of the "Changes" scope.
- Live source control of mesh members: their `source-control` stream is not
  mirrored (D26); clients re-read it when the member's thread catalog
  changes. Mirroring it needs the mesh to share a stream it does not know.
- Trimming the `source-control` stream: statuses are appended only on change,
  but `storage.eventlog@1` has no truncation, so the history only grows.
- Settling a thread on a merged pull request (T3's sidebar), the card's
  branch-mismatch warning (T3's tooltip "You're currently checked out on
  another branch.") and the terminal indicator (the terminal plugin
  contributes it to `sidebar.thread.indicators`).
- Scoped permissions. Done in `security.md` (D410–D416): a device token
  holds `git.read` or `git.write` only when granted (`git.*` for both), and
  the `source-control` stream needs `git.read` (D415).
