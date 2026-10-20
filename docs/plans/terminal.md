# Terminal plan

Status: **implemented**. This file records how Jhin runs terminals like T3
Code: PTY sessions on the node, the terminal drawer under the chat in the web
client, and the terminal indicator of a thread's card. It takes the terminal
off the Deferred list of `t3-parity.md`.

## Goal

Open a shell in a thread's project folder from the chat, as T3 Code does
(⌘/Ctrl+J), with tabs and splits, and see from the sidebar which threads run
a program in a terminal. Everything is a plugin on the public API: the node
side is `jhin.terminal`, the client side the builtin `jhin.terminal-drawer`,
and every operation is a command, so an agent reaches terminals through MCP
and a script through the CLI.

The reference is T3 Code nightly `eb7b35ac` (D53): `apps/server/src/terminal/`
(Manager, NodePtyAdapter), `packages/contracts/src/terminal.ts`, and in
`apps/web` the terminal drawer, `terminalUiStateStore.ts`, the keybindings,
`terminalFocus` and `ThreadTerminalStatusButton`. Derived files name their
origin and are covered by `THIRD_PARTY_NOTICES.md`.

## Decisions

- **D140. `jhin.terminal` provides `terminal.sessions@1`** (contract and
  schemas in `@jhin/terminal-api`). A session is a thread id and a terminal
  id the client chooses (`term-1`, `term-2`, … as in T3; no server-side
  allocation), with one shell process at a time. The commands, under the
  permissions `terminals.write` and `terminals.read`:
  `terminals.open {threadId, terminalId, cwd, cols?, rows?}` starts the shell
  in `cwd` (refused with `TERMINAL_CWD_INVALID` unless it is a directory) or
  returns the session already running under these ids, resized when a size is
  given; two opens at once start one process; a session whose process exited
  starts a new one. `terminals.write` (input as typed, at most 64 KiB),
  `terminals.resize`, `terminals.close {threadId, terminalId?}` (every
  terminal of the thread without an id), `terminals.list {threadId?}` and
  `terminals.get` (a summary with the scrollback, for the CLI and MCP, which
  have no subscriptions). The client passes `cwd`, the folder of the thread's
  project, as T3's client does: the plugin needs no capability of the threads
  plugin. `cwd` counts only when a shell starts: `open` on a running session
  with another folder is refused with `TERMINAL_CWD_MISMATCH` (its details
  name the folder it runs in), while a link to the same folder is the same
  folder; a session whose shell exited starts its next one in the new
  folder. This is a deliberate change in `terminal.sessions@1.1`: 1.0 kept
  the running shell and ignored the other `cwd`, so a caller whose folder is
  spelled differently than `realpath` makes it (a case change on a
  case-insensitive filesystem) now gets the error instead of the session,
  for an `open` that waited for the session to start as well. Turning a
  silently ignored argument into an error is accepted within 1.x, with no
  opt-in, because nothing relied on the ignored value: the drawer always
  passes the folder the session started in, and a caller that passed
  another one got a shell somewhere it did not ask for. Nor is `cwd` checked
  against the thread's project: `threadId` is a label that groups terminals,
  and the
  `terminals.write` permission is the only gate, as for every command that
  runs a process. As in T3: the shell is `$SHELL` (`COMSPEC` or PowerShell on
  Windows) unless `jhin.terminal.shell` names one, it starts at 120 × 30, gets
  the node's environment without `PORT`, `ELECTRON_RENDERER_PORT` and
  `ELECTRON_RUN_AS_NODE`, with `TERM=xterm-256color` and
  `COLORTERM=truecolor`. The CLI's own `--cwd` option takes the flag, so
  `jhin terminals.open` takes its input with `--input '<json>'`.

