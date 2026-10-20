# Providers plan: Claude Code

Status: **implemented** (Claude Code; W9's follow-ups D340–D350 too, see
Deferred for what is left). This file records how Jhin runs real
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
  agents (W10's delegated tasks) adds their permissions to this list.
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

## Not ported

- T3's usage-limit and reset-credit probes, rollback and fork of a session,
  workflow and goal tracking, background-task rosters, the `$skill` dispatch,
  and the per-model option descriptors (effort, fast mode, context size) of
  its model picker.

## Deferred

- Steering a running turn and queueing follow-ups into it; the live session
  (D98) is where a steer would go.
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
- Per-turn model options in the composer (effort, fast mode): only the
  config's `effort` applies.
- A proposed-plan card with "implement this plan" (shown as a message today;
  also in `t3-parity.md`).
- Choosing a thread agent's permissions per thread or in config: D341 is one
  list for every Claude Code.
- Slash commands and skills from Claude Code's initialization in the
  composer.
- Subagent transcripts; today only the `Agent` tool's result shows. T3 shows
  a Claude subagent as a child thread of the parent (`subagentProjection`'s
  `makeSubagentChildThread`), not inside the tool call. Jhin has no child
  threads yet (W10's delegated tasks bring them), nor a way for a runtime to
  write another thread's items through `agent.runtime@1`.
- Codex and OpenCode runtimes.
- A snapshot frame Claude Code would send twice for one unstreamed block
  (not seen so far) shows twice: since D342 identical texts are not merged.
- Session files of a deleted thread under an earlier config directory: D345
  looks only in the directory the config names when the thread is deleted,
  so a session started under another `CLAUDE_CONFIG_DIR` or `inheritEnv`
  keeps its files.
- The kept probe (D344) is keyed on the configuration, not on the values of
  the node's variables: a changed `ANTHROPIC_API_KEY` in the node's
  environment shows the old status until the probe's time runs out.
- A node's very first look at the agents (no probe kept yet for its
  configuration, D344) still waits for Claude Code to start, up to 25 s when
  it hangs.
- Secrets in `env`: config is readable by anyone holding the node's token
  (config commands, RPC, MCP), so the field's description says to keep
  `ANTHROPIC_API_KEY` and the like in the node's own environment. The field
  is marked `writeOnly` (`docs/plans/config-ui.md`, D83): the settings page
  hides its values; redacting them in `host.config.get` is still to do.

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
