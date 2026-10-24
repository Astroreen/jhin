# Source control plan

Status: **implemented** (status, diffs, branches, pull requests, the card's
indicators, the branch toolbar and the diff panel); W3 (checkpoints,
reverting, worktrees, D240–D259) **implemented**: the turn hooks and a
thread's own working directory (D241, D242), checkpoints, turn diffs, the
changed files card and the card's latest turn (D243–D249), worktrees per
thread with the workspace selector, handoff and clean-up (D250–D256) and
reverting to a turn (D257–D259); git actions (W4 of
`t3-roadmap.md`, D260–D266), linked pull requests (D267–D270), watching them
(D271–D274) and other forges (D275–D279) **implemented**. This file records how
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
  foldable; it is read again whenever the project's status changes. W5
  (D280–D289) replaces the rendering with T3's `@pierre/diffs`.

### Diff panel (W5 of `t3-roadmap.md`)

- **D280. The diff panel renders with `@pierre/diffs`, as T3 does**
  (`@pierre/diffs` 1.5.2 and `@pierre/trees` 1.0.0-beta.6, the versions T3
  pins at D53; both Apache-2.0). Ported from T3: `DiffPanel.tsx` (the header
  and the body), `diffs/StyledDiffCodeView.tsx` (Pierre's virtualized
  `CodeView` with T3's stylesheet and item metrics),
  `DiffWorkerPoolProvider.tsx` (highlighting in a shared pool of Web Workers
  with the Oniguruma engine, ended 30 s after the last panel closes),
  `lib/diffRendering.ts` (parsing the patch, file identities and versions,
  the surface's colours from the app's `--code-background` and
  `--diff-addition`/`--diff-deletion`) and `DiffFilePathCopyButton.tsx`. Files
  are syntax highlighted in Pierre's light or dark theme, following the app's
  `dark` class; each has T3's header (the change icon, the name, "Copy path",
  the counts) and folds from its chevron or by clicking the header. A patch
  Pierre cannot parse shows raw, as T3 does ("Unsupported diff format.
  Showing raw patch."). `lib/diff.ts` stays for nothing else and goes.
- **D281. Split view, line wrapping, whitespace and folding follow T3's
  settings**: the header's segmented "Stacked diff view" / "Split diff view"
  toggle, "Enable line wrapping" and "Hide whitespace changes". Their defaults
  are the client config section `jhin.diff` (kept on the device), shown in
  the settings page's Behavior section as T3's rows ("Word wrap", "Hide
  whitespace changes", "Default diff file state", "Diff layout"): `layout`
  (`stacked`; the toolbar toggle writes it, as T3's does), `wordWrap` (true),
  `ignoreWhitespace` (true) and `filesCollapsed` (true: files start folded);
  wrapping and whitespace toggled in the panel last while it is open, as in
  T3.
- **D282. The file tree is T3's `DiffFileTree`** on `@pierre/trees`: "Show
  file tree" / "Hide file tree" in the header (kept on the device under
  `jhin.diffFileTreeOpen`, off by default), a "Files" column with the count,
  "Collapse all folders" / "Expand all folders", git status colours per file,
  empty folders flattened, files in the diff's order. Choosing a file unfolds
  it and scrolls the diff to it.
- **D283. Diff scopes are contributions**, so W3's "Latest turn" and "Turn N"
  plug into the same menu. The client plugin provides `source-control.diff-scopes@1`
  (`DiffScopes` in `@jhin/source-control-api`): `register(provider)` returns
  a disposable; a provider has a stable `id`, an `order`, the `options` it
  offers for a thread or draft (`value`, `label`, an optional `group` that
  becomes a submenu as T3's "Turn" is, an optional `detail` such as a time,
  and `baseRefs` when the base ref picker applies), `subscribe` to say they
  changed, and `load` returning the patch with its totals and refs. The
  panel's menu lists every provider's options in order. The builtin provider
  `jhin.source-control.git` offers "Changes" and "Uncommitted" through
  `git.diff`; `jhin.source-control.turns` (order 10) offers W3's "Latest
  turn" and, in the "Turn" submenu, every turn whose checkpoint is ready, with
  its time. A turn's changed files card opens the panel through the same
  selection, with the file to reveal. The selection is kept per thread (or draft) on the device
  (`jhin.diff-panel.v1`), defaulting to "Changes" as T3 does; a value no
  provider offers any more falls back to the first option. Every scope is
  read again when its project's status changes, when its provider says so,
  on "Refresh diff", and when the window regains focus (T3 refreshes on
  focus).
- **D284. The base ref picker of "Changes" is T3's combobox** next to
  "head → base": "Change comparison target. Currently …", "Search refs...",
  "Automatic" (the default branch), a Branch/Remote column per ref with "Use
  remote version of …" when both exist and "Remote only" when only the
  remote one does, "No matching refs.". Refs come from `git.branches` (local
  and remote, the current branch left out), read when the picker opens. The
  chosen base is kept with the thread's selection and passed to `git.diff`
  as `base`; switching to "Uncommitted" and back keeps it.
- **D285. Comments on lines go to the chat, as T3's review comments do.**
  Revised when built (#111). The first wording planned a client capability
  `chat.composer@1` (`contexts`, `add`, `remove`, `subscribe` per composer),
  T3's context chip per comment in the composer, the comments shown inline in
  the diff with "Delete comment", and the timeline's review comment card.
  Building that meant a second composer API next to W15's
  `chat.composer.insert` and W6's rich composer (#81), both landing at the
  same time; the comment instead goes in as the text T3 itself sends a
  provider without inline context, through the command that exists. The
  chips, the inline comments and the card are Deferred until the composer
  offers contexts. As built:
  Pierre's gutter "+" (or a line range dragged in the gutter) opens T3's
  `DiffCommentAnnotation` under the range, one at a time: "Add a comment…",
  "⌘/Ctrl Enter to send", "Cancel", "Comment"; Escape cancels. "Comment"
  puts the comment into the open composer through W15's client command
  `chat.composer.insert`, as T3 serializes a review comment for a provider
  without inline context: `<review_comment sectionId=… sectionTitle=…
  filePath=… rangeLabel=… startIndex=… endIndex=…>` with the comment and
  the lines as a fenced `diff` (T3's `buildDiffReviewComment` in
  `reviewCommentContext.ts` and `renderReviewComment` in
  `composerContextLegacySend.ts`). Unlike T3, a `<review_comment` or
  `</review_comment` inside the comment or its lines is neutralized (a
  zero-width space, an escaped slash), so the text can neither end the block
  nor fake another. The section is the scope (`Changes`,
  `Turn 2`, …). Without that command (no chat plugin) lines offer no "+";
  with no message box on screen the panel says "No message box to add the
  comment to". A refresh that drops the lines closes the draft with "These
  lines are no longer in the diff". The panel depends on the command's name,
  since W15 offers no capability for the composer; when a `chat.composer@1`
  capability comes, the panel moves to it.
- **D286. Opening a file in an editor**: the server plugin `jhin.editors`
  (`plugins/editors`, in the distribution) provides `host.editors@1`, whose
  contract (T3's `EDITORS` list, `EditorInfo`, the error codes) is in
  `@jhin/host-api`, with the commands
  `editors.list` (the editors found on the node: T3's list — Cursor, VS Code,
  VS Code Insiders, VSCodium, Zed, the JetBrains IDEs, … — looked up on `PATH`
  and in the usual install folders, plus the file manager) and `editors.open`
  (`projectId`, a project-relative `path`, optional `line` and `column`, an
  `editor`; paths outside the project are refused with `PATH_OUTSIDE_PROJECT`,
  an editor not found with `EDITOR_NOT_FOUND`, a start that fails with
  `LAUNCH_FAILED`). The project is found with `projects.list`, as source
  control finds it (D111; a failing projects plugin is reported as it failed);
  a symbolic link that leads out of the project, dangling or not, is outside
  it too. On Windows a `.cmd`/`.bat` launcher (VS Code's, Cursor's)
  starts as one `cmd.exe /d /s /c` line with the launcher and every argument
  quoted (a launcher under `C:\Program Files` included), and a path holding a
  character `cmd.exe` reads as syntax (`"`, `%`, `&`, `|`, `^`, `<`, `>`, `!`)
  is refused with `PATH_UNSAFE`. The file manager opens the file's folder,
  never the file, so no file of a project runs through its default
  application. Each editor is launched with
  T3's argument style (`--goto file:line:col`, `file:line:col`, or
  `--line N file`), detached. Reads need `editor.list`, opening `editor.open`.
  In the diff panel, clicking a file's name opens it in the preferred editor
  (the last one chosen on this device, else the first found, as T3's
  `usePreferredEditor`); its context menu offers "Open containing folder" (the file manager; "Reveal in …" since D922)
  and "Open with" with every editor found. A failure is a toast: "Could not
  open in VS Code" with the path and the node's reason; an editor is
  remembered as preferred only once it opened. A name that opens nowhere
  (no editor, a file outside the project) folds its file as the rest of the
  header does. A failed `editors.list` is not kept: the next view asks again.
- **D287. Paths of a diff are the repository's**: `git.diff` names files
  from the repository root, which may sit above the project's folder. The
  status's `root` and the project's path resolve them as T3's
  `resolveDiffPathForWorkspace` does; a file outside the project's folder
  cannot be opened from the panel (nothing happens, as in T3).
- **D288. The panel's empty states and messages are T3's**: "Select a thread
  to inspect turn diffs.", "Turn diffs are unavailable because this project
  is not a git repository.", "No net changes in this selection.", "No patch
  available for this selection.", the loading skeletons ("Loading
  changes...", "Loading uncommitted changes..."), "Loading code..." while the
  highlighter starts, and the size-limit notice of a truncated patch.
- **D289. The proof** for W5: browser tests of the panel (Pierre's view
  rendering files, the layout toggle, folding, the file tree revealing a
  file, the scope menu with a contributed scope, the base ref picker passing
  `base`, a comment reaching the composer's contexts), unit tests of the
  ported logic (tree entries and updates, base ref choices, review comment
  building and serialization, editor launch arguments, path resolution), the
  `jhin.editors` plugin's tests with a fake editor on `PATH`, and Playwright
  `e2e/tests/source-control.spec.ts` extended with split view, the file tree,
  the base ref picker and a comment sent with a message, with screenshots.

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

### Diff panel leftovers (W22 of `t3-roadmap.md`, D921–D940)

- **D921. Expanding the unchanged lines between hunks**, as T3 does
  (`lib/diffFileContents.ts`): Pierre's `loadDiffFiles` receives a file's
  old and new contents and turns its separators into "expand" rows. The
  server command `git.diff.file` (`git.read`) takes the target and scope of
  `git.diff` (`projectId` or `threadId`, `scope`, `base`, `turn`,
  `fromTurn`) and one file of its patch (`path`, `previousPath`), and
  returns `{ oldContents, newContents }`, as T3's
  `review.getDiffFileContents`: the old side is the file at `HEAD`
  (`uncommitted`) or at the merge base with the base (`branch`), the new side
  the working tree's file. Unlike T3, a turn's diff expands too, both sides
  read from its two checkpoints. What it may read: unlike T3, which reads any
  file of the workspace, only a file the scope's diff lists, with the old
  path the diff gives it, so `git.read` reaches no more of the node than
  `git.diff` shows (no `.git/`, no ignored or unchanged file); and what the
  diff says the file is decides the empty side (none old for an added or
  untracked file, none new for a deleted one), not the caller. Anything else
  is refused with `DIFF_FILE_UNAVAILABLE` ("Diff file '…' is not part of
  this diff."), as are a side above 1 MB, a binary side, and a working tree
  path that leads out of the repository through a linked folder, with T3's
  messages ("Diff file '…' exceeds the 1 MB expansion limit.", "Cannot
  expand binary file '…'.", "Diff file '…' resolves outside the review
  workspace."). A listed link reads as the path it holds, as git diffs it,
  never as the file it leads to. The
  service method is `SourceControl.diffFile` (`source-control.git@1.2`). A
  diff scope offers this through an optional `loadFile` of its
  `DiffScopeResult` (`source-control.diff-scopes@1.1`); both builtin
  providers set it. A scope without it shows no expand rows, as T3's turn
  diffs. The working tree is read when a file is expanded, not with the
  patch, as in T3: a file edited in between expands from its new contents
  until the next read of the diff (on a status change, focus or "Refresh
  diff") brings a patch that matches them.

- **D922. "Reveal in file manager"**, as T3's file context menu
  (`fileContextMenu.ts`, `externalLauncher.ts`'s reveal launch). The file
  manager item of a diff file's context menu reads T3's "Reveal in Finder"
  (macOS), "Reveal in File Explorer" (Windows) or "Reveal in Files" (Linux),
  from the node's kind, and replaces "Open containing folder". `editors.list`
  says which kind the node's file manager is (`revealKind`: `finder`,
  `file-explorer`, `files`; none without a file manager), and `editors.open`
  takes `reveal` with the file manager: macOS runs `open -R <file>`, Windows
  `explorer /select,"<file>"` as one verbatim argument (a path holding a `"`,
  which no Windows file name does, is refused with `PATH_UNSAFE`), and Linux,
  where file managers have no portable "select this file" flag, opens the
  containing folder, as T3 does. Neither runs the file. A node from before
  D922 says no kind: its menu keeps "Open containing folder". A failure is
  T3's toast "Unable to reveal file" with the path and the node's reason. T3's
  WSL reveal through Windows File Explorer is Deferred.

- **D923. T3's file icons** (`pierre-icons.ts`, `PierreEntryIcon.tsx`):
  Pierre's complete icon set with T3's additions (AGENTS.md, pnpm, video,
  C#, Dart, diff, Elixir, Haskell, Java, Kotlin, Lua, PHP, PowerShell, R,
  Scala, TOML, XML), coloured per theme with T3's palette. They live in the
  web client's `lib/` so every place that shows a file uses the same ones:
  the diff panel's file tree takes them as its `icons`, and the changed
  files card draws each file with `PierreEntryIcon` (Lucide's folder and
  file icons for folders and as the fallback, as in T3). T3's icons by MIME
  type (for previews and attachments) come with the surface that needs them.

- **D924. Find in the diff**, as T3 has it at D53: T3's patch of
  `@pierre/diffs` 1.5.2 (`patches/@pierre%2Fdiffs@1.5.2.patch`, applied with
  pnpm's `patchedDependencies`; the web client is bundled at build, so the
  patch ships in the client) adds a find panel to Pierre's code view.
  ⌘/Ctrl F in the diff opens it ("Search", "N results", "1 of N", "No
  results"; typing moves to the first match), Enter and ⇧Enter (and ⌘/Ctrl
  G) move between matches, Escape
  closes it. Matches are found in every file of the diff, folded or not;
  moving to one in a folded file unfolds it (`onRevealSearchMatch`), never
  folding a file. The patch also adds the package exports T3 imports
  (`./types`, `./utils/parsePatchFiles`, `./utils/getFiletypeFromFileName`)
  and a resize hook the panel needs.

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
  `refs/jhin/checkpoints/<threadId>/<n>`**, of the turn's directory (a project
  folder inside a larger repository is snapshotted alone; the rest stays as
  `HEAD` has it, as in T3), `n` the thread's turn count: `0` before
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
  them start. A directory that is no repository (or the scratch project) records
  nothing (T3 records `missing`, which nothing here would read: the panel says the
  project is no repository); a write that fails records `error` and is logged;
  neither ever fails the turn. A start checkpoint that takes longer than the
  `checkpointStartTimeoutSeconds` setting (45 s, below the threads plugin's hook
  deadline) is given up on and the agent starts; that turn records `error`, since
  the start may hold the agent's first edits. A turn whose start checkpoint is missing (its write
  failed, or the directory became a repository meanwhile) records `error`: what
  it changed is unknown, not nothing. Checkpoints are taken in the turn's `cwd`, so a worktree
  thread's checkpoints live in its worktree's repository.
- **D245. A turn's checkpoint record** (`TurnCheckpoint` in
  `@jhin/source-control-api`): thread, turn id, turn count, ref, status
  (`ready`, `error`, `stale` once reverted past, which reverting writes, D257),
  the files the turn
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
  checkpoints, or whose latest one is not `ready` (`error`, `stale`), keeps
  D117's count (its directory's uncommitted changes while its
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
  and starts from `origin/<base>` when that exists (`startedFromOrigin` says
  whether it did; a base named `origin/<x>` is fetched as `<x>`); a folder that
  another branch took (`a/b` and `a-b`) answers `WORKTREE_INVALID`. `git.worktree.remove {
  projectId, path, force?, deleteBranch? }` (`git worktree remove` of a worktree
  the repository lists and no thread works in, else `WORKTREE_INVALID` /
  `WORKTREE_IN_USE`; one gone from disk is pruned) and `git.worktree.list { projectId }` (`git worktree list
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
  worktreePath, branch? }` (a worktree the project's repository lists, on
  `branch` when named, else `WORKSPACE_INVALID`). `branch` checks that branch out
  in a new worktree, or names the existing worktree's. A new worktree whose thread
  then fails to be created (its id existed, the project went) is removed again
  with its branch; a creation repeated under its id (D207) makes none. The
  thread's branch stays the source control plugin's record (D113), not a field
  of the thread.
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
- **D255. Deleting a thread offers to delete its worktree**, as T3 asks: when the
  node made it and no other thread works in it (`git.worktree.list`'s `managed`
  and `threadIds`, not the client's catalog), "Delete the worktree too?" with
  "This thread is the only one linked to this worktree:\n<folder>" and that its
  uncommitted changes are lost and its branch stays; the thread is deleted
  first, then the worktree is removed with `force`; a failure shows "Failed to delete
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
  the next one runs in the worktree. Handoffs of one thread run one at a time,
  so a second one finds it moved. A thread's managed worktree (one under the
  worktrees directory) that is gone is created again from its branch (as git
  still lists it) when the thread's next turn starts (T3's "provider turn start
  recreating missing worktree"); if that fails the turn fails with
  `WORKTREE_MISSING` and git's reason.

#### Worktree leftovers (W21, D901–D920)

- **D901. A new worktree's temporary branch is named from its thread's first
  message**, as T3's `ThreadLaunchService` does: when the first turn of a
  thread starts in its worktree and that worktree is on a temporary
  `jhin/<8 hex>` (or `jhin-<8 hex>`) branch, the plugin asks the writer
  (D266, its agent and `writerTimeoutSeconds`) with T3's branch name prompt in
  the naming mode the settings name (D1126; by default a fragment that
  `sanitizeBranchFragment` cleans, renamed with `git branch -m` to
  `jhin/<fragment>`, or `jhin-<fragment>` after a flat temporary name). A part
  of that name that an
  existing branch is in the way of (the name itself, a branch where a folder
  is wanted, a folder where a branch is wanted) takes `-1` to `-100`, walked
  part by part as T3's `resolveAutoFeatureBranchName` does. The first turn is
  the first one a rollback left, so a dropped first turn hands the naming to
  the next. It runs beside the turn and never holds it up or fails
  it; a writer without an answer keeps the temporary branch (T3 has no
  fallback either), and so does a fork's first turn or a branch the user
  named (one that looks temporary, `jhin/deadbeef`, is still renamed: T3's
  `isTemporaryWorktreeBranch` matches it too), or a branch switched or
  renamed while the writer ran. Every thread in that worktree records the new branch (D113); the
  folder keeps its temporary name, as in T3. A plugin stopped while its writer
  runs renames nothing. There is no switch to turn it off: T3 renames on
  every launch too, and its naming settings have none either (D1126). Two
  threads that share a fresh worktree and start at once both
  try; the second rename fails and is only logged.

- **D902. Checking a pull request out for a thread**, T3's `resolvePullRequest`
  and `preparePullRequestThread`: `git.pr.resolve { projectId, reference }`
  (`git.read`) answers `{ pullRequest }`, and `git.pr.checkout { projectId,
  reference, mode }` (`git.write`) answers `PreparedPullRequest` (`{
  pullRequest, branch, worktreePath, isOnPullRequestHead }`). A reference is a
  number, `#42`, a URL or a head branch, read by the forge's new optional
  `resolve` (GitHub: `gh pr view --json … -- <reference>`); one starting with
  `-` is refused (`PULL_REQUEST_INVALID`), and so is a URL of another
  repository's pull request (its refs are not this one's; T3 would check that
  repository's out), compared by host, owner and name whatever the remote's
  protocol, user or port. A forge without `resolve` answers
  `ACTION_UNAVAILABLE`. The head is fetched from the remote of the pull
  request's own repository (with `origin` a fork, the `upstream` that `gh`
  read it in), else `origin`, else the first remote, or from the fork's remote (one whose configured
  URL is the fork's, else a new one named after its owner, `-1`… when
  taken); when that fetch fails (a head branch that is gone, for one) it
  falls back to `refs/pull/<n>/head` without an upstream, as T3 does, and
  logs a warning. A fork's remote, once added, stays in the repository's
  config even when the checkout then fails, as T3's `ensureRemote` leaves
  it. `local` checks the head branch out in the project's
  checkout (a fork whose head is named like its base as `<owner>/<head>`),
  created or fast-forwarded to the head and tracking it; git failures answer
  T3's "The pull request could not be checked out with git." followed by
  git's own reason. Where T3
  resets the branch hard, Jhin refuses a checkout with changes to tracked files ("Commit or
  stash the changes in the project's checkout before checking a pull request
  out in it.") and a branch with commits the head does not have ("Branch
  '<branch>' has commits that pull request #<n> does not. Push or move them,
  then check it out again."): both would be lost. `worktree` uses the head
  branch, or `jhin/pr-<n>/<head>` for a fork (T3's `t3code/pr-…`): a
  worktree on that branch is reused and fast-forwarded to `refs/pull/<n>/head`
  when clean (`isOnPullRequestHead` says whether it got there); T3's
  fallback to a worktree on the bare head branch is left out, since for a
  fork that is this repository's own branch. The branch checked out in the
  project's checkout is refused with T3's "This PR branch is already checked
  out in the main repo. Use Local, or switch the main repo off that branch
  before creating a worktree thread."; otherwise the branch is made at the
  head (an existing one only when behind, as above) and checked out in a new
  worktree under the worktrees directory (D250), tracking the head; a branch
  made for a worktree that then fails to be created is deleted again.
  Checkouts of one project run one at a time, with its worktrees. The
  thread itself is created by the client with that branch and worktree
  (D252), as T3 fills its draft.

- **D903. T3's "Checkout pull request" dialog** (`PullRequestThreadDialog`),
  in the branch picker of a draft whose repository is on GitHub (not while
  it picks a new worktree's base): a search
  that reads as a pull request (T3's `parsePullRequestReference`: a GitHub
  pull request URL, `gh pr checkout <x>`, `123` or `#123`) puts "Checkout
  pull request" with the reference first in the list, and choosing it opens
  the dialog with that reference. The dialog keeps T3's words (title
  "Checkout pull request", "Resolve a GitHub pull request, then create the
  draft thread in the main repo or in a dedicated worktree.", placeholder "PR
  URL, checkout command, or #42", "Resolving pull request...", the two
  validation messages, the result card "#<n> · <head> to <base>" with its
  state's colour, Cancel / Local / Worktree, "Preparing local..." and
  "Preparing worktree...", Enter for Worktree, no closing while preparing).
  It resolves the reference with `git.pr.resolve` once typing pauses for
  450 ms (a failure shows until the reference is edited, which asks again)
  and checks it out with `git.pr.checkout` (D902); a worktree becomes
  the draft's workspace as an existing worktree (D252's `existing_worktree`,
  the selector's "Previous worktree"), a local checkout keeps "Current
  checkout".

- **D904. A forge shows with its own mark**, as T3's `sourceControlIcon`
  gives it: T3's GitHub, GitLab, Azure DevOps, Bitbucket and Forgejo icons
  (`forge-icons.tsx`; the Azure DevOps one is selfhst/icons', CC BY 4.0, named
  in `THIRD_PARTY_NOTICES.md`), with lucide's pull request mark when a
  repository has no forge. The git actions' pull request items and quick
  action, the branch picker's "Checkout pull request" item and the checkout
  dialog's title show the repository's forge mark instead of a generic one.

- **D905. A changed file of a turn has T3's file context menu**: right-click
  on a file in the changed files card (D248) opens the diff panel's menu
  (D922, `FileContextMenuPopup`): "Reveal in …" with the node's file manager
  and "Open with" each editor found, through `editors.open` with the file's
  path in the project's folder (D287). A file outside that folder, or a node
  with no editors, has no menu, as in T3. Like the diff panel's, the path is
  the project's, not a worktree thread's.

- **D906. T3's `composer.workspace` shortcut**: the client command
  `composer.workspace` (`{ opened }`, false when no draft is shown) opens the
  workspace menu of the draft on screen (D253), with T3's default key
  `mod+shift+x` (`!terminalFocus`), overridable like every keybinding. A
  started thread's fixed label has no menu and does not answer it.

- **D907. T3's `composer.branch` and `composer.previousWorktree`
  shortcuts**: `composer.branch` (`{ opened }`, default `mod+shift+g`) opens
  the branch picker under the composer of a draft or a thread, reading its
  refs as a click does; `composer.previous-worktree` (T3's
  `composer.previousWorktree`, as Jhin's command names are lowercase dotted
  ids; `{ used }`, default
  `mod+shift+l`) has the draft on screen start its thread in the project's
  previous worktree (D253's "Previous worktree") and gives the composer the
  focus back (`chat.composer.focus`), as T3's `usePreviousWorktree` does; it
  answers false for a started thread or a project without one. Both are
  `!terminalFocus`. The toolbar's controls offer themselves to the shortcuts
  while they are on screen (`DraftWorkspaces.offer`, a disposable).

- **D908. Required checks are the gate of a watch's "passed" wake**, as T3's
  `evaluatePullRequestWatch` has it: GitHub's required checks come from `gh
  pr checks <url> --required --json name` (T3 asks GraphQL's `isRequired`),
  read from its JSON whatever it exits with; no output and its "no required
  checks" message mean the branch requires none; any other failure leaves the
  checks unmarked and the watch's "passed" state as it was (`requiredKnown`),
  so a passing gate does not flip to every check and back into a second wake.
  When some are required, only they must finish without failing for "All N
  required checks passed"; an advisory check still running no longer holds
  the wake back. A required check that appears already finished after that
  wake wakes the thread again (`PullRequestWatch.passedChecks`, additive with
  a default), while without required checks a new passed check (a bot's)
  wakes nobody. Failed checks wake as before, required or not. Other forges
  say nothing of required checks: every check is the gate, as before.

#### Worktree setup (W30, D1121–D1140)

- **D1121. A project has T3's scripts**, as T3's `ProjectScript` (`{ id,
  name, command, icon, runOnWorktreeCreate, runOnSettle?, async? }`, icon one
  of play, test, lint, configure, build, debug): `Project.scripts` of the
  threads plugin, absent until set, set whole by the new `projects.scripts.set
  { projectId, scripts }`. A script is a shell command the node types into a
  terminal later, so setting one takes `terminals.write` besides
  `projects.write` (a token that may not run a shell may not save one);
  `projects.update` still only renames. The setup script is the first with
  `runOnWorktreeCreate` (T3's `setupProjectScript`). T3's scripts menu in
  the chat header, its "Add action" dialog and the checked-in `t3.json`
  came with W42 (D1465, D1473, D1474).
- **D1122. A thread's new worktree runs the setup script**, as T3's
  `ThreadLaunchService` with `ProjectSetupScriptRunner` does: `threads.create`
  with a `worktree` workspace passes its `threadId` to `git.worktree.create`
  (additive), which then tracks the thread's setup; an id of a thread that
  exists already, or whose setup still runs, is refused (`WORKTREE_INVALID`),
  so no caller takes another thread's setup or terminal over. Once the worktree is made
  the script is typed into a terminal of the thread (`terminal.sessions@1`,
  terminal id `setup-<script id>`, in the worktree), wrapped as T3
  wraps it (posix, fish or PowerShell, after `$SHELL`) so a sentinel with a
  random token prints its exit code. The wrapper sets `JHIN_PROJECT_ROOT`
  and `JHIN_WORKTREE_PATH` (T3's `T3CODE_*`), `COLORTERM`, `NO_COLOR=1` and
  `FORCE_COLOR=0` inside the script's block, where T3 gives them to the
  terminal: a terminal opened with its own variables would refuse the
  drawer's open of it (`TERMINAL_ENV_MISMATCH`). Output lines, stripped of terminal
  control and of the echoed wrapper, are the stage's tail (T3's last 4, 400
  characters each). A script that exits 0 closes its terminal; one that
  fails keeps it for "Open terminal". The first turn's start hook waits for
  a script with `async: false` (T3's hold of the agent) and fails the turn
  with "Setup script exited with <code>." when it fails; an `async` one (the
  default) runs beside the agent. The wait counts against the threads
  plugin's `turnHookTimeoutSeconds`. A node without terminals skips the
  stage ("no terminals"). An existing worktree (D252, D903) runs none, and
  neither does a handoff (D256). Creating the worktree runs the project's
  saved script with `git.write` (or `threads.write` through
  `threads.create`), as T3 runs it on any launch: the gate is on saving a
  script (D1121), which takes `terminals.write`.
- **D1123. The setup's progress is T3's `WorktreeSetupSnapshot`**
  (`@jhin/source-control-api`): `phase` running, done, failed or cancelled;
  stages `fetch`, `checkout`, `setup-script` and `agent` in that order, each
  pending, running, done, skipped, warning or failed with its times, detail
  and tail; the branch, base, worktree path and script; T3's length limits.
  `fetch` is skipped without `startFromOrigin`; `agent` runs while the first
  turn's start hook holds it. Every change goes out on the live stream
  `source-control/worktree-setup/<threadId>` (`git.read` and
  `terminals.read`: it carries the script's command and output), which keeps
  only the latest snapshot; `git.worktree.setup.get { threadId }` (the same)
  answers it or null. Snapshots live in memory: a restart forgets them,
  where T3 records the finished one on the thread (W42's D1479).
- **D1124. `git.worktree.setup.cancel { threadId }`** (`git.write`, `{
  cancelled }`) stops a running setup: its terminal is closed and the setup
  ends "cancelled", running stages skipped; the agent then starts without
  waiting. T3 also removes the new worktree and hands the first message to
  the local checkout ("Work locally"): W42's D1477. Removing the worktree (D255) cancels its setup; a cancel that
  comes before the script was typed types nothing; deleting the thread
  forgets its setup.
- **D1125. T3's worktree setup card** (`WorktreeSetupCard`, section "Worktree
  setup") shows under the first message of the thread, through the new slot
  `chat.turn.header` (under a turn's message, before its work; props
  `ChatTurnHeaderProps`, `chat.turn.footer`'s with `first` for `latest`): T3's header ("Setting up worktree…", "Worktree
  ready", "Worktree ready, setup script failed", "Worktree setup failed",
  "Worktree setup cancelled") with its total time, a row per stage with T3's
  labels ("Fetch base branch", "Check out files", the script's name for "Run
  setup script", "Start agent"), icon, detail and time, the tail of a running
  or failed script, and "Details" (Branch, Base, Path, Setup), "Open
  terminal" (the setup terminal in the terminal drawer, `terminal.open`) and
  "Cancel" while it runs. Once the agent has started and the setup is over
  it collapses to T3's one summary row.

- **D1126. T3's branch naming settings** in `jhin.source-control`:
  `branchNamingMode` ("Worktree branch naming", T3's `static` "Static
  prefix" by default, `semantic` "Semantic prefix", `custom` "Custom
  instructions"), `branchNamePrefix` ("Branch prefix", default `jhin` for
  T3's `t3`, shown for `static`) and `branchNameInstructions` ("Branch
  naming instructions", shown for `custom`, D481), with T3's descriptions.
  They shape D901's rename as T3's `buildBranchNamePrompt` and
  `formatGeneratedBranchName` do: `static` asks for a fragment and puts the
  prefix's sanitized parts before it (none when the prefix is empty);
  `semantic` asks for a prefix of the model's own (`feat/add-search`) and
  adds none; `custom` asks for the complete name, with the instructions as
  T3's "Additional instructions:", and takes it as it comes (trimmed, a
  valid branch name, no `-1` suffixes, T3's `exactName`); a taken name is
  refused with `BRANCH_EXISTS`, logged, and the temporary branch stays. The fragment
  modes walk around taken names as D901 does; a prefix that is itself a
  branch (the case of a flat temporary `jhin-<hex>` name) joins with `-`
  instead of `/`, as D901's flat rename did. T3 has no setting that turns
  the rename off, so Jhin has none either (D901's "off switch" is dropped).
- **D1127. A message's attachments go to the branch name prompt** as T3's
  "Attachment metadata:" lines (`- <name> (<type>, <size> bytes)`), read
  from the first message's `input.attachments`. Only their names reach the
  writer, not the images, so T3's rule "If images are attached, use them as
  primary context" is left out of the prompt until they do (Deferred).

- **D1128. T3's worktree cleanup rules** in `jhin.source-control`'s
  `worktreeCleanup` group, all off by default as in T3: `onDelete` ("Delete
  worktrees with deleted threads"), `afterDays` ("Delete inactive
  worktrees", days or none), `settledAfterDays` ("Delete settled
  worktrees", 0 at the next cleanup), `onMerge` ("Delete merged
  worktrees"), `unchanged` ("Delete unchanged worktrees") and `keepWhen`
  ("Keep worktrees with local changes": "Any local files", "Uncommitted
  changes" by default, "Edited tracked files"), with T3's descriptions.
  T3's per-project override ("Inherit", "Off", "Custom") is W42's D1468.
- **D1129. A cleanup sweep applies them**, T3's `cleanWorktrees`: when
  the plugin starts and every hour after, when the group changes, after a thread is deleted while `onDelete`
  is on, and on `git.worktree.cleanup {}` (`git.write`), which answers T3's
  report (`entries` of `{ path, threadId?, outcome: removed | kept |
  failed, reason }` and `counts`). It looks only at managed worktrees (D250)
  that a thread works in, or that a thread deleted on this node worked in
  alone while `onDelete` was on (kept in the plugin's store with its project
  and branch; one deleted with the rule off was the user's to decide, D255). A
  worktree is kept, saying why in T3's words, when it is gone, shared by
  several threads, a thread there runs ("thread is running or has pending
  work") or, for the commit rules (`unchanged`, `onMerge`), has not had its
  first turn yet ("thread has not started yet"), a terminal of the node
  works in it ("open terminal"), its branch
  is no longer the thread's ("repository or branch changed"), or it has
  local changes as `keepWhen` counts them (T3's `git status
  --porcelain=v1` and, for any local files, ignored files other than
  `node_modules`). Otherwise it goes when its thread was deleted
  (`onDelete`), was inactive for `afterDays` (its last update), has been
  settled for `settledAfterDays`, has no commits beyond the default branch
  (`unchanged`, `merge-base --is-ancestor` with `origin/<default>` after a
  fetch, else the local default branch) or a linked pull request of that
  branch merged into the default branch with the worktree still at its head
  commit, or with its commits in it (`onMerge`, T3's
  `storageCleanupPullRequestMerged`; the head commit is the pull request's
  `headSha`, which GitHub and GitLab tell; without it only the commits in
  the default branch count, so work made after the merge never goes).
  Removal is `git worktree remove --force`, under the project's worktree
  lock and after the threads there are read again (T3's
  `blockedSinceCheck`: one that came in or started a turn since keeps it); the
  branch and the thread stay, and a thread's next turn makes the worktree
  again from its branch (D256), as in T3.
- **D1130. With `onDelete` on, deleting a thread asks nothing** (T3's
  `useThreadActions`): `git.worktree.list` answers `cleanupOnDelete`
  (additive) and the client hook of D255 skips "Delete the worktree too?",
  the sweep removing the worktree instead.

- **D1131. A watched pull request keeps its thread "Waiting"**, as T3's
  pending background work (`pullRequestWatchTasks`): the new client
  capability `client.thread-work@1` (`@jhin/client-api`, provided by
  `jhin.thread-work`) joins the work plugins report per thread
  (`ThreadWorkTask`: T3's task id, description and kind); source control
  reports "Watching pull request #N" (`monitor`) for each watched link.
  The sidebar shows a thread whose latest turn neither runs nor asks
  anything, and that has work holding its completion (T3's
  `backgroundWorkHoldsCompletion`: all but `command`), as "Waiting" with
  T3's `CircleDotDashed` icon, also after a failed turn (T3's order: its
  background-work Waiting comes before Failed, and the watch wakes the
  thread on its next news); it recedes like a working thread and, with
  the Working section on, sits there instead of the inbox. W32's
  background subagent work can report through the same capability.
- **D1132. A wake notifies as any turn does.** A watch wakes its thread
  with a message (D271), whose turn ends with the chat's completion
  notification; T3 has no notification of its own for a wake (at D53 its
  `threadNotifications` know completion and input only), so neither has
  Jhin.

- **D1133. A thread's linked pull requests decide its settling**, as T3's
  `settlementPullRequestLinks` and `resolveAutoSettlementAt`: while a linked
  pull request is open, or not read yet, the thread does not settle on its
  branch's pull request (D447) either; once all are merged or closed, the
  latest of them settles it through `threads.auto-settle` (D447's rules:
  `autoSettleOnMerge`, the user's last message, pins and snoozes), read as
  soon as a link's state changes. A link made after its pull request had
  merged or closed records work the thread did (an agent asked to merge
  it), so it is left out; the forge's close time is compared with the
  node's link time as T3 does, so clocks apart by more than a merge's
  moment can misplace a link made right around it (the thread then settles
  by hand). Unlinking a pull request asks again. A link
  not read yet holds the thread, as in T3, unless no forge of this node reads
  its host at all (then it can tell nothing and holds nothing). A thread
  without links that count (none, or all left out, including one merged or
  closed with no readable close time, as T3 leaves them out) settles on its
  branch's pull request as before.

- **D1134. A new worktree's submodules are checked out**, as T3's
  `createWorktree` does after `git worktree add` (which leaves them empty):
  with a `.gitmodules`, `git submodule update --init` (`--recursive` unless
  only the top level is wanted) runs in the worktree, as `worktreeSubmodules`
  of `jhin.source-control` says ("Worktree submodules": "Recursive", the
  default, "Top level only" or "Skip"; T3's words). A failure leaves their
  folders empty and the worktree in use; the setup card's "Check out files"
  then ends with a warning ("submodules not checked out: <git's reason>",
  while "Skip" ends it done with "submodules left empty", as the user
  chose). A worktree with checked-out submodules is removed only with `force`
  (D255's deletion and the cleanup pass it), as git holds: their own commits
  may be pushed nowhere, which a clean status does not show. So the cleanup
  first asks each submodule for commits on no remote branch or tag, on its
  HEAD or any local branch, and for stashes (`git submodule foreach git
  rev-list HEAD --branches --not --remotes --tags; git stash list`), and
  keeps a worktree that has any ("has submodule commits on no remote branch
  or tag, or stashes"; a commit fetched by hash alone counts too, the safe
  side). The sweep logs a deleted thread's worktree it keeps ("kept a
  worktree", with the reason), since nobody else sees it. Without `force`,
  `git.worktree.remove` says so ("remove it with force"), not git's own
  message. A submodule run git ends without a reason (killed at the
  timeout) says its exit code. T3's per-project setting and its `t3.json` override
  are W42's D1467; pull request checkouts (D902) are Deferred. A managed worktree made
  again from its branch (D256) gets its submodules the same way; a failure
  there is logged. Cancelling a setup while its
  submodules are still being checked out ends the setup but lets that git
  run finish (Deferred).

#### Reverting

- **D257. Reverting to a turn** (T3's "Edit from here" on a user message, built on
  W2's drop of later turns): the dialog "Edit from here?" ("Rewind chat to before
  this message. Your prompt and attachments return to the composer.", Cancel,
  "Revert files too", "Revert and keep changes"), refused while the thread runs
  (W2's `threads.rollback` answers `TURN_IN_PROGRESS`). Reverting drops the
  turns from that message on (W2); "Revert files too" passes `restoreFiles` to
  `threads.rollback`, whose `threads.rollback` hook the source control plugin
  wraps: under the worktree's lock it checks that the thread is alone there and
  that checkpoint `N-1` exists (N the first dropped turn's own count, recorded
  for every turn started; a turn from before counts were kept restores nothing),
  so a refused restore drops nothing; then the turns are dropped and the files
  restored (a restore that fails says the turns were dropped). Restoring files
  takes `git.write` besides `threads.write`. Afterwards it marks the dropped turns'
  records `stale`, deletes their refs, makes `N-1` the thread's latest
  checkpoint again and sets its count back, so the next turn takes turn `N`'s
  place. The dialog offers both through the new optional `Dialogs.choose` of
  `@jhin/ui` (a confirmation with a second way to agree).
- **D258. Restoring files** is T3's: `git restore --source <checkpoint>
  --worktree --staged -- .`, `git clean -fd -- .`, `git reset --quiet -- .`
  (`HEAD`, the branch and ignored files untouched). Only a thread in a worktree no
  other thread works in may restore files; otherwise it fails with T3's "File
  restore requires an isolated worktree. This workspace may contain changes from
  another thread. Rewind the conversation without restoring files instead."
- **D259. The agent's own session goes back too**, through W2's D222: a runtime
  whose session still holds the dropped turns starts its next turn from the
  thread's transcript (Claude Code closes its live process and starts a new
  session). T3's native rewind (Claude's `resumeSessionAt` at the target turn's
  last answer) stays deferred with W2's.

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
  template (`pull_request_template.md` under `.github/` and GitHub's other places, read
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

### Pull requests linked to threads (W4, D267–D270)

- **D267. A thread has linked pull requests**, several, in the order they
  were linked, as T3 Code's `thread.pullRequests`
  (`packages/contracts/src/threadPullRequest.ts`,
  `packages/shared/src/threadPullRequests.ts` at D53). A link is identified
  by host, repository and number (its key `host/owner/repo#number`,
  lowercased), carries its URL, who linked it (`manual`, `created`, `agent`),
  when, and the forge's last snapshot of it (state, title, head and base,
  draft, checks, when it merged or closed). Links live in `storage.kv` and go
  with their thread (a `git.pr.unlinked` for each). A link is written before
  its event: if publishing fails, `git.status` still has it. A link's key
  takes the host without its port, as a remote names it. Changes are D34's `git.pr.linked`, `git.pr.unlinked` and
  `git.pr.updated` events on the node's `source-control` stream, and
  `git.status` returns every thread's links, so a client follows them as it
  follows statuses (D114, D118).
- **D268. Commands**: `git.pr.link` (`git.write`; by `url`, or `repository`
  and `number` on `host`, the project's remote's when absent; `source`
  `manual` or `agent`, the default; linking a linked one answers
  `alreadyLinked`), `git.pr.unlink` (`wasLinked`) and `git.pr.list`
  (`git.read`; the links and their chains, `refresh` reads them again), so an
  agent reaches them as MCP tools (`git_pr_link`, …) with T3's description
  ("Register every pull request you open for this thread, including each
  layer of a stack, right after creating it.") and messages ("This is not a
  recognised pull request URL. Pass repository and number instead.", "Pass
  either url, or both repository and number.", "This thread's project has no
  recognised remote. Pass host or url."). A git action with a thread links
  the pull request it created or opened (`created`, T3's
  `linkCreatedPullRequest`); failing to link never fails the action.
- **D269. Snapshots are read from the forge** (`gh pr view <url>` for hosts in
  `githubHosts`) when a link is made and then every
  `pullRequestRefreshSeconds` while the pull request is open or unread; a
  merged or closed one is read again only on `git.pr.list` with `refresh`.
  Threads are read one after another, and a new round waits for the last;
  `syncedAt` moves with each read, only a changed snapshot is published, and a
  link whose read fails is reported once until it reads again.
- **D270. Stacks are derived as T3 derives them**: a linked pull request's
  parent is the one of the same repository whose head is its base; a head two
  share chains nothing; chains come newest first (`pullRequestChains` in
  `@jhin/source-control-api`). The card's pull request indicator shows the
  links before the branch's pull request, with T3's badge: one link its own
  badge ("PR #3, status pending" until read), a single chain "Stack of N pull
  requests, {state}" with the layer count, otherwise the current one's number
  as "+N" ("…, and K more linked; overall {state}"), the state aggregated as
  T3 does (draft, open, merged, closed); its tooltip lists them by chain with
  "stack · N". The thread's menu gets T3's "Link pull request" dialog ("Pull
  request URL or #42", "Paste a pull request URL or enter 123 / #123.", "Use a
  pull request URL, 123, or #123.", "Could not link the pull request.") and
  "Unlink #N from thread" per link (`jhin.source-control.link-pull-request`,
  `jhin.source-control.unlink-pull-requests` in `thread.actions`).
  T3's right panel of pull requests, its chat header rows and native stacks
  of a forge are not ported (Deferred).

The proof: `plugins/source-control/test/links.test.ts` (linking by URL and by
number, reading the snapshot from a fake `gh`, `alreadyLinked`, listing,
unlinking, the messages, the action's pull request linked as `created`,
links gone with their thread; URLs of every forge, chains);
`apps/web/test/source-control.test.ts` (the view follows the link events,
T3's badge, the dialog's input); Playwright `e2e/tests/git-actions.spec.ts`
(linking `#43` stacked on the action's pull request makes the card a stack,
with a screenshot).

### Watching a pull request (W4, D271–D274)

- **D271. A thread watches a linked pull request** (T3 Code's
  `watch_pull_request`, `apps/server/src/orchestration-v2/pullRequestWatch.ts`
  and `PullRequestWatchReactor.ts` at D53): `git.pr.watch` (links it first,
  as `agent`) and `git.pr.unwatch` (`git.write`; MCP tools `git_pr_watch`,
  `git_pr_unwatch`), refused for an archived thread and a merged pull request
  ("The pull request is merged, so there is nothing to watch."). A refused
  watch leaves no link behind; an archived thread is refused before anything
  is linked. The watch is
  part of the link (`watch`: what it has told already: the head commit, the
  failed checks, whether all passed, comments up to when and by id, a
  conflict, comment-only wakes and failed reads in a row), so it survives
  restarts and travels with `git.pr.updated`.
- **D272. Every `watchSweepSeconds` (120; 0 = only on request) the node reads
  each watched pull request** (`gh pr view <url> --json
  headRefOid,mergeable,statusCheckRollup,comments,reviews,author,…` and the
  account `gh api user`); `git.pr.watch.check` reads them now. One sweep runs at a time;
  a watch is changed only as it is stored then (one unwatched or restarted
  during a read stays so); a thread archived or gone ends its watches; the
  account is asked again after ten minutes. As in T3: new
  failed checks (failure, cancelled, action required), all checks passed
  (after a push, again), comments and reviews after the watch began by anyone
  but the account and the pull request's author, and a new conflict with the
  base are news; a new head commit resets the check state; an empty check
  list keeps it; "unknown" mergeability keeps the conflict state.
- **D273. News wakes the thread** with T3's message, "Jhin" for "T3 Code"
  ("Update on pull request #7 (…), which Jhin is watching for you:", "- Checks
  failed on abc1234:", "- All 3 checks passed on abc1234.", "- 2 new
  comments:", "- The branch now conflicts with main.", at most ten items each,
  and how to go on, naming `git_pr_unwatch`), sent with `threads.send`. While
  a turn runs (or waits for the user) the news waits in `storage.kv` and goes
  out, joined, when the turn ends (T3's `queue_after_active`). The news is
  kept before the watch moves past it, one thread's queue is changed by one
  task at a time, and a send that fails for another reason than a running
  turn is reported and dropped. The watch stops
  without a word when the pull request merges, with "Pull request #8 (…) was
  closed, so Jhin stopped watching it. Call git_pr_watch if it reopens." when
  it closes, after ten comment-only wakes in a row, and after eight failed
  reads in a row (T3's messages).
- **D274. The thread's menu offers "Watch #N for changes" and "Stop watching
  #N"** for each open linked pull request
  (`jhin.source-control.watch-pull-requests`), and the badge's list marks a
  watched one with T3's eye ("Watching: the agent wakes when checks finish,
  someone comments, or the branch conflicts"). Not ported: review thread
  comments on lines (`gh pr view` has none), required checks as the pass gate
  (all checks are), T3's fingerprints that skip unchanged reads, rate limit
  pauses, the notification of a wake and the sidebar's "Waiting" for a
  watched thread (Deferred).

The proof: `plugins/source-control/test/pr-watch.test.ts` (evaluation: failed
checks once, passing after a push and the message, others' comments only and
a conflict, ten comment-only wakes; the node with a fake `gh`: a quiet check,
then failed checks and a comment waking the thread with T3's message,
unwatching; news held during a turn and sent when it ends; stopping on merge
quietly, refusing to watch a merged one, and closing with a word);
Playwright `e2e/tests/git-actions.spec.ts` (watching from the thread's menu
marks the badge's list, with a screenshot).

### Other forges, GitHub Enterprise and forks (W4, D275–D279)

- **D275. Pull requests come from the forge of the remote they go to**: a
  driver per forge behind one interface in the plugin (find a branch's pull
  request, read one by URL, create one, its template paths and its word for
  a pull request, and the read of a watch where it has one), as T3 Code's
  `packages/source-control-*` drivers at D53. Which forge a host is follows
  T3's `detectSourceControlProviderFromRemoteUrl`: `forgeHosts` (config,
  host → forge) first, then `githubHosts`, then by name: GitHub (`github.com`,
  `*.ghe.com`, a `github` label), GitLab (`gitlab.com`, a `gitlab` label),
  Azure DevOps (`dev.azure.com`, `*.visualstudio.com`), Bitbucket
  (`bitbucket.org`, a `bitbucket` label), Forgejo and Gitea (`codeberg.org`, a
  `forgejo` or `gitea` label). The remote pull requests go to is `upstream`
  when there is one (a fork cloned as `origin`, as `gh` picks it), else
  `origin`. `ProjectStatus.provider.kind` names the forge (additive), and the
  client says "MR" for GitLab (T3's terminology) in the git actions.
- **D276. GitHub Enterprise** is GitHub on another host: `gh` answers for the
  host of the repository or URL it is given, so any host recognised as GitHub
  (or listed) is read the same way; signing in is `gh auth login --hostname`.
- **D277. Forks** (T3's `resolveBranchHeadContext` and
  `matchesBranchHeadContext`): a branch pushed to another repository than the
  one pull requests go to belongs to that fork's owner. A forge's answers for
  the branch name are kept only when they match: from a fork, its owner's
  cross-repository pull request; otherwise one that is not cross-repository,
  so a same-named branch of someone's fork is never the branch's (GitHub
  reads `isCrossRepository` and `headRepositoryOwner`, ten at most). A pull
  request is opened from a fork as `owner:branch` (GitHub, Forgejo) or with
  the fork as its source repository (Bitbucket). GitLab and Azure DevOps refuse a pull
  request from a fork (Deferred) rather than open one from the wrong project.
- **D278. GitLab, Azure DevOps and Forgejo through their CLIs**, as T3 calls
  them: `glab mr list --source-branch … --all --output json`, `glab api
  --hostname <host> projects/<path>/merge_requests[/<iid>]` (created with
  `--raw-field` and the body as `--field description=@<file>`), the head
  pipeline as its one check; `az repos pr list|show|create --detect true`
  (completed is merged, abandoned closed; no checks, as in T3); `tea api
  /repos/<owner>/<repo>/pulls…` and the head commit's statuses as checks, a
  `WIP` title as a draft, tea's error body read even though it exits 0. `glab` and `az` are told the repository
  pull requests go to (`--repo`, `--organization --project --repository`), so
  they never pick another from the folder. Paths
  `glabPath`, `azPath`, `teaPath`; T3's messages for a missing or signed-out
  tool ("GitLab CLI (glab) is not installed on this node", "… run `glab auth
  login` on this node", `az devops login`, `tea login add`).
- **D279. Bitbucket Cloud through its REST API** (T3's BitbucketApi):
  `GET /repositories/<ws>/<repo>/pullrequests?q=source.branch.name="…"`, its
  `statuses` as checks, `POST …/pullrequests`; the token comes from the
  node's environment (`JHIN_BITBUCKET_ACCESS_TOKEN`, or `JHIN_BITBUCKET_EMAIL`
  and `JHIN_BITBUCKET_API_TOKEN`; `JHIN_BITBUCKET_API_BASE_URL` for another
  base), "Bitbucket needs a token on this node: …" without one. Watching
  (D272) reads GitHub only; `git.pr.watch` on another forge says so (GitLab
  and Azure DevOps are watched since D1287, D1288).

The proof: `plugins/source-control/test/forges.test.ts` (which host is which
forge, configured hosts first; matching forks; a GitHub Enterprise host; a
fork's pull request told from another fork's same-named branch and none
taken for a branch not pushed to a fork; opening a fork's pull request as
`me:feature`; GitLab with a fake `glab`: the branch's merge request with its
failed pipeline, a fork's newer one left out, creating one with "Created MR
#6", refusing to watch it, `glab` missing; Azure DevOps with a fake `az`;
Forgejo with a fake `tea` and its statuses; Bitbucket against a local server
with the node's token, and without one).

### The pull request panel and the thread details rows (W35, D1281–D1283)

- **D1281. A thread's pull requests get T3's right panel** (T3 Code's
  `ThreadPullRequestsPanel.tsx` and `PullRequestListRow.tsx` at D53): the
  route's panel `pull-requests`, contributed to `app.panel` as
  `jhin.source-control.pull-requests-panel`, a chunk of its own (D440). Its
  rows are the links by chain, newest chain first, a layer indented by its
  depth (three at most): the state glyph ("Waiting for host state" until
  read), `#N` with who linked it and when as its tooltip ("Linked by you",
  "Created from this thread", "Linked by the agent"), the title (the
  repository until read), the eye of a watched one and the checks glyph while
  open, then the repository and head → base, a stack's "N pull requests
  chained by base branch." on its first layer, and when it was updated. A
  row opens the pull request; its "Actions for #N" menu (also on a right
  click) has "Copy link", "Open", "Watch for changes" or "Stop watching"
  while open, and "Unlink from thread". Without links it shows T3's "No
  linked pull requests" with its text and "Link pull request" (D270's
  dialog); with links its footer reads "{open} open · {linked} linked ·
  synced …" with "Link". The panel's header names it "Pull requests" with a
  close button, as Jhin's other right panels have one each. Not ported (Deferred):
  the author, diff stat and review decision of a row (Jhin's snapshot has
  none), T3's speed actions under Shift, dragging a row into the composer,
  the virtualized list, and native stacks (D270).
- **D1282. Ways in, as T3 opens it**: the client command `pull-requests.show`
  ("Show linked pull requests", T3's command palette action; `{ shown }`,
  false with no thread on screen or nothing linked, where T3 disables it)
  and the card's badge of a stack or of several linked pull requests, which
  opens the panel for its thread instead of the current one's page (T3's
  `opensList`). T3's tab strip of right panels and its proactive opening of
  the panel when a thread links more than one are not ported (Deferred).
- **D1283. The thread details panel gets T3's pull request rows**
  (`ThreadDetailsPrRows.tsx`, `ThreadDetailsPrRow.tsx`): the section
  `jhin.source-control.pull-requests` of `chat.thread.details` (labelled
  "Version Control", heading hidden, as T3's) shows the current pull request
  (D270's `currentPullRequest`, else the branch's): its state icon and
  "#N: title", opening it, with T3's tooltip (title and number, state,
  base ← head, the checks while open); a watched one is a split row whose eye
  is "Stop watching #N". The other links follow behind "Show N more" /
  "Show less". T3's row actions (Merge, Ready, Fix, Resolve), its checks
  popover and files count read T3's pull request detail queries, which Jhin
  has not (Deferred).

The proof: `apps/web/test/pull-requests-panel.browser.test.tsx` (the rows by
chain with their glyphs, tooltips and footer, the empty state, the menu's
commands, the details rows and "Show N more"); Playwright
`e2e/tests/git-actions.spec.ts` (the stack's badge opens the panel, the
details panel lists the links, with screenshots).

### Review comments as chips (W35, D1284–D1286)

- **D1284. A comment on lines is T3's review comment record and chip**
  (T3 Code's `reviewCommentContextRecord` and `reviewCommentContextLabel` in
  `apps/web/src/lib/composerContextRecords.ts` at D53), where D285 put
  `<review_comment>` text: "Comment" puts a `review-comment` record (D1006;
  its section, file, rows, range label, text and patch, the text cut at
  16 000 characters and the patch at 32 000 as T3 cuts them; its id the
  comment's own) into the open composer through `chat.composer.insert-context`,
  and its chip reads T3's label (`greet.ts L2`, `L3 to L5`, `(before)` for
  removed lines). The agent reads it through D1006's projection; a sent
  message shows the chip (D1007), T3's card of a sent comment. A chat
  without `chat.composer.insert-context` still gets D285's text. A message
  that holds T3's 200 records says so.
- **D1285. The diff shows the comments already in the message**, as T3's
  `AnnotatableCodeView` shows a draft's review comments: under their lines
  (T3's `restoreDiffReviewCommentRange`, by the rows they name), in the
  scope and file they were written on, as T3's comment annotation (its
  speech bubble and text). It reads them from `chat.drafts` 1.1's new
  `contexts(target, threadId)`: the records the thread's unsent message
  still names, the same array until the draft changes. A comment the user
  removes from the message leaves the diff with it.
- **D1286. "Delete comment"** (T3's `removeReviewComment`) takes the
  comment's chips and record out of the message through the chat's new
  client command `chat.composer.remove-context` (`{ contextId }` →
  `{ removed }`, false when the open message names no such record), which
  any record's chip can use.

The proof: `apps/web/test/source-control.browser.test.tsx` (a comment goes
in as its record with T3's label and fields, shows on its line, and "Delete
comment" removes it); Playwright `e2e/tests/source-control.spec.ts` (the
chip in the message, the comment on its line, deleting it takes the chip
out, with a screenshot).

### Listing and watching on GitLab and Azure DevOps (W35, D1287–D1288)

- **D1287. GitLab's merge requests are listed and watched**, as T3 Code's
  `GitLabPullRequestCli.ts` reads them at D53. `git.pr.search` (D849) asks
  `glab api --hostname <host> projects/<path>/merge_requests?state=all&search=…&order_by=updated_at&sort=desc&per_page=N`
  (any state, newest first, the words searched on GitLab). A watch (D271–D274)
  reads the merge request (`projects/<path>/merge_requests/<iid>`): its head
  `sha`, its head pipeline as the one check named "Pipeline" with its URL
  (T3's `toChecks`), and a conflict from `has_conflicts` or `merge_status`
  (T3's `toMergeability`). It reads the notes (the newest hundred, `…/notes?per_page=100&order_by=created_at&sort=desc`,
  without system or empty notes, a diff note with its path; T3's
  `decodeNotesJson`) and the node's account (`glab api user`, asked again
  after ten minutes as D272's). `git.pr.watch` no longer refuses GitLab.
- **D1288. Azure DevOps's pull requests are listed and watched**, as T3's
  `AzureDevOpsPullRequestCli.ts`. `git.pr.search` is `az repos pr list
  --status all --top N` in the remote's repository. `az` searches no text,
  so words are matched in the client's way here: a title holding them, or the
  number (`13`, `#13`), from the latest 100. A watch reads `az repos pr show`
  (the head commit from `lastMergeSourceCommit`, a conflict from
  `mergeStatus` as T3's `toMergeability`, the author's `uniqueName`) and the
  comments of the pull request's threads through `az devops invoke --area
  git --resource pullRequestThreads` (no system, deleted or empty comments,
  a file thread's path; T3's `decodeThreadsJson`). The node's account comes
  from `az account show --query user`. Azure DevOps has no checks here, as in
  T3, so a watch there wakes on comments and conflicts only.

The proof: `plugins/source-control/test/forges.test.ts` (fake `glab` and
`az`: listing with words on each, a watch that stays quiet on its first read
and then wakes the thread with T3's message for a failed pipeline, a
reviewer's note and a conflict on GitLab, and for a file thread's comment
and a conflict on Azure DevOps; the node's own and system comments wake
nothing).

### "Waiting" for a thread on a mesh member (W35, D1289)

- **D1289. A mesh member's thread that watches a pull request shows
  "Waiting" too**, as a thread of the client's own connection does (D1131).
  The work source follows a member's source control (the store's
  `mesh.relay` of its `source-control` stream, D504's path) from just after
  the render in which a card first asks about one of its threads, takes its
  view as it is then as told, and stops when the connection it is reached
  through goes; its threads are then told, as a node's are.

The proof: `apps/web/test/watched-work.test.ts` (a member followed once
asked and once only, its watched link and its watch ending told, the
connection's own threads apart, unfollowed with its connection; a member
whose view already held a watched link tells when that watch ends).

### Pull requests on every forge, their details and the rest of the panel (W41, D1441–D1460)

The reference is T3 Code at D53 (`eb7b35ac`): the forge packages
`packages/source-control-{bitbucket,forgejo,gitlab,azure-devops,github}`
(their pull request providers, JSON readers and client definitions),
`packages/shared/src/sourceControl.ts` (`providerName`),
`apps/server/src/orchestration-v2/PullRequestWatchReactor.ts` (`readRemarks`),
and in `apps/web` `components/PullRequestThreadDialog.tsx`,
`components/pullRequest/{ThreadPullRequestsPanel,PullRequestListRow,PullRequestSpeedActions,PullRequestChecksPopover,pullRequestPresentation,pullRequestDetail.logic,usePullRequestActions}`,
`components/chat/{ThreadDetailsPrRow,ThreadDetailsPrRows,composerMentionDrag}.ts(x)`,
`shortcutModifierState.ts`, `components/composerContextPresentation.tsx`
(`ComposerReviewCommentDetails`) and `components/diffs/AnnotatableCodeView.tsx`.

#### Forges

- **D1441. Bitbucket and Forgejo list pull requests** for `git.pr.search`
  (D849), as T3's `BitbucketPullRequestApi.listPullRequests` and
  `ForgejoPullRequestProvider` list them. Bitbucket:
  `GET /repositories/<ws>/<repo>/pullrequests?state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&pagelen=<N, at most 50>&sort=-updated_on`,
  with words as `q=(title ~ "<words>" OR description ~ "<words>")` (`\` and
  `"` escaped). Forgejo: `tea api /repos/<owner>/<repo>/pulls?state=all&sort=recentupdate&limit=<N>`;
  T3 searches no text there (`search: false`), so words are matched as D1288
  matches them on Azure DevOps: a title holding them, or the number, from the
  latest 100. Listed rows carry no checks, as GitHub's (D849).
- **D1442. Bitbucket and Forgejo pull requests are watched** (D271–D274),
  reading what T3's `getChangeRequest` and activity reads take. Bitbucket: the
  pull request (`source.commit.hash` the head, the author's `nickname`, else
  `display_name`), its `statuses` (each by `name`, else `key`; D279's
  states), `…/conflicts` for a conflict (an empty list is mergeable, a failed
  read unknown), its comments (`…/comments?pagelen=50`, ten pages at most;
  deleted, pending and empty ones left out; an inline one with its
  `inline.path`) and the node's account (`GET /user`, `nickname` else
  `display_name`). Forgejo through `tea api`: the pull request (`head.sha`,
  `user.login`, `mergeable` true is mergeable and anything else unknown, as
  T3: Forgejo never says conflicting), the head's statuses
  (`/repos/<o>/<r>/statuses/<sha>?sort=recentupdate`, by `context`), the
  issue comments (`/issues/<n>/comments`), the reviews
  (`/pulls/<n>/reviews`, without `PENDING` and `REQUEST_REVIEW`) and their
  comments on lines (`/pulls/<n>/reviews/<id>/comments` for a review with
  `comments_count`, with their `path`), and the account (`/user`). The
  viewer is asked again after ten minutes, as D272's. `git.pr.watch` refuses
  no forge any more.
- **D1443. A typed reference is found on every forge.** Each forge gets
  D902's `resolve`, so `git.pr.resolve` and with it the composer's typed
  `#123` (D849) answer off GitHub. Off GitHub a reference is a number, `#N`
  or the forge's pull request URL (T3's `normalizeChangeRequestId` per forge;
  `parsePullRequestUrl` reads each forge's URL); a head branch is refused with
  T3's "Specify a pull request number or <forge> pull request URL." GitLab
  reads `glab api projects/<path>/merge_requests/<iid>` and, for a merge
  request from a fork, the source project's path
  (`projects/<source_project_id>`); Azure DevOps `az repos pr show --id <n>`
  (a `forkSource` is a fork whose repository it names); Bitbucket
  `pullrequests/<n>` (a fork's `source.repository.full_name`); Forgejo
  `pulls/<n>` (`head.repo.full_name`).
- **D1444. Checking a pull request out on every forge** (D902, D903). Only
  GitHub and Forgejo publish `refs/pull/<n>/head` (T3: "Azure DevOps, GitLab
  and Bitbucket publish no `refs/pull/<n>/head`"): elsewhere the head branch is
  fetched from the pull request's repository or its fork's remote, and when
  that fetch fails nothing else is tried; a worktree that is reused is moved
  to the fetched head branch. A URL of another repository is still refused,
  now compared through `parsePullRequestUrl` for every forge's URL shape. The
  branch picker offers "Checkout <singular>" on every forge whose repository
  it reads, and the dialog takes T3's terms there: the title "Checkout
  <singular>", "Resolve a <providerName> <singular>, then create the draft
  thread in the main repo or in a dedicated worktree.", the placeholder
  "<shortLabel> URL, checkout command, or #42" and "Paste a <singular> URL,
  checkout command, or enter 123 / #123."; T3's `parsePullRequestReference`
  reads each forge's checkout command (`gh pr checkout`, `glab mr checkout`,
  `tea pr|pulls checkout`, `az repos pr checkout --id`) and URL.
- **D1445. Forges' names in the client** (T3's `providerName`):
  `PullRequestProvider` gets `name` (additive): "GitHub", "GitLab",
  "Bitbucket", or "GitHub Self-Hosted", "GitLab Self-Hosted", "Bitbucket
  Self-Hosted" on another host, "Azure DevOps" and "Forgejo", as T3's
  `detectSourceControlProviderFromRemoteUrl` names them. The client shows
  `provider.name`, else the forge's own label, where T3 shows
  `providerName`: the checkout dialog (D1444).
- **D1446. Forge tokens are the node's secrets.** The source control config
  gets `bitbucketAccessToken`, `bitbucketEmail` and `bitbucketApiToken`
  (`writeOnly`, so a config file holds a `$secret:` reference and the value
  lives in `secrets.store@1`, `security.md` D1025) and
  `bitbucketApiBaseUrl`. The node's environment
  (`JHIN_BITBUCKET_ACCESS_TOKEN`, …, D279) is read when the config has none.
  Without either, "Bitbucket needs a token on this node: set it in the source
  control settings, or JHIN_BITBUCKET_ACCESS_TOKEN (or JHIN_BITBUCKET_EMAIL
  and JHIN_BITBUCKET_API_TOKEN)". `glab`, `az` and `tea` keep their own
  sign-ins, as in T3.

#### Watching

- **D1447. Review thread comments on lines wake a watch** (T3's
  `readRemarks`): GitHub's are read with `gh api graphql` (the pull
  request's `reviewThreads(first: 100)` with their `path` and their
  comments, `first: 100`), next to `gh pr view`'s comments and reviews; a
  thread's comment that is also a review's is told once, by id. In the wake
  message such a comment reads "<login> on <path>: …", as T3 prints it
  (no line). GitLab's diff notes, Azure DevOps's file threads and the
  Bitbucket and Forgejo comments on lines (D1442) already carry their path.
- **D1448. Required checks off GitHub**: T3 marks none (no forge but GitHub
  sets `required`; GitLab's `allow_failure`, Forgejo's protected status
  contexts and Azure DevOps's policies are read nowhere), so every check
  stays the gate of "All N checks passed" there (D908), as in T3.

#### A pull request's details and actions

- **D1449. A snapshot carries T3's row details** (additive optional fields of
  `PullRequest`): `author` (`login`, `name`, `avatarUrl`), `additions`,
  `deletions`, `changedFiles`, `reviewDecision` (`approved`,
  `changes-requested`, `review-required`) and `mergeability` (`mergeable`,
  `conflicting`, `unknown`). GitHub reads them with D269's `gh pr view`
  (`author,additions,deletions,changedFiles,reviewDecision,mergeable`), GitLab
  from its merge request (`author.username`, `changes_count`,
  `has_conflicts`/`merge_status`), Azure DevOps (`createdBy`, `mergeStatus`),
  Bitbucket (the author and `…/diffstat`'s sums) and Forgejo (`user`,
  `additions`, `deletions`, `changed_files`, `mergeable`). Only GitHub has a
  review decision, as in T3.
- **D1450. `git.pr.detail`** (`git.read`; `{ projectId, url }` →
  `{ pullRequest, checks, mergeMethods, actions }`), T3's
  `pullRequests.detail` for the details rows and the checks popover: the
  snapshot (D1449), the head's checks one by one (`name`, `status` in T3's
  seven words, `description`, `url`, `required`; the watch read of D272 and
  D1442 for every forge), the merge methods the repository allows (GitHub
  `gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed`,
  GitLab its project's `merge_method` and `squash_option`, Forgejo its
  `allow_*` flags, Azure DevOps merge and squash, Bitbucket all three) and
  the actions T3's `changeRequestActions` give the forge, of `merge`,
  `ready`, `close` and `reopen` (GitHub, GitLab and Azure DevOps all four;
  Forgejo merge, close and reopen; Bitbucket merge and close).
- **D1451. `git.pr.action`** (`git.write`; `{ projectId, url, action,
  mergeMethod? }` → `{ pullRequest }`), T3's `runAction` for those four. It
  and `git.pr.detail` take only the project's own pull requests (of any of
  its remotes) and the ones its threads link, and a merge method the
  repository does not allow is refused before the forge is asked:
  GitHub through `gh pr merge --merge|--squash|--rebase`, `gh pr ready`,
  `gh pr close` and `gh pr reopen` (T3 sends the same GraphQL mutations);
  GitLab `glab mr merge --yes --auto-merge=false [--squash|--rebase]`,
  `glab mr update --ready`, `glab mr close`, `glab mr reopen`; Azure DevOps
  `az repos pr update --status completed [--squash true]`, `--draft false`,
  `--status abandoned`, `--status active`; Bitbucket `POST …/merge`
  (`merge_commit`, `squash`, `rebase_fast_forward`) and `POST …/decline`;
  Forgejo `POST pulls/<n>/merge` (`Do`) and `PATCH pulls/<n>` (`state`). An
  action the forge lacks answers `ACTION_UNAVAILABLE`. The pull request is
  read again afterwards and every link of it is updated (`git.pr.updated`).

#### The panel and the details rows

- **D1452. A panel row has T3's author, diff stat and review decision**
  (`PullRequestListRow.tsx`): the author's avatar (its initial without one)
  and login, its name in the tooltip; `+additions -deletions`
  (`PullRequestDiffStat`, nothing when both are 0) at the row's right; the
  review decision's glyph ("Approved", "Changes requested", "Awaiting
  review") after the checks; and a conflict badge on the state glyph
  ("Conflicts with <base>") of an open, non-draft one.
- **D1453. T3's speed actions under Shift**: while Shift alone is held (T3's
  `useShortcutModifierState`, not while typing in a field), each row shows
  its quick actions instead of its menu: "Close" and "Merge" for an open one,
  "Close" and "Ready for review" for a draft, "Reopen" for a closed one,
  those the forge has (D1450), as T3's `pullRequestQuickActions`. They run
  `git.pr.action` with T3's toasts ("Merge requested", "Could not merge this
  pull request" and its hint, …); a merge takes "merge" when allowed, else the
  first allowed method (read from `git.pr.detail` on the click), and a
  stack's layer cannot be merged from there ("Open this pull request to merge
  its stack"). T3's sweep to close several rows by dragging is not ported.
- **D1454. A row drags into the composer** (T3's `composerMentionDrag.ts`):
  its link carries T3's pull request payload under
  `application/x-jhin-pull-request` (the number, title, URL, branches, state
  and draft), and the chat's composer, on a drop of that type, adds the pull
  request as the `#` menu does (D851's record and chip) at the end of the
  message; a composer that cannot take it says T3's "Unable to add to chat"
  ("The composer is busy; try again once it is ready."). The type is a
  public id.
- **D1455. The list is virtualized** as T3's, with `@legendapp/list`
  (`LegendList`, rows of about 44 pixels, 440 drawn beyond the view), so a
  thread that links hundreds of pull requests mounts the rows in view only.
- **D1456. The details rows get T3's actions** (`ThreadDetailsPrRow.tsx`):
  the current pull request, while open, reads `git.pr.detail` and shows
  T3's second line under its title: `#N`, the checks popover's count
  (D1457) while it neither conflicts nor is a draft, the eye of a watch,
  and one action as T3's `resolveThreadPanelPullRequestAction` picks it:
  "Resolve" for a conflict, "Ready" for a draft, "Fix" for failing checks,
  "Merge" otherwise (behind T3's "Merge pull request?" dialog, "This merges
  #N using <method>."), with T3's tooltips and pending labels. "Fix" and
  "Resolve" are T3's hand-offs: the pull request is checked out in a
  worktree (`git.pr.checkout`), a new draft thread opens on it and T3's
  prompt goes into its composer (`buildFixFindingsHandoff` with the failing
  checks, `buildResolveConflictsPrompt`), with T3's toasts ("Preparing the
  pull request checkout...", "Checkout ready", …). The row's tooltip adds the
  files count and diff stat ("3 files +10 -2") and a draft's "Merge
  conflicts with <base>". It is read again after an action and whenever the
  link's snapshot changes.
- **D1457. T3's checks popover** (`PullRequestChecksPopover.tsx`): the
  checks state's label, T3's summary ("2 of 5 running", "1 of 3 failing", …,
  `summarizePullRequestChecks`), then the checks that need attention, those
  running and, behind "Show all" / "Show less", those completed, each with its
  status icon, label ("Running", "Failed", …) and "Details" link. The details
  row opens it from its count; a panel row's checks glyph opens it too and
  reads `git.pr.detail` only then.

#### Review comments

- **D1458. A review comment's chip opens T3's popover**
  (`ComposerReviewCommentDetails`): the file's path, "<section> · <range>",
  the comment's text as markdown and, when it has one, its patch in a
  read-only diff view, in the composer and in a sent message alike.
- **D1459. Comments on one line are one annotation**, as T3's
  `AnnotatableCodeView` groups them: comments that end on the same line and
  side stack in one annotation with dividers between them, each with its own
  "Delete comment"; the comment being written stays apart.
- **D1460** is kept free for this workstream's follow-ups.

The proof, as each layer of the stack lands it: `plugins/source-control/test/forge-pull-requests.test.ts`
and `pr-detail.test.ts` (Bitbucket against a local server and Forgejo with a fake `tea`: listing with words, a watch that
wakes the thread for a failed status, a comment on a line and, on
Bitbucket, a conflict; resolving a number and refusing a branch; a
Bitbucket token from the config's secret; GitLab, Azure DevOps, Bitbucket and
Forgejo checkouts from a local remote; the details and an action on each
forge), `plugins/source-control/test/pr-watch.test.ts` (a GitHub review
thread's comment wakes the thread "on <path>"); `apps/web/test/*` (the
dialog's terms per forge, the row's details, speed actions under Shift, the
drop into the composer, the details row's actions and checks popover, the
chip's popover and grouped annotations); Playwright
`e2e/tests/git-actions.spec.ts` with screenshots.

### Project settings, `t3.json` and scripts (W42, D1461–D1480)

W42 of `t3-roadmap.md` (round 5) takes what W30 left of a project's
settings and scripts. The reference is D53's tag:
`packages/contracts/src/t3ProjectFile.ts`, `packages/shared/src/projectSettings.ts`
(`resolveProjectSettings`, `resolveWorktreeCleanup`) and `projectScripts.ts`,
`apps/server/src/project/ProjectSetupScriptRunner.ts`,
`orchestration-v2/ThreadLaunchService.ts` (a cancelled preparation),
`ThreadSettlementService.ts` (`cleanUpSettledThread`) and `storageCleanup.ts`
(`reportOrphanWorktrees`); in `apps/web` `ProjectScriptsControl.tsx`,
`projectScriptEditor.tsx`, `chat/WorktreeSetupCard.tsx` and
`settings/StorageSettings.tsx`. How a section keeps settings per project and
the settings page's project scope are `config-ui.md`'s D1461–D1463.

#### `t3.json` and settings per project

- **D1465. The checked-in `t3.json` is T3's project file**, read by the same
  name at a project's root, so a repository set up for T3 works in Jhin
  unchanged. Its schema is T3's `T3ProjectFile` (`@jhin/agent-api`,
  `T3ProjectFile` and `parseT3ProjectFile`: `$schema`, `iconPath`,
  `defaultThreadEnvMode`, `worktreeSubmodules`, at most 50 `scripts` of
  `name`, `command`, `icon`, `runOnWorktreeCreate`, `runOnSettle`, `async`,
  `previewUrl`, `autoOpenPreview`, T3's descriptions); a file that is not
  JSON or not that shape reads as none and says why, as T3's loader logs
  it. `projects.t3-file.get { projectId }` (`jhin.threads`,
  `projects.read`) answers `{ file, error? }` (`file` null without one).
  Jhin uses its `scripts` (D1474) and `worktreeSubmodules` (D1467); its
  `iconPath` and `defaultThreadEnvMode` wait for a project icon and a
  node setting for where new threads start (Deferred).
- **D1466. Source control keeps T3's per-project settings it has.**
  `jhin.source-control`'s `projects` record (`config-ui.md` D1462) holds
  `worktreeSubmodules`, `branchNamingMode`, `branchNamePrefix`,
  `branchNameInstructions` and `worktreeCleanup` (D1468), the keys of T3's
  `PROJECT_SCOPED_SERVER_SETTING_KEYS` that Jhin's section has. Every rule
  reads the settings of the project it acts for: the branch rename (D901,
  D1126) its thread's project, a new worktree's submodule checkout
  (D1134) the worktree's project, the cleanup (D1129) each worktree's
  project. "Branch naming instructions" is a text area (D1461), as T3's,
  per project too.
- **D1467. Submodules follow the project, then the node, then `t3.json`.**
  As T3's file-backed `worktreeSubmodules`: a project's own setting wins,
  then the node's when it sets one, then the `t3.json` checked out in the
  new worktree (T3 reads the branch's file, not the project root's), then
  "Recursive". So the node's `worktreeSubmodules` loses its default
  (unset: "The project's t3.json decides, else Recursive"); a node config
  that sets it is read as before.
- **D1468. T3's "Automatic worktree cleanup" per project**: a project's
  `worktreeCleanup` is `{ mode: "off" }` ("Keep this project's worktrees
  until you delete them manually.") or `{ mode: "custom", … }` with the
  rules of D1128 ("Use these rules for this project."); without one it
  inherits the node's ("Use each machine's worktree cleanup settings."),
  T3's Inherit. As T3's `resolveWorktreeCleanup`, Off keeps the node's
  `keepWhen` and turns every rule off, and Custom's rules replace the
  node's whole. A sweep (D1129) runs when any project's rules or the node's
  enable a rule and judges each worktree by its project's; a deleted
  thread's worktree is noted (D1129's store) when its project's
  `onDelete` is on, and D1130's "asks nothing" reads the thread's project.
  `git.worktree.list`'s `cleanupOnDelete` becomes per project
  (`cleanupOnDeleteProjects`, additive, the ids whose rule differs from
  the node's).
- **D1469. The last cleanup's report is kept, and shown as T3's "Last run".**
  Every sweep that judged something (or found nothing to clean) keeps its
  report with `finishedAt` in the plugin's store, so a restart keeps it;
  `git.worktree.cleanup.report {}` (`git.read`) answers it or null. A
  settings section "Storage" (T3's Storage page, contributed by the source
  control client plugin) has T3's "Cleanup" group: "Delete now" (runs
  `git.worktree.cleanup` on every connected node, "Turn on a cleanup rule
  to use this." while no rule is on, failures in a toast "Cleanup failed on
  <node>") with "Last run <time>." per node ("Cleanup hasn't run yet."), and
  the fold "Last run" (T3's `CleanupResults`: a row per entry, the
  worktree's folder name, its thread's title and the reason, "Nothing
  needed cleanup."). T3 also measures and reports the bytes a sweep freed;
  Jhin's report has no sizes yet (Deferred).
- **D1470. T3's orphan report.** A sweep also lists the folders under the
  worktrees directory (D250, `<root>/<repository>/<branch>` or
  `<root>/<name>`) that no thread on the node works in, nor one deleted
  with its worktree noted (D1129), nor a project's own folder, and that
  nothing changed for an hour (T3's grace): each is a kept entry with T3's
  reason ("No thread uses this worktree", or "No thread uses this folder,
  and it isn't a git worktree" without a `.git` file). They are reported,
  never removed, as in T3; a user deletes them by hand.

#### Scripts

- **D1471. A script has T3's preview URL.** `ProjectScript`
  (`@jhin/agent-api`, D1121) gains T3's `previewUrl` ("URL opened in the
  in-app browser preview when this script runs") and `autoOpenPreview`
  (additive); `projects.scripts.set` keeps them. T3's
  `projectScriptMenuLabel` (`Name (setup, on settle)`) and
  `nextProjectScriptId` (an id from the name, unique in the project) are
  exported beside `setupProjectScript`.
- **D1472. `scripts.run { threadId, scriptId }` runs a project's script in a
  thread** (`jhin.source-control`, `terminals.write`), as T3's
  `runProjectScript`: the script's command is typed into the thread's
  terminal `script-<id>` in the thread's directory (its worktree, else the
  project's), opened with `JHIN_PROJECT_ROOT` and `JHIN_WORKTREE_PATH` (T3's
  `projectScriptRuntimeEnv`); a terminal of that id that still runs a
  program is left alone and the next free `script-<id>-<n>` is used (T3
  opens a new terminal when the base one is busy). It answers `{ terminalId
  }`. A node without terminals refuses it (`TERMINALS_UNAVAILABLE`).
- **D1473. T3's scripts control in the chat header** (`ProjectScriptsControl`,
  its toolbar mode; at D53 T3 also shows it in the thread details card,
  where Jhin's header keeps the git actions), contributed by the new client
  plugin `jhin.project-scripts` to `chat.header.actions` before the git
  actions (`jhin.project-scripts.control`). Without scripts it is "Add
  action"; with them the primary script's button ("Run <name>": the last
  one run in the project on this device, else T3's `primaryProjectScript`,
  the first that is no setup script) and the "Script actions" menu: each
  script with its icon, T3's label, its shortcut and an "Edit <name>" gear,
  then "From t3.json", the file's scripts not imported yet (by command or
  name, T3's rule), then "Add action". Running one calls `scripts.run`,
  shows its terminal in the drawer (`terminal.reveal`) and, with
  `autoOpenPreview` and a `previewUrl`, opens the preview at it
  (`preview.md` D1480). A
  client without `terminals.write` sees the button disabled with T3's
  "Pair this client again with permission to run terminal commands.".
- **D1474. T3's "Add Action" dialog** (`ProjectScriptEditorDialog`, its
  words): Name with the icon picker (Play, Test, Lint, Configure, Build,
  Debug), Keybinding ("Press shortcut"; Backspace clears), Command (a text
  area), "Preview URL (optional)", "Run automatically on worktree
  creation", "Wait for it to finish before the agent starts", "Run in the
  thread's worktree when the thread settles", "Open preview automatically
  when this action runs"; "Save action" or "Save changes", "Delete" with
  T3's "Delete action "<name>"?" ("This action cannot be undone."). Saving
  sets the project's scripts whole (`projects.scripts.set`): a new one gets
  `nextProjectScriptId`, and a script that takes the setup or settle role
  takes it from the one that had it (T3's `releaseClaimedRoles`). Importing
  a `t3.json` script saves it so, and opens the dialog with T3's "Failed to
  import action." when the node refuses it.
- **D1475. A script's shortcut runs it.** Each script id of the loaded
  projects is the client command `script.<id>.run` (T3's command names;
  the public id pattern `script.${id}.run`), which runs that script in the
  open thread's project. The dialog's shortcut is this device's rule for
  that command in `jhin.keybindings` (as Settings → Keybindings saves one,
  D487 syncs it), so projects whose scripts share an id share the shortcut,
  as T3 says ("Shortcuts are environment-wide. Projects using the same
  action share its shortcut." reads "Shortcuts belong to this device." here).
- **D1476. `runOnSettle` scripts run when their thread settles**, as T3's
  `cleanUpSettledThread`: once per settling (its `settledAt`), the
  project's settle script runs in the thread's own worktree, in a new
  terminal `settle-<id>-<8 hex>` (a settle shell of an earlier settling may
  still be busy) with T3's wrapper and the setup's variables (D1122); a
  thread working in the project's checkout, one whose worktree is gone, or
  one taken back up meanwhile runs none. Source control hears of a settling
  from the `threads` stream's updates and, for a thread settled by
  inactivity (which the threads plugin computes at read time, D444), from
  its hourly pass over `threads.list`. T3 closes the thread's idle
  terminals first; Jhin leaves them (Deferred).

#### The workspace's preparation

- **D1477. Cancel removes the new worktree, and "Work locally" works on.**
  While a setup runs and the agent has not started (its `agent` stage
  pending or running), `git.worktree.setup.cancel` does what T3's
  cancelled preparation does: the setup ends "cancelled", its terminal is
  closed, the new worktree is removed (`--force`; its branch stays), and
  the thread works in the project's checkout again (`threads.update`'s
  `worktreePath: null`); the first turn then fails with T3's "Worktree
  setup cancelled." `workLocally: true` (additive; the card's "Work
  locally", T3's `LaptopIcon` button beside Cancel while the setup runs)
  does the same, but the first turn starts in the project's checkout
  instead of failing, as T3 sends the message again there. For that the
  threads plugin reads the thread's directory again after its start hooks
  (a hook may have moved it). Once the agent has started, Cancel only stops
  the script, as D1124 says (T3 cannot cancel it then).
- **D1478. T3's "Retry" of a failed preparation.** A first turn that failed
  because its workspace could not be prepared (a fetch or checkout that
  failed, an `async: false` setup script that failed, or a cancel) records
  T3's failure class (`lastTurn.failure.class: "workspace_preparation"`,
  additive; a start hook says so with the error code
  `WORKSPACE_PREPARATION_FAILED`, `@jhin/agent-api`). Under its error the
  timeline shows "Retry" (T3's `RotateCcwIcon` button), which calls
  `git.worktree.setup.retry { threadId }` (`git.write`): the worktree is
  made again from the thread's branch when it is gone (D256's way, the
  setup's stages shown again) and the setup script runs again, then the
  turn's message is sent again (`threads.regenerate`). One retry at a time
  per thread; a thread that has a later turn is refused
  (`WORKSPACE_RETRY_INVALID`), as T3 retries only the failed run.
- **D1479. The finished setup is recorded on the thread.** A setup that
  ends (done, failed or cancelled) is kept in the plugin's store under its
  thread, so `git.worktree.setup.get` answers it and the card shows it
  after a restart, as T3 records the finished setup on the thread; a
  running setup a restart cut short is recorded "failed" ("The node
  restarted during the setup."). It goes with its thread.

## Deferred

- Checkpoints, from W3 (D240): T3's fast path that reuses the real index for
  the scratch one, sparse checkouts, nested checkpoint scopes (a subagent's
  own checkpoints), retries on `index.lock` contention and T3's per-path
  batching of a long turn diff (W22 gave the changed files card T3's file
  icons; its per-file context menu is D905).
- Reverting, from W3 (D257): T3's "Roll back" of a checkpoint item in the item
  inspector (Jhin has no item inspector yet; it comes with that panel), recreating a missing managed worktree before a rollback, and the
  error strings T3 shows for a disconnected environment or a provider without
  rollback.
- Worktree setup (D1121–D1125; W42 did the scripts menu, `t3.json`,
  `runOnSettle`, the preview URL, "Work locally", Retry and the recorded
  setup, D1465–D1480): the card for a thread on a mesh member (its setup
  stream is not relayed); a bound of its own on a setup that holds the
  agent (the threads plugin's turn hook timeout fails the turn, and the
  script runs on until it exits or is cancelled).
- `t3.json` (D1465): its `iconPath` (Jhin has no project icon yet) and
  `defaultThreadEnvMode` (Jhin has no node setting for where new threads
  start; the composer's workspace selector decides).
- Settle scripts (D1476): T3 closes a settled thread's idle terminals before
  the script runs (`closeIdle`); Jhin leaves them open.
- Branch naming (D1126, D1127; a text area and per project since D1466):
  the images themselves do not reach the writer, only their names.
- Worktree cleanup (D1128–D1130; per project, "Last run" and the orphan
  report since D1468–D1470): the bytes a sweep frees and an orphan's size
  (T3 measures them, with a 30 s budget per sweep), and the checks for a
  subagent chain sharing a worktree.
- Worktree submodules (D1134): those of a pull request's worktree (D902);
  stopping a submodule
  checkout that a cancelled setup leaves running; showing a recreated
  worktree's submodule warning on its turn instead of only logging it; a
  submodule checkout's own timeout; and D255's "Delete the worktree too?"
  naming a submodule's unpushed commits or stashes, which the user's forced
  removal takes (the cleanup keeps such a worktree).
- Worktrees, from W3 (D240): one worktree per model of a multi-model send, MCP
  tools that act as the calling thread (T3's `t3_worktree_status`;
  `git.worktree.handoff` takes a `threadId`), a handoff's continuation
  prompt (W1's queue), deleting a removed worktree's branch from the client's
  question (T3 keeps it too; `git.worktree.remove` takes `deleteBranch`), the
  `branch` of a `root` workspace, and worktree folders that tell two
  repositories of one name apart.
- Forges (D275–D279; listing, watching and checking out everywhere since
  D1441–D1444): the checks of an Azure DevOps pull request's policies, Azure
  DevOps and Forgejo words matched past their latest 100 pull requests (`az`
  and T3's Forgejo search no text), notes of a merge request past its newest
  hundred and Bitbucket comments past ten pages, Bitbucket Server and Data
  Center, creating a GitLab merge request or an Azure DevOps pull request from
  a fork, checking an Azure DevOps fork's pull request out (its repository is
  not read), a Forgejo server that pages below 50 (its first short page is
  taken as the last; T3 follows the `link` header `tea` does not show),
  checks of Forgejo and Bitbucket that fail to read showing as none rather
  than as an error, Forgejo's search for a branch's pull request among the 50
  most recently updated only, and GitLab's matching of a fork's merge request
  by its owner (a same-named branch of another fork can match).
- Checking a pull request out (D902, D903): resetting a reused
  worktree whose head was rewritten (T3's `refs/t3code/pre-refresh`), setup
  scripts after a checkout, and a fork whose head is named like its base
  being compared with the base repository's default branch (Jhin compares it
  with the pull request's base); T3's other ways in (the thread details
  panel, a draft that is not the current one: Jhin fills the draft the
  branch picker belongs to), and a "Checkout pull request" offered while the
  node cannot write (T3's `canWriteSourceControl`).
- Watching (D274; review thread comments since D1447, required checks off
  GitHub as T3 has them, none, D1448): a GitHub review thread past its first
  100 comments and threads past the first 100 (T3 pages them), a failed read
  of the review threads going unreported (the watch reads the rest), read
  fingerprints, rate limit pauses;
  T3's hover list of a waiting thread's background tasks ("Waiting" for a
  thread on a mesh member is D1289); a member followed for D1289 stays
  followed until its connection goes, also after it leaves the mesh or no
  card shows its threads.
- The pull request panel and rows (D1281–D1283): a row's author, diff stat
  and review decision, T3's speed actions under Shift, dragging a row into
  the composer, the virtualized list, T3's proactive opening of the panel
  (its tab strip is `t3-parity.md` D1421–D1424: the pull requests are its
  surface `pull-requests`); the details rows' Merge, Ready, Fix and
  Resolve, checks popover and files count (T3's pull request detail
  queries); native stacks of a forge (and their "Dismiss from thread") and
  the instructions that tell agents to link what they open.
- A pull request's details and actions (D1449–D1451): GitHub's avatars (`gh pr
  view` names no avatar; the row shows the login's initial, T3's fallback),
  T3's other actions (draft, update branch, auto-merge, revert, delete
  branch, approve workflows), GitHub's merge queue (T3 enables auto-merge
  there), a per-project default merge method and the last one chosen (T3's
  `pullRequestMergeMethod`), and the review decision off GitHub (T3 has none
  either).
- Git actions (D266): T3's "Publish repository", writing style settings, the
  thread details panel and opening a file from the commit dialog. Writer
  turns go through `agent.runtime@1`'s `startTurn` under a throwaway thread
  id, so a runtime that keeps live sessions (Claude Code) keeps one for it
  until its idle time ends; a one-shot text generation operation of the
  runtime would avoid it (W9).
- Cancelling a running git action: writes to a project queue behind it (its
  writer is bounded by `writerTimeoutSeconds`, a commit's hooks by ten
  minutes), with no way to stop it from the client. T3 has none either (at
  D53 and at `v0.1.2-nightly.20261021.3457`), so W21 leaves it until T3 does.
- What D1284–D1286 leave of T3's review comments: a comment's chip opens
  no popover with its lines and text (T3's `ReviewCommentChip` details),
  several comments on one line show apart rather than as T3's grouped
  annotation, and comments on a file's own contents (T3's file panel,
  `buildFileReviewComment`) wait for that panel.
- What W5 leaves of T3's diff panel: its in-app file preview (at D53 a click
  on a file's name opens T3's file panel; Jhin has none, so it opens the
  editor, D286), loading the patches of a truncated diff file by file
  (`useReviewFilePatches`), refusing to expand a file whose working tree copy
  no longer matches the patch shown (D921), revealing a file of a WSL node in Windows File Explorer
  (D922), opening a remote node's file in a local editor (T3's remote editor
  URLs), and the pop-out (non-inline) panel mode.
- The diff panel test "shows the branch's changes with Pierre" counts Shiki's
  highlighted spans as soon as the text shows; highlighting comes later from
  a worker, so under load it can count none. It should wait for a
  highlighted token instead (seen in W22, D923).
- The terminal indicator (the terminal plugin contributes it to
  `sidebar.thread.indicators`). Settling on linked pull requests is D1133;
  T3's "Keep threads with a PR" (`autoSettleKeepPullRequests`) is W32's.
  The branch-mismatch warning is done (`t3-parity.md` D443): source control
  contributes the hover card's branch line and the warning to
  `sidebar.thread.details`, the hover card's twin of
  `sidebar.thread.indicators`.
- Scoped permissions. Done in `security.md` (D410–D416): a device token
  holds `git.read` or `git.write` only when granted (`git.*` for both), and
  the `source-control` stream needs `git.read` (D415).
