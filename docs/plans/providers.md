# Providers plan: Claude Code, Codex and OpenCode

Status: **implemented** (Claude Code; W9's follow-ups D340–D350 too, see
Deferred for what is left; Codex too, its signed-in manual check pending,
see "Codex (W7)"). This file records how Jhin runs real
agents ("providers" in T3 Code) behind `agent.runtime@1.1` (D54) and
`agent.registry@1` (D55), what was left out and what is deferred.

## Goal

Run Claude Code from Jhin the way T3 Code does: the same tools, approvals,
questions, plans and sessions, shown in the existing chat UI, so Jhin can be
used to work on Jhin itself. Nothing in the threads plugin or the client is
specific to Claude: the runtime is a plugin on the public API.

## Decisions

- **D90. Claude Code is the plugin `jhin.agent-claude`.** It registers one
  runtime (`agentId` `jhin.agent-claude`, name "Claude Code") through
  `agent.registry@1` and keeps its state in `storage.kv`. It drives Claude
  Code through the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, pinned
  in the catalog), with the `claude` binary the SDK bundles unless
  `binaryPath` names another. The reference is T3 Code nightly `eb7b35ac`
  (D53): `ClaudeAdapterV2.ts`, `ClaudeProvider.ts` and the model manifest;
  derived files name their origin and are covered by
  `THIRD_PARTY_NOTICES.md`. T3's Effect runtime, workflow and goal tracking
  are not ported; its live-query reuse is (D98–D101).
- **D91. One Claude session per thread, kept running or resumed.** The session
  is named after the thread (thread ids are UUIDs): the Claude Code that
  starts it passes `sessionId`, any later one `resume`; with live sessions
  (D98) most turns go to the Claude Code already running. Which threads have a
  session is recorded in `storage.kv` once Claude Code reports `system/init`.
  When the record and Claude Code disagree (no conversation to resume, or a
  session id already in use, before anything started), the turn retries once
  the other way, unless it was stopped meanwhile. The two cases are told apart
  by Claude Code's error text ("No conversation found", "already in use"): a
  reworded message in a new CLI makes the turn fail with that message instead
  of retrying (only a Claude Code started for the turn can refuse it). A turn
  holds its thread's Claude Code from its message to its result; with
  `session: "per-turn"` (D98) it starts one and ends it, as before live
  sessions. A thread that started on another agent hands its earlier messages
  to Claude as a transcript in the first message of its session; one that went
  to another agent and came back hands Claude the turns it missed (D102).
- **D92. Modes map as in T3 Code:** `approval-required` → `default`,
  `auto-accept-edits` → `acceptEdits`, `full-access` → `bypassPermissions`
  (with `allowDangerouslySkipPermissions`), interaction mode `plan` →
  `plan`. `canUseTool` is always installed: a tool call Claude Code does not
  allow by itself becomes an approval request (in plan mode even with full
  access, unlike T3 Code: what Claude asks about there is a change the plan
  was not to make) (`<toolUseId>:approval`, its
  tool titled as an action, "Run command"); accept and accept-for-session
  allow it (the latter adds Claude's suggested rules, or an allow rule for the
  tool, to the session), decline denies it and records the tool as declined,
  cancel denies it and interrupts. An interrupt answers open requests with
  cancel.
