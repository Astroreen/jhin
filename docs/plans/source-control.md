# Source control plan

Status: **implemented** (status, diffs, branches, pull requests, the card's
indicators, the branch toolbar and the diff panel). This file records how
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
  `base`, the default branch by default; untracked files count as added;
  `ignoreWhitespace`), `git.branches` (local and remote, the current one
  first) and `git.checkout` (a branch, a remote branch as a local one
  following it, or `create` a new one from `HEAD`; `threadId` moves that
  thread to it). Reads need `git.read`, a checkout `git.write`. Errors carry
  codes: `PROJECT_NOT_FOUND`, `THREAD_NOT_FOUND`, `THREAD_PROJECT_MISMATCH`
  (a checkout's `threadId` names a thread of another project; nothing is
  checked out then), `NOT_A_REPOSITORY`,
  `BRANCH_NOT_FOUND`, `BRANCH_INVALID` (also any name starting with `-`),
  `GIT_FAILED` (git's own refusal, e.g. a checkout that would lose changes,
  with git's message). A status is T3's `VcsStatusResult` shape: branch,
  upstream, ahead/behind, default branch, remote URL, the working tree's files
  (at most 200 listed, totals over all) with insertions and deletions, the
  pull request provider and the pull request of each branch looked up.
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

## Deferred

- **Checkpoints and per-turn diffs** (T3's "Latest turn" and "Turn N"
  scopes, the card's latest-run diff): needs a snapshot of the working tree
  when a turn starts and ends (a commit of a temporary index under
  `refs/jhin/checkpoints/<thread>/<turn>`, as T3's CheckpointStore keeps
  them), taken before the agent starts. That needs a hook in `jhin.threads`
  around a turn's start (none is public today) and its events per turn.
- **Reverting to a turn**: restoring a checkpoint into the working tree and
  truncating the thread after it; needs checkpoints first, and a thread
  operation to drop later turns (threads are append-only today).
- **Worktrees per thread** (T3's "New worktree" workspace mode, the
  workspace selector, "Start from origin", worktree cleanup): needs a thread
  to carry a working directory of its own and the agent runtimes to run in
  it (`agent.runtime@1.1` gets the project's directory).
- **Git actions** (T3's GitActionsControl: commit, push, create a pull
  request, stacked actions) and linking pull requests to threads
  (`git.pr.linked`, D34), several pull requests per thread and stacks.
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
- Scoped permissions: `git.read` lists every project's repository root and
  remote, and `git.write` checks branches out; every token holds `*` today
  (as for `projects.browse`, `t3-parity.md` Deferred).
