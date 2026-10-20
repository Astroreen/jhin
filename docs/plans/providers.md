# Providers plan: Claude Code

Status: **implemented** (Claude Code). This file records how Jhin runs real
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
  `sessionIdleMinutes` (D98). Claude Code loads its usual settings,
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
  exits; the next turn resumes. Messages Claude Code sends between turns are
  dropped. A thread never has two Claude Codes, and the newest turn wins: the
  threads plugin runs one turn of a thread at a time and frees the thread only
  when a turn ended or a stop gave up on a turn that ignored its interrupt, so
  a session still held when the next turn comes belongs to a turn given up on.
  The next turn takes it over (ends it and starts Claude Code again with
  `resume`), and the turn that held it ends with "A later turn of this thread
  took its Claude Code over." A turn still waiting for `setModel` or
  `setPermissionMode` when a later one comes gives up with the same error
  instead of starting a Claude Code of its own. The live sessions of a node
  are listed by `claude.sessions.list` and ended by `claude.sessions.close`
  (one thread or all). Turning `session` to `per-turn` ends every kept session
  no turn holds at once; a held one ends with its turn. The section's defaults
  live in its schema only; the runtime reads the parsed section.
- **D99. A live session takes a turn's settings when it can.** Everything a
  running Claude Code cannot change — the working directory, effort, binary,
  environment, system prompt and `allowDangerouslySkipPermissions` — forms
  its launch key (T3's `claudeEffectiveQueryPolicyKey`); a turn with another
  key ends it and starts Claude Code again with `resume`, so entering or
  leaving full access, or a config change, restarts it. A different model
  goes in with `setModel` and a different permission mode with
  `setPermissionMode`; the mode Claude Code last reported (`system/init`,
  `system/status`) counts, so a session Claude moved into plan mode by
  itself goes back to the thread's mode, as in T3. When either control
  fails (an older CLI) the session is replaced.
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
  (`threads.thread.deleted`) ends its live session, and a deleted thread's
  `session/<threadId>` record is forgotten for good: a turn still letting go
  of the session does not write it back. Only a string `archivedAt` counts as
  an archive. A deleted thread's record writes run one after another, so the
  delete lands after a write already on its way, and a later write is skipped;
  that guard is dropped once no turn of the thread is left running.
  Deactivating the plugin ends every live session.
- **D102. Turns Claude missed are handed to it.** A thread that ran on
  Claude, went to another agent and came back gives Claude, in front of the
  new message, a transcript of the turns after Claude's last one (the
  user's messages and the agents' answers), since Claude's session never saw
  them. The turns are told apart by the `agentId` of `agent.turn.started`.
- **D103. Claude Code runs with the node's environment.** It gets the node
  process's whole environment plus the config's `env`, as `claude` started
  in the node's shell would: its sign-in (`ANTHROPIC_API_KEY`,
  `CLAUDE_CONFIG_DIR`), proxies and `PATH` for the tools it runs. An
  allow-list is deferred.
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

## Not ported

- T3's usage-limit and reset-credit probes, rollback and fork of a session,
  workflow and goal tracking, background-task rosters, the `$skill` dispatch,
  its own MCP server attached to Claude, and the per-model option descriptors
  (effort, fast mode, context size) of its model picker.

## Deferred

- Steering a running turn and queueing follow-ups into it; the live session
  (D98) is where a steer would go.
- A cap on live sessions (a least-recently-used limit): today every thread
  with a turn in the last `sessionIdleMinutes` keeps a Claude Code.
- Background work and live sessions: a Claude Code ended while idle, on a
  launch-key change or by `claude.sessions.close` takes its background shells
  and subagents with it. T3 refuses such a replacement until they finish.
- Effort or other flag settings changed live (`applyFlagSettings`): a config
  change restarts the live session instead.
- An interrupt that reaches Claude Code before it took the turn's message:
  the message still runs (the interrupt receipt's `still_queued` is not
  read, nor `cancel_async_message` sent); the stopped turn waits for that
  result, nothing of it recorded, and the next turn drops any later frames
  of it (D104).
- Frames on a Claude Code that marks no message uuids (older CLIs): a result
  of another message or of Claude Code's own continuation can end the next
  turn early there (D104). On one that marks them, a continuation that goes
  idle just as the next message goes in (before Claude Code read it) is
  taken for that turn's unmarked answer.
- An allow-list for the environment Claude Code gets (D103): the node's whole
  environment passes through, including variables meant for the node only.
- Per-turn model options in the composer (effort, fast mode): only the
  config's `effort` applies.
- A proposed-plan card with "implement this plan" (shown as a message today;
  also in `t3-parity.md`).
- Attaching the node's own MCP server to Claude, so it can drive Jhin (threads,
  projects) the way T3 Code attaches its orchestration tools.
- Slash commands and skills from Claude Code's initialization in the
  composer.
- Subagent transcripts inside their tool call; today only the result shows.
- Codex and OpenCode runtimes.
- Deleting a deleted thread's Claude Code session file: its record is
  forgotten (D101), the file under Claude Code's config directory stays.
- The node's first look at the agents waits for Claude Code to start (up to
  25 s when it hangs); later looks are answered from the last probe.
- Two identical text or reasoning blocks in one API message show as one item
  (blocks complete once per text of a message, D94).
- Secrets in `env`: config is readable by anyone holding the node's token
  (config commands, RPC, MCP), so the field's description says to keep
  `ANTHROPIC_API_KEY` and the like in the node's own environment. The field
  is marked `writeOnly` (`docs/plans/config-ui.md`, D83): the settings page
  hides its values; redacting them in `host.config.get` is still to do.
- The SDK prints a Node warning on every full-access query
  (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`): `canUseTool` stays installed because
  `AskUserQuestion` still goes through it in that mode.

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