- **D93. Claude's own interactive tools have their own items.**
  `AskUserQuestion` is a user-input request; questions are keyed by their text
  (Claude Code's answer format) and several choices are joined with ", ".
  `ExitPlanMode` shows the proposed plan as a message and is denied with T3's
  message, so Claude stops and waits for the user. `TodoWrite` and the
  `TaskCreate`/`TaskUpdate`/`TaskList` tools are plan updates, not tool calls.
  A subagent's own messages stay inside its `Agent` tool call.
- **D94. Streaming.** Partial messages stream text and (summarized)
  reasoning as deltas; a block completes once, whether its snapshot or its
  `content_block_stop` comes first. Usage is reported at each API message
  (`contextTokens` against the model's context window) and at the end
  (tokens, cache reads, cost). After an interrupt nothing Claude Code still
  sends is recorded, so a stopped turn never looks answered. Tool output kept
  in the thread is cut at 20 000 characters. Result errors use T3's wording
  (overloaded, rate limited, context full, …) and fail the turn.
- **D95. Status from Claude Code itself.** `status()` starts Claude Code
  without a prompt and reads its initialization (nothing reaches the API):
  unavailable when it does not start within 25 s or reports no token (T3's
  rule), otherwise available with the account's models, which replace the
  bundled list (Fable 5.1 by default, as in T3). An account that reports no
  fields at all counts as signed in, as in T3. A probe is reused for five
  minutes when it found Claude Code available and for ten seconds when not, so
  a sign-in shows soon. A stale answer is given at once while a new probe
  runs: only the node's first look waits for Claude Code to start, and picking
  the default agent (D96) never waits after that. Nothing probes (or starts a
  live session) at activation, since one-shot CLI commands boot the same
  plugins and would start Claude Code for nothing. The probe runs a Claude
  Code of its own, never a thread's live session. Context windows come from
  the manifest for its models and aliases, otherwise from what Claude Code
  reported for the model in an earlier result, else none.
- **D96. Claude Code is the node's default agent when it is available.**
  Registered runtimes come first (D55), so a node without
  `jhin.threads.defaultAgent` picks Claude Code when it is signed in and the
  fake agent otherwise. Tests and end-to-end tests pin
  `jhin.threads.defaultAgent` to the fake agent, so they never start a real
  one on a machine that has Claude Code. The pin sits in the helpers that
  write a test node's home (`apps/jhin/test`, `e2e/tests/support`), since
  those tests run the real CLI with the distribution; `@jhin/testing` kernels
  load only the plugins a test names. Listing agents there still probes Claude
  Code (it starts and exits; nothing reaches the API).
- **D97. Config section `jhin.agent-claude`:** `binaryPath`, `defaultModel`,
  `effort` (`low` … `max`), `env` (extra environment, e.g.
  `CLAUDE_CONFIG_DIR`; secrets such as `ANTHROPIC_API_KEY` belong in the
  node's own environment, see Deferred), `appendSystemPrompt`, `session` and
  `sessionIdleMinutes` (D98), `mcp` (D340) and `inheritEnv` (D346). Claude Code loads its usual settings,
  `CLAUDE.md` files and MCP servers, and runs with the node's environment
  (D103).
- **D98. Live sessions, kept by default.** `session: "keep-alive"` (the
  default) keeps a thread's Claude Code running after a turn: the next turn
  pushes its message into the same prompt stream (the SDK's streaming input)
  and reads until its own `result` (D104), as T3 Code's live query does. It
  skips starting Claude Code and resuming the session — measured on Claude
  Haiku 5.5 with `plugins/agent-claude/scripts/ttft.ts`, a second turn's
  `system/init` comes after a median 43 ms (36–123) instead of 1741 ms
  (1463–2251), its first token after 1317 ms instead of 3188 ms (ten threads
  each, 2026-10-20) — at the cost of a process (and its memory) per thread
  with a recent turn. `session: "per-turn"` starts Claude Code for every turn
  and ends it with the turn (D91). A kept Claude Code that waits
  `sessionIdleMinutes` (default 10; 0: no limit) for its thread's next turn
  exits; the next turn resumes. An idle time longer than one timer can wait
  (2^31 − 1 ms, about 24.8 days) is waited out in steps up to its deadline.
  Messages Claude Code sends between turns are dropped. A thread never has two
  Claude Codes, and the newest turn wins: the threads plugin runs one turn of
  a thread at a time and frees the thread only when a turn ended or a stop
  gave up on a turn that ignored its interrupt, so a session still held when
  the next turn comes belongs to a turn given up on. The next turn takes it
  over (ends it and starts Claude Code again with `resume`), and the turn that
  held it ends with "A later turn of this thread took its Claude Code over." A
  turn still waiting for `setModel` or `setPermissionMode` when a later one
  comes gives up with the same error instead of starting a Claude Code of its
  own. The live sessions of a node are listed by `claude.sessions.list` and
  ended by `claude.sessions.close` (one thread or all): only those no turn
  runs on, unless `force: true`, which ends busy ones too and fails their
  turn. Turning `session` to `per-turn` ends every kept session no turn holds
  at once; a held one ends with its turn. A new `sessionIdleMinutes` re-arms
  the sessions already idle, counted from their last turn. The section's
  defaults live in its schema only; the runtime reads the parsed section.
- **D99. A live session takes a turn's settings when it can.** Everything a
  running Claude Code cannot change — the working directory, effort, binary,
  the config's `env`, system prompt and `allowDangerouslySkipPermissions` —
  forms its launch key (T3's `claudeEffectiveQueryPolicyKey`); a turn with
  another key ends it and starts Claude Code again with `resume`, so entering
  or leaving full access, or a config change, restarts it. A different model
  goes in with `setModel` and a different permission mode with
  `setPermissionMode`; the mode Claude Code last reported (`system/init`,
  `system/status`) counts, so a session Claude moved into plan mode by itself
  goes back to the thread's mode, as in T3. When either control fails (an
  older CLI) the session is replaced. The node's own environment is passed
  through on launch (with the state reports of D104) and is not part of the
  key, so a change to it keeps a running Claude Code.
- **D100. An interrupt stops the turn, not the session.** Claude Code answers
  it with an aborted result and stays up for the next turn; one that does
  not take the interrupt is ended. A turn that lets go of its session before
  its result (a failure while reading, Claude Code exiting mid-turn) ends it,
  so the rest of that turn never reaches the next one. Claude Code that exits
  — mid-turn (the turn fails, as before) or while idle — is started again
  with `resume` on the next turn.
- **D101. A thread's live session ends with the thread.** The plugin requires
  `storage.eventlog@1` and follows the `threads` stream: a thread archived
  (`threads.thread.updated` with `archivedAt`) or deleted
  (`threads.thread.deleted`) ends its live session, also one a turn given up
  on still holds, and a deleted thread's `session/<threadId>` record is
  forgotten for good: a turn still letting go of the session does not write it
  back. Only a string `archivedAt` counts as an archive. A deleted thread's
  record writes run one after another, so the delete lands after a write
  already on its way, and a later write is skipped; that guard is dropped once
  no turn of the thread is left running. Deactivating the plugin ends every
  live session.
- **D102. Turns Claude missed are handed to it.** A thread that ran on Claude,
  went to another agent and came back gives Claude, in front of the new
  message, a transcript of the turns after Claude's last one (the user's
  messages and the agents' answers), since Claude's session never saw them.
  The turns are told apart by the `agentId` of `agent.turn.started`. A session
  with no turn of Claude's in the history (its record written on init, then
  the turn failed) gets no transcript: it already holds what Claude saw.
- **D103. Claude Code runs with the node's environment.** It gets the node
  process's whole environment plus the config's `env`, as `claude` started
  in the node's shell would: its sign-in (`ANTHROPIC_API_KEY`,
  `CLAUDE_CONFIG_DIR`), proxies and `PATH` for the tools it runs, unless the
  allow-list of D346 narrows it.
- **D104. A turn takes only its own frames.** Every message a turn sends has a
  fresh `uuid`, and Claude Code marks the frames answering it with that uuid
  (`user_message_uuids` on `system/init` and the result, `user_message_uuid`
  on the first stream event and assistant message), as T3 Code binds frames to
  its prompt uuids. Until its own marked frame comes, a turn on a live session
  drops what arrives: another message's frames (a message an interrupt did not
  stop still runs, with a result of its own) and unmarked ones once the
  session has shown it marks (Claude Code running on its own, such as a
  continuation after background work). Claude Code that marks nothing (an
  older CLI) gives a turn every frame up to the first result, as before. A
  turn never waits without end for its marks: live sessions run with
  `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, so Claude Code reports
  `session_state_changed` running and idle, and idle is its own word that it
  took every message sent. Once idle comes (after a running report, or on a
  session that was idle when the message went in) with nothing of the turn
  marked, the unmarked frames since the last unmarked `system/init` are the
  turn's answer if they end in a result (the CLI did not mark this message),
  and otherwise the turn fails with "Claude Code finished without answering
  the turn's message." A Claude Code that reports no states gives a turn its
  first unmarked result. A stopped turn ends on the next idle or result,
  whatever its marks; a turn that ended on idle keeps the session.

### Follow-ups (W9, `docs/plans/t3-roadmap.md`)

- **D340. Claude Code gets the node's own MCP server**, as T3 Code gives it
  its orchestration server (`claudeMcpQueryOverrides`, `McpSessionRegistry`).
  The plugin `jhin.mcp-server` provides `mcp.server@1` (`@jhin/mcp-api`): the
  endpoint's URL on the node's own machine (loopback when HTTP listens on
  every address, as T3's endpoint) and `issue({ id, permissions, threadId })`,
  a credential for one agent process: a random 32-byte bearer token that the
  plugin keeps only as a SHA-256 hash (in its scoped state, so a reload of the
  plugin keeps it), accepted at `/mcp` besides the node's own token and
  revoked by disposing it. A call made with it runs as `id` with those
  permissions, for its thread (below); `tools/list` shows a caller only the tools it may run. `jhin.agent-claude` lists
  `mcp.server@^1` as optional: every Claude Code it starts for a thread (live
  or per turn, never the status probe) gets a credential of its own, revoked
  when that Claude Code ends, and the server as `jhin` (`type: "http"`, a
  65-minute tool timeout, T3's, so a long wait is ended by the server and not
  by Claude Code's 60 s default). The server goes in through the control
  channel (`setMcpServers`) and not the command line, so the token is in
  neither Claude Code's argv nor the environment of the commands it runs
  (T3's reason). Its tools whose command needs nothing but read
  permissions (`*.read`, `projects.browse`) are approved without asking, as
  T3's read-only sessions pre-approve only its read-only tools; the others
  follow the thread's runtime mode like any tool (they ask unless it has full
  access). T3 pre-approves all of its own outside read-only sessions; Jhin's
  writing tools include `threads_respond`, with which an agent could answer
  its own approval request, and deleting threads and projects. The approval
  is the permission callback's, not `allowedTools`, whose bare
  entries make the SDK warn on every query. The appended system prompt
  (part of the launch key, D99) says what they are for. An MCP request names
  the thread whose agent calls in `x-jhin-thread`; the credential carries the
  same and wins, so an agent cannot act for another thread, while one made
  with the node's own token may name any (`Invocation.threadId`, new and
  optional, which W10's commands act on). A Claude Code that does not answer
  the registration within 90 s (T3's limit) fails the turn; one that cannot
  connect the server runs without it, with a warning. The config's `mcp` (on by default) turns it off; whether the server is
  attached is part of the launch key (D99), so changing it restarts a live
  session. Credentials live in memory only: a node restart ends them with the
  Claude Codes that held them, and deactivating `jhin.agent-claude` ends its
  Claude Codes and so revokes theirs.
- **D341. What a thread's agent may do through it:** `threads.read`,
  `threads.write`, `projects.read`, `projects.write`, `projects.browse`,
  `git.read`, `git.write` and `mesh.read`, the reach of T3's orchestration,
  worktree and pull-request tools. Not the node's token (`auth.admin`), config
  (`host.config.*` and `host.inspect`, which shows it: it can hold secrets),
  plugins, mesh administration and calls to other nodes, nor terminals
  (Claude Code runs its own shell). Within that reach an agent is not held to
  its own thread: like T3's tools, these act on any thread or project of the
  node (the user's own records, which Claude Code could reach through the
  user's token on disk anyway); `Invocation.threadId` says who acted, it does
  not fence it in. A workstream that adds commands meant for
  agents (W10's delegated tasks) adds their permissions to this list; A3
  added `missions.read` and `missions.write` (D652).
- **D342. Identical blocks stay apart.** A message or reasoning item
  completes once per block, not once per text: what a block's
  `content_block_stop` completed waits, by its text, for that block's
  snapshot, and a snapshot that finds no such block completes the block it
  belongs to or an item of its own. Two blocks of one API message with the
  same text are two items (D94's dedup was by text).
- **D343. No SDK warning on full access.** The SDK warns
  (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`) when a query starts in
  `bypassPermissions` with `canUseTool`, which Jhin keeps for
  `AskUserQuestion`. A Claude Code for full access starts in `default` (with
  `allowDangerouslySkipPermissions`) and is put in `bypassPermissions` with
  `setPermissionMode` before its first message goes in; one that refuses the
  switch is ended and started in `bypassPermissions` directly, warning and
  all.