- **D141. Output is a live stream, not event-log events.** Terminal output is
  large and worth nothing after its session, while `storage.eventlog@1` keeps
  everything forever. So `jhin.transport-ws` now provides `rpc.streams@1`
  (`@jhin/rpc`): a plugin serves streams from memory under a name or a
  `prefix/`, and `rpc.subscribe` reads those from it instead of the event log
  (`serveRpc` takes `streams`; `connectInMemory` too). A served stream names
  the permissions a subscriber needs, checked as a command's are (`*` holds
  all; `PERMISSION_DENIED` otherwise): the terminal streams need
  `terminals.read`, since a shell's output may hold secrets. `createMemoryStreams`
  keeps them; its sequences start at the current time in microseconds and
  grow by one, and a stream started later (or again, after `delete`) starts
  above every sequence handed out before, so a client that resumes after a
  node restart (with the last sequence it saw) gets the new events instead of
  waiting for old numbers, and the instance keeps no head for a stream that
  is gone. Each listener of an append runs on its own: one that throws (a
  subscriber whose peer just closed) is logged and keeps neither the other
  listeners from the event nor the append from completing. A session's stream `terminal/<threadId>/<terminalId>`
  has `terminal.started {terminal}` (a process started; what came before
  belongs to an earlier one), `terminal.output {data}`, `terminal.exited
  {exitCode, signal}` and `terminal.closed`. The node's `terminals` stream
  holds one event, `terminal.sessions {terminals}`, the whole list after each
  change (a resize included, so the stream and `terminals.list` agree on the
  size): a late subscriber gets the current list and nothing else. Every
  summary names the run of the node's terminals it belongs to (`instance`,
  `terminal.sessions@1.1`, optional in the contract since a 1.0 provider
  has none; this plugin always sets it): new whenever they start over, after
  a node restart or a plugin reload, and also in `TERMINAL_NOT_FOUND`'s
  details. A client that gets none treats the session's absence as a node
  that started over. Output
  arriving in one tick is one event (at most 64 KiB). Without
  `rpc.streams@1` the plugin still runs, and output is read with
  `terminals.get`.

- **D142. Scrollback for late joiners.** A session's stream keeps the output
  of its current process up to `jhin.terminal.scrollback` lines (5000, T3's
  default) and 8 MiB of UTF-8 (T3's byte limit), dropping whole output events
  from the oldest, in one pass per flush: it walks the kept events (all but
  the newest), passes over any that is not output, and forgets the picked
  ones with one `remove` of their sequences, in place;
  the newest event and the `terminal.started` that opens the stream always
  stay. A client attaches as T3's does, with a
  snapshot and the stream: `terminals.open`, then `terminals.get` (the kept
  output and the sequence it reaches), then a subscription after that
  sequence; `terminals.open` only when the node has no session under these
  ids (`TERMINAL_NOT_FOUND`), so a shell that exited while nobody watched
  (the drawer hidden, the connection away) ends its tab instead of starting
  again. Only the first attach of a tab opens a shell this way. After the
  connection comes back, a session that is gone ends the tab with "Terminal
  closed" when the node reports the run the tab saw it in (closed elsewhere
  meanwhile); only when the run is another one (the node started over) does
  the tab open a new shell. What xterm.js would answer to queries in
  replayed output (cursor position, status, device attributes, mode reports,
  settings, version, colours) is not sent: while a replay is parsed,
  handlers on xterm's parser take the sequences that are only queries, and
  for colour sequences (`OSC 4`, `10`–`12`), which may set and query in one,
  xterm applies them in place and only the reply it emits in that same task
  is dropped. Window operations (`CSI … t`) are left alone: the same byte
  also resizes and keeps the title stack, and this xterm does not answer
  their reports. Typing is
  never dropped: keys pressed while the kept output is replayed go to the
  shell (a new split's prompt is often replayed while the user already
  types), and what is typed before the terminal is open (its shell
  starting, the connection coming back) waits and goes once it is.

