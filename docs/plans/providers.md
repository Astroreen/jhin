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
  `THIRD_PARTY_NOTICES.md`. T3's Effect runtime, live-query reuse, workflow
  and goal tracking are not ported.
- **D91. One query per turn, one Claude session per thread.** The session is
  named after the thread (thread ids are UUIDs): the first turn passes
  `sessionId`, later turns `resume`. Which threads have a session is recorded
  in `storage.kv` once Claude Code reports `system/init`. When the record and
  Claude Code disagree (no conversation to resume, or a session id already in
  use, before anything started), the turn retries once the other way, unless
  it was stopped meanwhile. The two cases are told apart by Claude Code's error
  text ("No conversation found", "already in use"): a reworded message in a new
  CLI makes the turn fail with that message instead of retrying. A turn
  owns its query: it ends, is interrupted or fails with it, and nothing
  outlives it. A thread that started on another agent hands its earlier
  messages to Claude as a transcript in the first message of its session.
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
  a sign-in shows soon. A stale answer is given at once while a new probe runs:
  only the node's first look waits for Claude Code to start, and picking the
  default agent (D96) never waits after that. Nothing probes at activation,
  since one-shot CLI commands boot the same plugins and would start Claude
  Code for nothing. Context windows come from the manifest for its models and aliases, otherwise from what
  Claude Code reported for the model in an earlier result, else none.
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
  node's own environment, see Deferred) and `appendSystemPrompt`. Claude
  Code loads its usual settings, `CLAUDE.md` files and MCP servers.

## Not ported

- T3's usage-limit and reset-credit probes, rollback and fork of a session,
  workflow and goal tracking, background-task rosters, the `$skill` dispatch,
  its own MCP server attached to Claude, and the per-model option descriptors
  (effort, fast mode, context size) of its model picker.

## Deferred

- One live query per thread (T3's live-query reuse): every turn starts
  Claude Code again, about a second before its first token.
- Steering a running turn and queueing follow-ups into it.
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
- Forgetting a deleted thread's session: its `session/<threadId>` record in
  `storage.kv` and Claude Code's session file stay. It needs an event from
  the threads plugin when a thread is deleted.
- The node's first look at the agents waits for Claude Code to start (up to
  25 s when it hangs); later looks are answered from the last probe.
- Two identical text or reasoning blocks in one API message show as one item
  (blocks complete once per text of a message, D94).
- Secrets in `env`: config is readable by anyone holding the node's token
  (config commands, RPC, MCP), so the field's description says to keep
  `ANTHROPIC_API_KEY` and the like in the node's own environment. Marking the
  field `writeOnly` (the secret marker of `docs/plans/config-ui.md`) and
  redacting it in `host.config.get` waits for that work.
- The SDK prints a Node warning on every full-access query
  (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`): `canUseTool` stays installed because
  `AskUserQuestion` still goes through it in that mode.

## Landing

One PR. Public API it changes: none beyond new ids — the plugin
`jhin.agent-claude`, its config section and the storage namespace
`jhin.agent-claude`. The distribution gains the plugin and its SDK (with
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
- Against the real Claude Code in the web client: a supervised turn asks
  before a command, runs it once approved and answers. This check is manual
  (it needs a signed-in Claude Code); CI covers the scripted cases.