- **D344. The first look at the agents is answered from the last probe.**
  Every probe is kept in `storage.kv` (`probe`, with a SHA-256 of the
  binary, environment and allow-list it ran with: the config's `env` can hold
  secrets), so a node that restarts answers its first
  `status()` with the stored one, stale, while a new probe runs (T3 keeps a
  provider status cache on disk the same way). Only a node that never probed
  with that configuration waits for Claude Code to start.
- **D345. A deleted thread's Claude Code session files go too.** Once no
  turn of the thread is left (D101) and every Claude Code of it has exited,
  also one a later launch replaced (it
  writes its last lines, title and cost, while it shuts down), the plugin
  removes `<threadId>.jsonl` and the `<threadId>/` folder of subagent
  transcripts from every project folder under Claude Code's `projects`
  directory, in its config directory: the config's `env.CLAUDE_CONFIG_DIR`,
  else the node's when the allow-list (D346) passes it, else `~/.claude`. The SDK's `deleteSession` is not used:
  it reads only the node's own `CLAUDE_CONFIG_DIR`. Only a thread id that is
  a UUID (as a session id is) is looked for, so no id leaves that directory.
  An archived thread keeps its files: it can be unarchived. The plugin then
  emits `claude.session.files.deleted` (`threadId`, `removed`).
- **D346. The node's environment through an allow-list.** The config's
  `inheritEnv` lists the node's variables Claude Code gets: names, or prefixes
  ending in `*`. The default `["*"]` passes all of them, as D103 did, because
  Claude Code's commands need what the node's shell has (`PATH`, proxies,
  sign-ins of their own); a narrower list keeps variables meant for the node
  away from it. The config's `env` and `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`
  always go in. The list is part of the launch key (D99), the node's variables
  are still not.
- **D347. A cap on live sessions.** The config's `maxLiveSessions` (default
  8; 0: none) bounds the Claude Codes a node keeps: when a new one starts and
  more are running, the idle ones without background work (D348) that waited
  longest since their last turn end first, until the count fits. A session a
  turn holds or one running background work is never ended for the cap, so a
  node can be over it while they run. T3 has no cap; it is Jhin's, for a node
  with many threads.
- **D348. Background work keeps its Claude Code.** Claude Code reports the
  background tasks it runs (shells, monitors, subagents) with
  `background_tasks_changed`, a level that replaces the last one; ambient
  ones (watchers) do not count. While a session runs one: the idle timer does
  not end it (it re-arms when the work ends), nor does turning `session` to
  `per-turn` or `claude.sessions.close` without `force` (a per-turn session
  ends once its work does). A turn that would replace it (another launch key,
  or a model or mode it cannot take live) fails with T3's message instead:
  "Claude is still running background agents or commands, and this model or
  setting change would end them. Wait for them to finish, or press Stop, then
  send the message again." `force`, archiving, deleting and deactivating
  still end it, work and all. `claude.sessions.list` shows `background`, the
  number of tasks.
- **D349. Effort changes live.** The effort is no longer part of the launch
  key: a running Claude Code takes another with `applyFlagSettings({
  effortLevel })` (`null` back to its default), as T3 applies its
  selection's flags; one that refuses is replaced, as for the model (D99).
- **D350. An interrupt that came before Claude Code took the message.** The
  interrupt receipt lists in `still_queued` the messages that will still run.
  When the stopped turn's own message is among them, the turn interrupts
  again as soon as that message's first frame comes, so it ends at once
  instead of running unseen to its result (D104 still keeps its frames out of
  the next turn). The SDK has no call for `cancel_async_message`, which would
  drop the message before it runs; an older CLI sends no receipt and keeps
  D104's behaviour.