- **D143. Sessions end with the plugin.** When `jhin.terminal` deactivates
  (stop, reload, a reload of what it depends on) every process gets SIGHUP,
  as a closed terminal sends, and SIGKILL after one second (T3's grace), and
  each stream ends with `terminal.closed`. A closed session's stream ends at
  once, before its process is gone: it says `terminal.closed` only (not the
  exit its closing caused), is forgotten, and what the process still prints
  goes nowhere; so a session opened again under the same ids while the old
  process is still being stopped keeps its own stream. An `open` whose
  session is closed while node-pty is still loading fails with
  `TERMINAL_NOT_FOUND` instead of answering with a session that is gone; an
  `open` after that starts cleanly. An `open` still reading its folder or waiting
  for node-pty when the plugin deactivates fails with
  `TERMINAL_UNAVAILABLE` and starts no shell: nothing would be left to stop
  it. A deleted thread
  closes its terminals (the plugin follows the `threads` index when the node
  has an event log). A client that loses its connection opens the terminal
  again when it is back: after a node restart that starts a new shell.

- **D144. What a terminal runs, as T3 finds it.** While any session runs, the
  plugin reads `ps -eo pid=,ppid=,comm=` every second (backing off up to a
  minute while `ps` fails; a failed read changes nothing, and the first of a
  run of failures is logged as a warning, since labels and indicators wait
  until `ps` answers again) and records a child
  of the shell as `hasRunningSubprocess` with its name as `label`, ignoring a
  copy of the shell without children of its own (async prompt themes). The
  tab is named after the program, else "Terminal N". Not on Windows yet.

- **D145. node-pty `1.2.0-beta.15`**, the version T3 pins, is a dependency of
  the plugin only. Unlike 1.1.0 it ships N-API prebuilds for Linux (x64,
  arm64), macOS and Windows, so Node 24 needs no compiler; its install script
  builds with node-gyp only where no prebuild exists, so pnpm runs it
  (`allowBuilds: node-pty: true` in `pnpm-workspace.yaml`, and in the app
  `pnpm pack:smoke` installs). It is loaded on the first `terminals.open`,
  not when the plugin activates: a node where it does not load starts every
  other plugin and answers `TERMINAL_UNAVAILABLE` with the loader's error,
  which the drawer prints. On macOS the plugin makes the prebuild's
  `spawn-helper` executable, as T3 does. On NixOS the prebuilt `pty.node`
  needs `libstdc++.so.6` and `libgcc_s.so.1`, which nixpkgs' Node already
  loads, so it should load there as is; if a setup lacks them, add
  `stdenv.cc.cc.lib` to `LD_LIBRARY_PATH` or install with
  `npm_config_build_from_source=true` and a compiler. This was checked on a
  Debian 12 machine with the downloaded Node 24.22 and by `pnpm pack:smoke`
  (a packed CLI opens a terminal), not on NixOS.

- **D146. The terminal drawer is the `chat.drawer` slot's
  `jhin.terminal.drawer`.** The thread view renders the new slot `chat.drawer`
  under its chat (props `ChatDrawerProps`: target, thread, project), where
  T3's ChatView has its drawer. The drawer is T3's: 280 px high by default,
  resizable by its top edge between 180 px and 75 % of the window, the four
  actions (split side by side, split stacked, new, close) at the top right, a
  list of groups and tabs once there are two terminals, at most four
  terminals per group, T3's labels and its confirmation before closing ("This
  stops the running process and clears its history."). A process that exits
  prints "Process exited" and its tab goes, and the client closes the session
  on the node. A session closed elsewhere (another client, a deleted thread,
  the node stopping) prints "Terminal closed" and its tab goes, but the
  client does not close it again: by then another client may have opened a
  new terminal under the same id. The layout of each thread's
  drawer (open, height, tabs, groups) is kept per device
  (`jhin.terminal.ui` in `localStorage`, T3's `terminalUiStateStore`). The
  terminal is xterm.js 6 with the fit addon, as T3 rendered it until
  `acf761b2`; T3 nightly draws with a libghostty-vt WASM build, which Jhin
  does not port. Colours are T3's xterm theme for light and dark, following
  the app's theme as it changes. A hidden drawer unmounts its terminals (they
  keep running on the node and come back from the scrollback); T3 keeps them
  mounted.

- **D147. Commands, keys and `terminalFocus` (D61).** The client commands
  `terminal.toggle` (⌘/Ctrl+J), `terminal.split` (⌘/Ctrl+D),
  `terminal.split-vertical` (⌘/Ctrl+Shift+D), `terminal.new` (⌘/Ctrl+N) and
  `terminal.close` (⌘/Ctrl+W), the last four only `when: "terminalFocus"`,
  as T3 binds them; they act on the open thread. `terminalFocus` is set while
  the focus is inside an element with `data-terminal-owner` (T3's rule), so
  the existing `!terminalFocus` rules (⌘K, ⌘N for a new thread, …) give way
  in a terminal. A browser keeps some of these keys for itself (Ctrl+N,
  Ctrl+W in Chrome): there the toolbar buttons do the same. ⌘/Ctrl+D is
  also source control's `diff.toggle`, bound `when: "!terminalFocus"`: in a
  terminal it splits, elsewhere it toggles the diff panel.

- **D148. A card's terminal indicator is the `sidebar.thread.indicators`
  slot's `jhin.terminal.indicator`**, the slot source control added
  (`source-control.md`, D117; props `ThreadIndicatorProps`). It comes at
  order 0, where T3 puts a running terminal: after the branch
  (`jhin.source-control.branch`, -100), before the pull request (100) and the
  diff (200). The indicator is T3's `ThreadTerminalStatusButton`: a
  teal, pulsing terminal icon while a program runs in one of the thread's
  terminals, named "1 terminal process running. Open terminal" (or "N
  terminal processes…"), which opens the thread with that terminal shown.
  The client follows each connected node's `terminals` stream once, however
  many cards and drawers read it.

The proof: `plugins/terminal/test/terminal.test.ts` (a real PTY: open, `echo`
read back from the output events and `pwd` in the folder, close, the process
gone; a late subscriber's scrollback and `terminals.get`; two opens at once;
an exited shell and a new one; refused folders and ids; the `terminals`
stream with a running `sleep` and its label; deactivation ending sessions; a
deleted thread's terminals closed; no live streams; a terminal reopened while
the old one is still being closed; the scrollback trimmed with its start kept;
no subscription without `terminals.read`; an open failing for a terminal
closed while node-pty loaded; no shell for an open caught by deactivation
while it read its folder or waited for node-pty; another folder refused for
a running terminal and a link to the same one taken; the `terminals` stream
sent again on a resize; one warning for a run of `ps` failures; at most one
look at the stream per flush when trimming), `packages/rpc/test/
streams.test.ts` (live streams through `rpc.subscribe`, their permissions, a
deleted stream starting above its old sequences, resuming after a
restart, longest prefix), `apps/web/test/terminal-state.test.ts` (T3's tab
and split rules, the stored layout), `apps/web/test/terminal-attach.test.ts`
(the viewport's attach against the real plugin: output, typing before the
terminal is open, a shell that exited unwatched ending without a new one, replay to a second
client, exit and close, a dropped connection, a terminal closed elsewhere
while the connection was away not brought back, a new shell after the node
started over meanwhile, a missing folder),
`apps/web/test/terminal-plugin.browser.test.tsx` (the card indicator and its
click, ⌘/Ctrl+D only with `terminalFocus`, an exited terminal closed on its
node and one closed elsewhere only dropping its tab), Playwright
`e2e/tests/terminal.spec.ts` (the drawer opened with the shortcut, a
command and its output, the indicator, a split, dark and light screenshots,
hiding and coming back through the indicator with the scrollback, closing
with the confirmation, an exited shell closing its tab) and `pnpm
pack:smoke` (the packed CLI opens a terminal with node-pty from the
installed package).

## Follow-ups (W15)

What the first version left (the review follow-ups, the environment,
history, limits, flow control and the drawer's own features), ported from
the same T3 Code nightly `eb7b35ac` unless a decision names another source.

- **D460. The review follow-ups of D140–D143.** `terminals.write` and
  `terminals.resize` on a PTY that died before node-pty reported its exit
  answer `TERMINAL_NOT_RUNNING` (node-pty's own error, EBADF or "ioctl
  failed", goes into its details) instead of throwing node-pty's error.
  A session is closed once: a second close while the first one runs
  (`terminals.close`, a deleted or archived thread, deactivation) waits for
  the first, appends no second `terminal.closed` and stops the process once.
  The scrollback keeps `jhin.terminal.scrollback` lines exactly: the oldest
  output event it has to cut into is split after a line break (T3's
  `BoundedTerminalHistory` cuts lines the same way), and at the byte limit
  it is cut at a code point, never inside a surrogate pair. A single line
  longer than the byte limit keeps its end.

- **D461. The shell's environment, narrowed by the owner.** Besides T3's
  three ports, the plugin now drops what T3's `shouldExcludeTerminalEnvKey`
  drops, with Jhin's names: `JHIN_*` (T3's `T3CODE_*`) and `VITE_*`, and
  scrubs an AppImage's runtime variables as T3 does (`APPIMAGE`, `APPDIR`,
  `ARGV0`, `OWD` and the mount's entries of `PATH`, `LD_LIBRARY_PATH`,
  `XDG_DATA_DIRS`, `GSETTINGS_SCHEMA_DIR`). Two settings of `jhin.terminal`
  narrow it further: `env.strip`, names to drop, and `env.keep`, when set
  the only names passed on (`TERM` and `COLORTERM` are always set). A name
  ending in `*` matches a prefix (`AWS_*`); names compare without case on
  Windows, where variables are case-insensitive. Both are read when a shell
  starts, so a running shell keeps the environment it started with.

- **D462. An environment per terminal** (T3's `env` of `terminal.open`):
  `terminals.open` takes `env`, at most 128 variables named
  `[A-Za-z_][A-Za-z0-9_]*` with values up to 8 KiB (T3's limits), set over
  the node's environment after D461's filters (on Windows it replaces a
  variable of another case, as T3 does). Like `cwd`, it counts only when a
  shell starts: an `open` of a running session with a different `env` is
  refused with the new code `TERMINAL_ENV_MISMATCH` (`terminal.sessions@1.2`),
  where T3 restarts the shell; a shell is not stopped by a call that only
  meant to attach (D140's reason). The variables are never in a summary or a
  snapshot: they may be secrets. T3's provider environments are not ported:
  Jhin has no provider instances with an environment of their own.

- **D463. Restart on attach is the caller's choice.** T3's `terminal.attach`
  with `restartIfNotRunning` starts a new process for a session whose
  process exited; without it the session is shown as it ended. In Jhin
  `terminals.open` is the attach that restarts (D140), `terminals.get` the
  one that does not, and `attachTerminal` takes `restartIfNotRunning` for a
  client that wants the former; the drawer keeps T3's web behaviour (an
  exited shell ends its tab, D142), so no setting is added.

- **D464. History across node restarts** (T3's history files). With
  `host.paths@1` the plugin writes each session's kept output to
  `<data>/jhin.terminal/history/<threadId>/<terminalId>.log`, coalesced:
  one write per session at most every 250 ms (T3's debounce), the newest
  content at the time of the write. When `terminals.open` starts a session
  the node does not have (after a restart, or for the first time), it reads
  the tail of that file, at most the scrollback's byte limit, skips a
  partial UTF-8 code point at its start, applies the line limit, and puts it
  in the stream as one `terminal.output` after `terminal.started`, before
  the new shell's first output; a file cut that way is written back capped.
  A process that exits and starts again in the same run starts with empty
  history, as in T3. `terminals.close` (the drawer's "clears its history"),
  a deleted or archived thread and an evicted session delete the file;
  stopping the plugin (a node restart) keeps it, after waiting for the
  pending writes. Without `host.paths@1` nothing is written.

- **D465. At most 128 exited sessions** (T3's
  `maxRetainedInactiveSessions`): when a session's process exits and more
  than 128 sessions have no process, the ones updated longest ago are
  closed as `terminals.close` closes them (their streams end with
  `terminal.closed`, their history goes). A running session is never
  evicted.

- **D466. An archived thread closes its terminals**, as a deleted one does
  (D143) and as T3's `ResourceCleanupService` does on archive: the plugin
  follows `threads.thread.updated` in the `threads` index and closes the
  terminals of a thread whose record has `archivedAt`. Unarchiving does not
  bring them back; the drawer opens a new shell when shown.

- **D467. `ps` output grows its buffer instead of failing for good.** The
  read starts with T3's 512 KiB; output cut short at that size doubles the
  limit for the next read, up to 16 MiB, and the plugin keeps the larger
  limit for the rest of its run. The warning stays once per run of
  failures (D144).

- **D468. What a terminal runs on Windows**, as T3 finds it: PowerShell's
  `Get-CimInstance Win32_Process` (`ProcessId|ParentProcessId|Name`, 1.5 s
  timeout, the same growing buffer from T3's 256 KiB), with `.exe` dropped
  from a name and `\` as a path separator. The same parent and child rules
  as D144 apply.

- **D469. Resizes are coalesced on the `terminals` stream.** A change that
  is only a size publishes the list at most once per 100 ms, at the end of
  that window; any other change publishes at once and carries the latest
  sizes. `terminals.list` and `terminals.get` always answer the current
  size. The drawer already sends at most one resize per animation frame and
  only when the size in cells changed.

- **D470. Flow control: acknowledged output windows**, T3's
  `withTerminalOutputWindow`. `rpc.subscribe` takes an optional
  `window: {events, bytes}`; with it the server has at most that many
  events and bytes (as sent, JSON) of the subscription unacknowledged, and
  the client acknowledges each event with the notification
  `rpc.ack {subscription, sequence}` once its handler is done (a handler
  that returns a promise, such as a terminal writing to xterm, acknowledges
  when it settles). Events beyond the window wait on the server. Waiting
  events are bounded: past 16 MiB the server ends the subscription with
  the notification `rpc.subscription.ended {subscription, error}` (code
  `SUBSCRIPTION_OVERFLOW`), and the client reports it to `onError`; the
  terminal client then attaches again from a snapshot, which is bounded by
  the scrollback. The terminal client asks for T3's window, 8 events or
  64 KiB. Old clients send no window and get every event as it comes; old
  servers ignore the window and the notifications, so both mix.

- **D471. Proofs that were missing.** A re-attach against a
  `terminal.sessions@1.0` node (no `instance` in summaries or in
  `TERMINAL_NOT_FOUND`) is tested: a missing session there opens a shell.
  node-pty on NixOS: in a `nixos/nix` container (no FHS libraries, as on
  NixOS), Nix's Node 24.21.0 (`nodejs_24` of nixpkgs-unstable) loads the
  prebuilt `pty.node` of node-pty `1.2.0-beta.15` and runs a shell in a
  PTY, so the libraries D145 names are found without `LD_LIBRARY_PATH`. A
  NixOS machine itself was not at hand; its Node is the same derivation.

- **D472. Links and fonts in the terminal.** Links are T3's
  `terminal-links.ts`: `http(s)` URLs and file paths found in a line,
  wrapped lines joined, underlined on hover, opened with ⌘-click (macOS) or
  Ctrl-click elsewhere. A URL opens in a new browser tab. A path has
  nowhere to open yet (Jhin has no "open in editor"), so only URLs are
  activated. The font is a setting of the client section `jhin.terminal`
  as in T3's appearance settings: `fontFamily` (empty: T3's monospace
  stack) and `fontSize` (12 px, T3's default), applied to open terminals
  as it changes.

- **D473. The selection menu and "Add to chat".** Selecting text in a
  terminal shows T3's selection menu by the selection ("Add to chat",
  "Copy"); a right-click shows T3's context menu ("Add to chat", "Copy",
  "Paste", "Select all", "Jump to latest"). "Add to chat" puts the
  selection into the open thread's composer through the new client command
  `chat.composer.insert {text}` (the chat plugin; the composer's text at
  the cursor). The text is T3's legacy wire shape: an inline
  `@terminal-1:3-5` label, and a `<terminal_context>` block with the
  numbered lines, which is what T3 sends to agents that do not read inline
  contexts. T3's inline chip in the composer comes with the rich text
  composer (W6).

- **D474. The right-panel terminal and terminals that stay mounted.** A
  thread's terminals can also show in the panel right of the chat
  (`app.panel`'s `jhin.terminal.panel`, open while the route's panel is
  `terminal`), with the same tabs, splits and actions as the drawer, toggled
  by the client command `terminal.panel.toggle` and the header button, as
  T3's right-panel surface. Terminals of a hidden drawer stay mounted
  (`display: none`), as T3's `PersistentThreadTerminals` keeps them, so
  showing the drawer again shows the screen as it was, without a replay;
  they unmount when the thread is left.

The proof of D460–D469, D471: `plugins/terminal/test/followups.test.ts`
(a fake PTY the test drives: `TERMINAL_NOT_RUNNING` for a dead PTY's write
and resize, one close for three at once, one `terminals` list for five
resizes and at once for another change, the scrollback cut at a line and at
a code point, the environment's filters, AppImage scrub and Windows case,
an `env` per terminal and `TERMINAL_ENV_MISMATCH` without its values,
history written on stop and shown after the node started over, empty after
a restart in the same run and for a terminal opened again while its close
deletes it, a long history file read by its tail and capped, exited
sessions evicted past the limit, `ps`'s buffer growing to 16 MiB,
PowerShell's process table), `plugins/terminal/test/terminal.test.ts` (an
archived thread's terminals closed, the scrollback holding exactly its line
limit), `apps/web/test/terminal-attach.test.ts` (a re-attach against a
1.0 node opening a new shell, `restartIfNotRunning`) and the NixOS check
of D471.

## Deferred

- Terminals of threads on mesh members (D47): calls could be relayed with
  `mesh.call`, but live streams are not mirrored between nodes, so the
  drawer and the indicator only work for threads on a connected node; for
  others the toggle says so.
- Permissions on subscriptions to the event log. Done in `security.md`
  (D415).
- Provider environments for a terminal (T3's `providerInstanceId`, D462):
  Jhin has no provider instances with an environment of their own yet.
- `terminals.write` is in effect shell access as the node's user, whoever
  holds it (an MCP client included); grant it only where that is meant.
  D461 narrows what a shell inherits, not what it can read on the machine.
- Flow control (D470): lands in the next PR of this workstream.
- Links, the selection menu and "Add to chat", fonts, the right-panel
  terminal and hidden terminals kept mounted (D472–D474): land in the
  following PR of this workstream.