Done since: steering a running turn (`t3-parity.md` D204–D206).

## Not ported

- T3's usage-limit and reset-credit probes, rollback and fork of a session,
  workflow and goal tracking, background-task rosters, the `$skill` dispatch,
  and the per-model option descriptors (effort, fast mode, context size) of
  its model picker.

## Deferred

- Dropping a message an interrupt did not reach before it runs
  (`cancel_async_message`): the SDK has no call for it, so D350 interrupts it
  again once it starts.
- Frames on a Claude Code that marks no message uuids (older CLIs): a result
  of another message or of Claude Code's own continuation can end the next
  turn early there (D104). On one that marks them, a continuation that goes
  idle just as the next message goes in (before Claude Code read it) is
  taken for that turn's unmarked answer. W9 left both: the Claude Code the
  distribution ships with its pinned SDK marks every frame, and telling the
  race apart needs a frame Claude Code does not send.
- Choosing a thread agent's permissions per thread or in config: D341 is one
  list for every Claude Code.
- Slash commands and skills from Claude Code's initialization in the
  composer.
- Subagent transcripts; today only the `Agent` tool's result shows. T3 shows
  a Claude subagent as a child thread of the parent (`subagentProjection`'s
  `makeSubagentChildThread`), not inside the tool call. Jhin has no child
  threads yet (W10's delegated tasks bring them), nor a way for a runtime to
  write another thread's items through `agent.runtime@1`.
- A snapshot frame Claude Code would send twice for one unstreamed block
  (not seen so far) shows twice: since D342 identical texts are not merged.
- Session files of a deleted thread under an earlier config directory: D345
  looks only in the directory the config names when the thread is deleted,
  so a session started under another `CLAUDE_CONFIG_DIR` or `inheritEnv`
  keeps its files.
- The kept probe (D344) is keyed on the configuration, not on the values of
  the node's variables: a changed `ANTHROPIC_API_KEY` in the node's
  environment shows the old status until the probe's time runs out.
- A bound on background work (D348): a task Claude Code never reports done
  keeps its session out of the idle timer, the cap and a plain
  `claude.sessions.close` until the thread is archived or deleted, `force`
  ends it, or the node stops.
- A node's very first look at the agents (no probe kept yet for its
  configuration, D344) still waits for Claude Code to start, up to 25 s when
  it hangs.
- Secrets in `env`: config is readable by anyone holding the node's token
  (config commands, RPC, MCP), so the field's description says to keep
  `ANTHROPIC_API_KEY` and the like in the node's own environment. The field
  is marked `writeOnly` (`docs/plans/config-ui.md`, D83): the settings page
  hides its values, and `host.config.get` redacts them (`security.md`
  D417). They are still in the node's config file in clear.

## Landing

One PR, then one for live sessions (D98–D104). Public API it changes: none
beyond new ids — the plugin `jhin.agent-claude`, its config section (with
`session` and `sessionIdleMinutes`), the storage namespace
`jhin.agent-claude` and the commands `claude.sessions.list` and
`claude.sessions.close`. The distribution gains the plugin and its SDK (with
Claude Code's binary for the platform, about 270 MB, as T3 Code ships it).

**Done when:**

- `pnpm verify` and CI pass; `pnpm pack:smoke` runs the packed CLI with the
  plugin.
- A scripted Claude Code (the SDK's `query` replaced in tests) proves: text
  and reasoning streamed and completed once, usage, a new session and its
  resume, the retry when the session record is wrong, the transcript handed
  to a thread's first Claude turn, approvals accepted and declined, questions
  answered, a proposed plan, todo and task plans, subagent frames, a failed
  result, interrupts (nothing kept afterwards, open approvals cancelled), the
  status probe (signed in, signed out, not starting); and through the threads
  plugin, a thread's two turns on one session and a failed turn.
- Live sessions, scripted: two turns on one Claude Code; model and mode
  changed live, Claude's own mode switch undone; a restart with `resume` on
  full access and when the controls fail; the idle end with fake timers (and
  none at 0, none while a turn runs); an interrupt that keeps the session;
  Claude Code exiting idle and mid-turn; the per-turn setting; disposal; the
  turns another agent ran handed to Claude; a continuation Claude Code ran by
  itself and the late result of an interrupted message kept out of the next
  turn (D104); a newer turn taking Claude Code over from a turn given up on,
  and from one still waiting for `setModel`; through the threads plugin, the
  session ended on archive and on delete (record forgotten) and the
  `claude.sessions.*` commands.
- Against the real Claude Code: time to the first token of a thread's second
  turn, keep-alive against per-turn (numbers in the PR).
- Against the real Claude Code in the web client: a supervised turn asks
  before a command, runs it once approved and answers. This check is manual
  (it needs a signed-in Claude Code); CI covers the scripted cases.

## Codex (W7)

Status: **implemented, manual check pending** (a supervised turn against a
signed-in Codex, see Landing; no Codex sign-in was at hand). Codex runs behind the same `agent.runtime@1.1` and
`agent.registry@1` as Claude Code, in its own plugin. The reference is T3
Code nightly `eb7b35ac` (D53): `CodexAdapterV2.ts`, `CodexProvider.ts`,
`codexLaunchArgs.ts` and the app-server protocol of
`packages/effect-codex-app-server`.

### Decisions

- **D310. Codex is the plugin `jhin.agent-codex`.** It registers one runtime
  (`agentId` `jhin.agent-codex`, name "Codex") through `agent.registry@1`,
  keeps its state in `storage.kv` and follows the `threads` stream through
  `storage.eventlog@1`, as Claude Code does (D90, D101). It drives
  `codex app-server`, Codex's JSON-RPC protocol over stdio (one JSON message
  per line), with a small client of its own: no SDK and no generated schema.
  It reads only the fields it needs, one by one, and drops a frame that lacks
  the ids it belongs to (an item delta without `itemId`, an item without
  `id`); a request about an item without one is answered with an error. The `codex` binary
  is the one on the node's `PATH` unless `binaryPath` names another; Jhin does
  not ship or install Codex. T3's Effect runtime, goals, subagent threads,
  MCP apps, ChatGPT accounts managed by T3, shadow homes, usage-limit probes,
  `/feedback`, compaction and fork/rollback are not ported (see Deferred).
  The distribution lists it after Claude Code, so a node without
  `jhin.threads.defaultAgent` picks Claude Code when it is signed in, Codex
  when only Codex is, and the fake agent otherwise (D96).
- **D311. One app-server per thread, kept between turns.** A thread's first
  turn starts `codex app-server` in the project's folder, sends `initialize`
  (client "Jhin", `experimentalApi`) and `initialized`, and keeps the process
  for the thread's next turns, which go to it directly, as Claude's live
  sessions do (D98), once Codex ended a turn itself (`turn/completed`,
  whatever its status). It exits after `sessionIdleMinutes` (default 10; 0: no
  limit) without a turn, when its thread is archived or deleted, on
  `codex.sessions.close` and when the plugin deactivates; the next turn starts
  it again and resumes. A turn whose launch settings differ from the running
  process's (working directory, binary, `homePath`, `args`, `env`) ends it and
  starts a new one, the way D99's launch key does. Ending an app-server sends
  SIGTERM and, when it has not exited 2 s later, SIGKILL (T3's
  `forceKillAfter`). A process that exits while
  idle is started again on the next turn; one that exits mid-turn fails the
  turn ("Codex exited while the turn was running.").
- **D312. A Codex thread per Jhin thread, resumed.** The first turn calls
  `thread/start` (working directory, model, T3's thread config
  `tools.update_plan.enabled`) and records Codex's thread id in `storage.kv`
  (`thread/<threadId>`) once `turn/start` answered: a turn that fails before
  its message reached Codex records nothing, so the next one hands the earlier
  turns over again. A new app-server for a thread with a record calls
  `thread/resume` with it (`excludeTurns`), unarchiving first when Codex says
  the session is archived (T3's rule). When Codex says it keeps no rollout of
  the thread ("no rollout found for thread id …", what codex-cli 0.163
  answers; any other resume error fails the turn), the turn starts a new Codex thread, handing it the
  conversation so far as a transcript; the record is replaced once that
  thread started, so a start that fails too keeps the old one. A deleted thread's record is
  forgotten.
- **D313. Modes map as in T3 Code** (`codexRuntimeModeTurnDefaults`), sent on
  every `turn/start`: `approval-required` → approval policy `untrusted` with
  a `readOnly` sandbox, `auto-accept-edits` → `on-request` with
  `workspaceWrite`, `full-access` → `never` with `dangerFullAccess`;
  `approvalsReviewer` is always `user`. Interaction mode `plan` sends
  collaboration mode `plan` (with the model and effort, `medium` when none is
  set, as T3 does); `default` sends collaboration mode `default` on every
  turn, so a plan turn does not stick to the next one (T3 sends it whenever
  it attaches its developer instructions, which is every turn there). A
  turn's `instructions` (`agent.runtime@1.3`, a defined agent's role) are the
  collaboration mode's developer instructions, where T3 puts its own. Every
  turn asks for `summary: "detailed"` reasoning, as T3 does.
- **D314. Approvals.** `item/commandExecution/requestApproval` becomes an
  approval of a command ("Run command", the command line, Codex's reason),
  `item/fileChange/requestApproval` one of a file change ("Edit file", the
  changed paths T3's `codexFileChangeApprovalPrompt` lists, or the reason),
  and `item/permissions/requestApproval` one of the permissions asked for
  ("Grant permissions", a file change, file read or command as T3 tells
  them apart).
  The request id is `<itemId>:approval`. Decisions map one to one: accept →
  `accept`, accept-for-session → `acceptForSession` (and later requests of
  the same kind on that thread's app-server, in the same runtime mode, are
  accepted without asking, T3's session allowance; a turn in another mode
  asks again), decline → `decline` (the tool shows as declined),
  cancel → `cancel`. Permissions are granted for the turn or the session, or
  not at all; a session grant is Codex's own (`scope: "session"` in the
  answer, as T3 answers), so Jhin keeps no allowance for it and a restarted
  app-server asks again. The legacy `execCommandApproval` and `applyPatchApproval`
  requests map the same way to Codex's review decisions. An interrupt answers
  open requests with cancel.
- **D315. Questions.** `item/tool/requestUserInput` becomes a user-input
  request (`<itemId>:input`) with Codex's question ids, headers and options;
  `isOther`, or a question without options, allows a free-text answer. Answers go back as `{ <id>: { answers: [...] } }`, only
  for the ids Codex asked, several choices as several answers.
- **D316. Plans.** `turn/plan/updated` is a plan update (`inProgress` →
  `in_progress`). The proposed plan of a plan turn (the `plan` item, streamed
  with `item/plan/delta`) is a proposed plan (`plan.proposed`,
  `agent.runtime@1.2`), its completed text being authoritative, so W6's card
  with "implement this plan" shows it, as for Claude's `ExitPlanMode`.
- **D317. Items.** Agent messages stream with `item/agentMessage/delta` and
  complete with the item's text (commentary and final answers alike).
  Reasoning streams per summary part (`item/reasoning/summaryTextDelta`, and
  the raw text when Codex sends it) and completes per part. Tool calls, with
  T3's titles in Jhin's wording: `commandExecution` → command ("Ran
  command", output streamed with `item/commandExecution/outputDelta`),
  `fileChange` → file change ("Edited file", the paths, the diffs as output),
  `mcpToolCall` → mcp (`<server>: <tool>`, the result's text or its error),
  `dynamicToolCall` → other, `webSearch` → web ("Searched the web", T3's
  `webSearchPatterns`), `imageView` → file read ("Viewed image"). Codex's
  `completed`, `failed` and `declined` statuses carry over; tool output kept
  in the thread is cut at 20 000 characters (D94). User messages, context
  compaction, review mode and subagent items are not shown.
- **D318. Usage.** `thread/tokenUsage/updated` reports the turn's usage as T3
  reads it (`codexProviderTurnTokenUsage`): the last request's input, cached
  input and output tokens, `contextTokens` from its total and the model's
  context window when Codex names it.
- **D319. Turn end and errors.** `turn/completed` ends the turn: `completed`
  completes it, `interrupted` after Jhin's interrupt interrupts it,
  `interrupted` without one fails it ("Codex stopped the turn."), `failed`
  fails it with Codex's error message, else the last non-retried `error`
  notification's details or message (T3's rule). An `error` notification
  that Codex will retry is not a failure. Only frames of the turn's own
  Codex turn id count; notifications of another turn are dropped.
- **D320. Interrupts.** An interrupt sends `turn/interrupt` with the thread
  and turn ids (after `turn/start` answered, when it comes before) and the
  turn ends on Codex's `turn/completed`; an app-server that does not answer
  the interrupt request at all is ended (one that answers it with an error,
  say the turn just ended, is not: its `turn/completed` or the grace ends
  the turn), and so is one that takes it but sends no
  `turn/completed` within 10 s (T3's wait for an interrupted turn): the turn
  ends interrupted either way, also when Codex never answers the
  `thread/*` or `turn/start` request it was waiting on. Nothing Codex sends after the interrupt is
  recorded. An interrupt before the app-server started never starts it.
  Steering (`agent.runtime@1.2`, `steering`): a message steered into a
  running turn goes to Codex as `turn/steer` with the turn's id
  (`expectedTurnId`, T3's call); one steered before `turn/start` answered
  goes in once it has. A turn that ended or is ending takes none. A steer
  Codex refuses after `steer()` returned (the turn ended just then) is
  logged only (see Deferred). A stop hides only what it caused (the grace
  running out, Codex ended by Jhin, a later turn taking over); a failure of
  the turn's own after it (Codex not starting, a crash, Codex failing the
  turn) still fails it.
- **D321. Status from Codex itself.** `status()` starts `codex app-server`
  in the node's temporary folder, initializes it and reads `account/read`
  and `model/list` (every page), as T3's
  `probeCodexAppServerProvider` does; nothing reaches a model. Codex that
  does not start is unavailable with T3's message ("Could not start Codex
  CLI (`codex`). …"), one that needs a sign-in with "Codex CLI is not
  authenticated. Run `codex login` and try again.", one that takes longer
  than 20 s with "Timed out while checking Codex app-server provider
  status." A signed-in account says which ("Signed in as <email>", or T3's
  plan and API-key labels); the version comes from the user agent. The models
  Codex lists replace the bundled ones; the default is the first of T3's
  preferred models present (`gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`),
  else Codex's own default, else the first. A turn that names no model
  before any probe ran (a CLI or MCP call before anyone listed the agents)
  waits for one, at most 3 s, so it does not go out with a bundled model the
  installed Codex lacks; a Codex that hangs or does not start leaves the
  bundled default, and the turn's own start reports what is wrong (T3's
  "Could not start Codex CLI" for a missing binary). The config's
  `defaultModel` skips the wait. Probes are reused and refreshed
  as D95 does (five minutes when available, ten seconds when not, a stale
  answer given at once), and nothing probes at activation.
- **D322. Config section `jhin.agent-codex`:** `binaryPath` (default
  `codex`), `homePath` (`CODEX_HOME`, `~` expanded as T3 does), `args`
  (extra arguments after `app-server`, T3's launch args), `defaultModel`,
  `effort` (`none` … `xhigh`, Codex's default when unset), `env` (marked
  `writeOnly`, D83), `inheritEnv` and `sessionIdleMinutes`. Codex gets the
  node's variables `inheritEnv` lets through (D346's allow-list, default
  `["*"]`; `pickEnvironment` in `agent-api` is the one implementation, the
  Claude plugin uses it too) plus `env` and `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`
  set to "Jhin", which T3 sets so Codex's first catalog fetch names the
  client.
- **D323. Turns Codex missed are handed to it.** As D102 does for Claude: a
  thread that started on another agent, or went to another agent and came
  back, gives Codex a transcript of the turns it did not see in front of the
  new message. The transcript is shared: `agent-api` exports it as
  `historyTranscript`, so every runtime words it the same way; Claude's
  `transcript` is that function.
- **D324. Tests drive a fake app-server process.** `test/fake-app-server.ts`
  is a Node script that speaks the app-server protocol: it answers
  `initialize`, `account/read`, `model/list`, `thread/*` and `turn/*` and
  plays scripted notifications and server requests for each `turn/start`,
  from a scenario file the test writes; it logs every message it receives,
  so a test reads what Jhin sent after the turn ended, without waiting on
  time. Tests run it with `binaryPath` (an executable wrapper) through the
  same spawn as the real `codex`; CI never runs the real CLI. A check
  against a signed-in Codex is manual.

### Deferred

- Per-turn model options in the composer: reasoning effort and service tier
  (fast mode) from `model/list`'s descriptors (W6); only the config's
  `effort` applies.
- Goals (`/goal`), `/compact`, `/feedback` and skills (`skills/list`, `$skill`
  mentions) in the composer; reverting, forking and rolling back a Codex
  thread (W2, W3).
- Asynchronous questions (`agentMessage` with `delivery: "async"`) that
  Codex asks while it goes on working: shown as the message's text today.
- Subagent threads (`collabAgentToolCall`, `subAgentActivity`) and their
  transcripts; background terminals Codex keeps after a turn.
- MCP elicitations, app access requests and MCP apps; attaching the node's
  own MCP server to Codex (as for Claude, W9).
- Usage limits and rate-limit windows (`account/rateLimits/*`), T3's
  usage-limit wording with the reset time, and retry progress items for
  errors Codex retries.
- ChatGPT sign-in from Jhin, several Codex accounts per node and shadow
  homes; signing in is `codex login` on the node.
- Models a newer Codex would list (T3's `updateRequiredModels`) and custom
  model slugs.
- The manual check of Landing: a supervised turn against a signed-in Codex
  asks before a command, runs it once approved and answers (only a sign-in
  with an invalid API key was at hand: Codex took Jhin's `thread/start`,
  `thread/resume` and `turn/start` and failed the turn with its 401).
- A steered message Codex refuses (`turn/steer` fails, typically because the
  turn just ended) is only logged: the threads plugin already recorded it as
  steered, and there is no way yet for a runtime to hand it back as a
  follow-up.
- Scoping "accept for session" more narrowly than T3 does: T3's session
  allowance, ported as is (D314), accepts every later command (or file
  change) on the thread's app-server in that mode, not only the approved one;
  the approval's wording does not say so yet.
- A cap on running app-servers, and keeping one alive while it still has
  background work.
- A time limit on `thread/start`, `thread/resume` and `turn/start`: a Codex
  that stays up but never answers them holds the turn until it is stopped
  (the stop then frees it, D320). They may legitimately wait on Codex's MCP
  servers starting, so no fixed limit is set.

### Landing

One PR. Public API it changes: `historyTranscript` in `@jhin/agent-api`
(additive) and new ids — the plugin `jhin.agent-codex`, its config section,
the storage namespace `jhin.agent-codex` and the commands
`codex.sessions.list` and `codex.sessions.close`. The distribution gains the
plugin, not Codex itself.

**Done when:**

- The affected checks and CI pass; `pnpm pack:smoke` runs the packed CLI
  with the plugin.
- The fake app-server proves: text, reasoning, a command with streamed
  output and usage; a failed turn with Codex's error; command, file-change
  and permission approvals accepted, declined, accepted for the session and
  cancelled by an interrupt; questions answered by id; a todo plan and a
  plan turn's proposed plan; two turns on one app-server, a resume on a new
  one, the fallback to a new Codex thread with a transcript, the unarchive
  retry; archive and delete; the idle end (and none at 0); a restart on a
  new `homePath`; Codex exiting mid-turn; an interrupt that keeps the
  app-server; frames of other turns and threads dropped; the turns another
  agent ran handed over; images; a later turn taking over; the status probe
  (signed in, plan labels, signed out, not starting, model pages and the
  preferred default) and the `codex.sessions.*` commands.
- Against a signed-in Codex (manual): a supervised turn asks before a
  command, runs it once approved and answers.

## OpenCode (W8)

Status: **implemented** (W8 of `t3-roadmap.md`). OpenCode runs behind the same
`agent.runtime@1.1` as Claude Code, in its own plugin, with T3 Code's
OpenCode 2 behaviour.

### Decisions

- **D325. OpenCode is the plugin `jhin.agent-opencode`.** It registers one
  runtime (`agentId` `jhin.agent-opencode`, name "OpenCode") through
  `agent.registry@1`, keeps its records in `storage.kv` and follows the
  `threads` stream through `storage.eventlog@1`. The reference is T3 Code
  `eb7b35ac` (D53): `packages/provider-opencode`, its OpenCode 2 adapter
  (`server/v2/adapter.ts`), server (`v2/OpenCode2Server.ts`), catalog,
  version probe, status and tool items. Derived files name their origin and
  are covered by `THIRD_PARTY_NOTICES.md`. Only OpenCode 2 is spoken (T3
  picks its 1.x adapter for an older CLI): it is the current OpenCode, and
  its protocol is what T3 builds on. A later major is tried as T3 does (any
  major from 2 takes the OpenCode 2 path); a protocol change there shows as
  failed requests. The plugin talks to OpenCode's HTTP API
  with `fetch` and reads its event stream itself, without OpenCode's client
  packages (their protocol package depends on Effect).
- **D326. One OpenCode server per node.** Unless `serverUrl` names one, the
  plugin starts `opencode serve --hostname=127.0.0.1 --port=<free port>`
  with a password it generates (`OPENCODE_PASSWORD`; the inherited
  `OPENCODE_SERVER_PASSWORD` is dropped, as in T3), reads the URL from the
  line `server listening on <url>` within 30 s and checks `GET /api/info`.
  Every request sends `Authorization: Basic` with the user `opencode`. The
  server is started when something first needs it (a status probe, a turn)
  and serves every thread and directory (`location[directory]`). It exits
  after `serverIdleMinutes` (default 10; 0: never) with no turn and no probe
  using it, once nothing uses it after the runtime is turned off, and when
  the plugin is deactivated (SIGTERM to its process group, SIGKILL a second
  later). A changed binary, URL or password, or turning the runtime off,
  retires the server: turns running on it keep it until they end, new ones
  get another. A
  server named by `serverUrl` is never started or stopped, only connected
  to with `serverPassword`.
- **D327. One OpenCode session per thread.** The first turn creates it
  (`POST /api/session` with the project's directory, the model and the
  rules of D328) and records it under `session/<threadId>` at once, marked fresh until
  OpenCode took a prompt: a turn stopped or refused before that leaves the
  next one the same session and the transcript of D102's kind. Later turns
  use it. The
  record also keeps the session's grants (D331) and whether it is unsettled
  (D337), so a reload or restart keeps both. A session OpenCode no longer has (`SessionNotFoundError`) fails the
  turn with T3's "The OpenCode session no longer exists. Send the message
  again to continue in a new session." and the record is forgotten. A
  thread that ran on other agents first hands OpenCode the earlier turns as a
  transcript in its first message, and one that went to another agent and
  came back hands it the turns it missed, as D102 does for Claude. A deleted
  thread's record is forgotten; its OpenCode session stays in OpenCode's
  database.
  The record also names the last turn whose prompt OpenCode took; a turn
  whose history no longer shows it (a rollback dropped it, `t3-parity.md`
  D220) starts a new session with the thread's transcript, as Claude's does
  (D222). T3 reverts OpenCode's own session instead (deferred).
- **D328. Modes are OpenCode rules and agents, as in T3.** `full-access` is
  `* * allow`; otherwise `shell * ask`, `edit * ask` (`allow` with
  `auto-accept-edits`) and `external_directory * ask`. The grants
  accept-for-session added follow, then in plan mode `edit * deny`, then the
  agent's own `allow` rules for `edit` and `external_directory` on paths
  other than `*` (the `plan` agent's too in plan mode, so it can write its
  plan file). Plan mode switches the session to OpenCode's `plan` agent,
  otherwise `build`. Before each turn the agent, the model and the rules are
  written only when they changed (`switchAgent`, `switchModel`,
  `PATCH /api/session/:id`). T3's per-thread MCP server and its rules are not
  ported (see Deferred).
- **D329. A turn is one prompt.** `POST /api/session/:id/prompt` with the
  id `msg_jhin_turn_<sessionId>:<turnId>` (OpenCode answers a repeated id
  with the message it has) and the text. A bare `/compact` compacts the
  session; `/<name> rest` runs OpenCode's command of that name when it lists
  one (not in a message that carries a transcript or images). Images are written to a temporary file and named in the text as T3
  does (`[Attached image "<name>" is saved at: <path>]`); the files stay while
  the thread does (its session's history names them) and go when it is
  deleted. They live in a folder of the node's own (`mkdtemp`, 0700), made
  on first use and removed when the plugin deactivates. The event stream is
  subscribed before anything is sent: OpenCode keeps no events for a stream
  that was not listening.
- **D330. The turn ends on OpenCode's execution end.** One event stream
  (`GET /api/event`) per server, routed by `sessionID`.
  On a session that was unsettled (D337), only once the turn's own
  `session.execution.started` came: an end before it is a late one of the
  stopped execution (T3's `awaitingStart`).
  `session.execution.succeeded` completes the turn, `.interrupted` ends it as
  interrupted and `.failed` fails it with OpenCode's message. Text and
  reasoning stream as deltas and complete with OpenCode's final text
  (`<assistantMessageID>:text|reasoning:<ordinal>`). After an interrupt nothing
  OpenCode still sends is recorded, as with Claude (D94). A stream that ends or
  stays silent for 45 s (OpenCode sends a heartbeat every 10–15 s) fails the
  running turns with "The OpenCode event stream was lost." and is opened
  again by the next turn.
- **D331. Approvals are OpenCode's permission requests.** `permission.asked`
  opens an approval of the tool call it names (or one made of its action and
  resources), titled as an action ("Run command", "Edit file", "Read file").
  Accept replies `once`; accept-for-session replies `once` and adds the
  request's `save` patterns to the session's grants (OpenCode's own `always`
  would save them for the whole project; a request with no `save` patterns,
  where T3 offers no session grant, is allowed once and logged); decline first steers T3's note
  into the session ("The user declined the <action> request (…). Do not retry
  it; …") and replies `reject` with "The user declined this request."; cancel
  replies `reject` without a message, OpenCode's stop.
- **D332. Questions are OpenCode forms.** A `form.created` with only
  `string` and `multiselect` fields opens a user-input request (field key as
  question id, title as header, description as question, options by label;
  a field without options or marked `custom` takes free text). Answers reply
  to the form, several choices of a single-answer field joined with ", ";
  no answer cancels it. A form with any other field is cancelled and fails
  the turn with T3's "OpenCode asked for <what>, which Jhin can't show. The
  question was declined."
- **D333. Tool calls are classified as in T3's tool items.** `shell`/`bash`
  are commands, `edit`/`write`/`patch` file changes, `read` a file read,
  `glob`/`grep`/`search`/`lsp` searches, `web*`/`codesearch` web, `subagent`
  an agent call; everything else keeps its own name. Output is the tool's
  text content, cut at 20 000 characters. `todowrite` is a plan update instead of a tool
  call, as Claude's `TodoWrite` is (D93); T3 shows it as a tool. `question`
  is never a tool call (its form is the request).
- **D334. Usage comes from OpenCode's steps.** Each `session.step.ended`
  adds its tokens (input with cache reads and writes, output with reasoning,
  cache reads) and cost; the context is the last step's input and output
  against the model's window (`limit.input`, else `limit.context`). Usage is
  reported after each step. OpenCode's cost counts only when above 0 (it
  writes 0 for unknown or subscription pricing).
- **D335. Models and status from OpenCode.** `status()` runs
  `opencode --version` (or reads `/api/info` of a configured server), then
  lists the server's models (`GET /api/model`, waiting up to 5 s for a fresh
  server to list any) as `<providerID>/<id>`, named as OpenCode names them,
  with the provider's name as description. The default model is
  `defaultModel`, else OpenCode's own (`GET /api/model/default`), else the
  first listed. Messages are T3's: not installed, too old (1.x), the server
  rejecting the password, no models listed, "OpenCode <version> lists <n>
  models." Probes are cached as Claude's are (D95): five minutes when
  available, ten seconds when not, a stale answer given at once.
- **D336. OpenCode is off until enabled, as in T3.** The config section
  `jhin.agent-opencode` has `enabled` (default false), `binaryPath`,
  `serverUrl`, `serverPassword` (write-only), `defaultModel` and
  `serverIdleMinutes`. A disabled runtime reports "OpenCode is disabled in
  Jhin settings." and starts nothing, so a node never starts OpenCode
  unasked and the default agent (D96) stays Claude Code or the fake one.
- **D337. Interrupts stop OpenCode's execution.** An interrupt answers every
  open request with OpenCode's stop (a permission rejected without a message,
  a form cancelled) and calls `POST /api/session/:id/interrupt`; the turn
  ends on the execution end that follows. An interrupt while OpenCode has not
  answered the prompt gives the prompt up, asks OpenCode to stop and ends the
  turn, with the session marked unsettled (OpenCode may take it after all).
  When OpenCode says nothing ran or does not answer within 10 s,
  the turn ends at once and the session is marked unsettled in its record:
  the next turn first asks `/api/session/active`, and a session still running
  is interrupted and the turn fails with T3's "OpenCode is still stopping the
  previous turn. Send the message again in a moment."
- **D338. Prompt errors are T3's.** A prompt OpenCode does not answer within
  60 s fails the turn ("OpenCode did not answer the prompt in time.") and
  marks the session unsettled. A prompt OpenCode refuses fails the turn
  with its message; unless the refusal is one that means nothing was queued
  (`InvalidRequestError`, `ConflictError`, `UnauthorizedError`,
  `CommandNotFoundError`, `SkillNotFoundError`) the session is marked
  unsettled (D337). A model that is not `provider/model` fails with "OpenCode
  model '<model>' must use provider/model format".
- **D339. Tests run a fake OpenCode server.** `test/fake-server.ts` serves the
  HTTP API and event stream of D326–D338 from scripts, over a real socket,
  and a stand-in `opencode` executable (a Node script) prints its version or
  starts it, so the spawn, the password and the URL line are tested too. CI
  never runs the real CLI.

### Not ported

- OpenCode 1.x (T3's `adapter.ts` over `@opencode-ai/sdk`): a CLI older than
  2.0 is reported as unsupported.
- T3's per-thread MCP server inside OpenCode, steering, fork and rollback,
  subagent child sessions and background wakes, reconnecting and reconciling
  a lost event stream, OpenCode Go usage limits, text generation, skills and
  `$skill` mentions, the version advisory and self-update.

### Deferred

- OpenCode 1.x.
- A lost event stream reconnects and reconciles the running turn from
  `message.list` (T3 does); today the turn fails.
- Per-turn model options (OpenCode's variants, T3's "Reasoning" select).
- Steering a running turn (`delivery: "steer"`), fork and rollback of a
  session.
- Subagent transcripts: a `subagent` call shows its result only.
- Writing the thread's title to its OpenCode session.
- Deleting a deleted thread's OpenCode session.
- Logging (or failing on) an attached image whose data URL is not
  `data:<mime>;base64,…`: it is skipped without a word.
- Choosing what of the node's environment `opencode serve` inherits, as
  Claude's `inheritEnv` (D346) does: today it gets the whole environment.
- A size bound on the transcript handed to a new session (D327), as for
  Claude's (D102): a long thread goes over whole.
- A rollback through OpenCode's own revert (`session.revert.stage`/`commit`,
  as T3 does) instead of a new session with the transcript (D327).
- A time limit on each request a turn makes before its prompt (agents,
  session, switches): an interrupt takes effect between them, and only the
  activation retries are bounded (60 s).
- Reaping an `opencode serve` left by a node that crashed: it runs detached
  (its own process group) and is stopped only when the plugin deactivates;
  T3 keeps a ledger of the servers it started for that.

### Landing

One PR. Public API it adds: the plugin `jhin.agent-opencode`, its config
section and storage namespace `jhin.agent-opencode`. The distribution gains
the plugin; it needs no npm dependency.

**Done when:**

- Against the fake server: the server started with its password and URL
  line, a new session and its reuse, a missed-turns transcript, streamed text
  and reasoning, tools, todos as plans, usage, approvals (accept,
  accept-for-session, decline, cancel), questions (answered and
  unsupported), plan mode's agent and rules, `/compact`, interrupts (and an
  unsettled session), a failed execution, a lost stream, a missing session,
  and the status probe (disabled, not installed, 1.x, models listed);
  through the threads plugin, a thread's two turns on one session.
- `pnpm verify --affected` passes and `pnpm pack:smoke` runs the packed CLI
  with the plugin.
- Against the real OpenCode 2 by hand: a supervised turn asks before a
  command, runs it once approved and answers.
