# Execution progress — jhin-t3code-experience-plan

**Read this first.** This file is the continuation brief for a fresh, empty
session. The plan itself is `.sisyphus/plans/jhin-t3code-experience-plan.md`
(T300–T319). Work happens in micro-chunks: one milestone at a time, one
milestone commit at a time. Everything below is verified fact, not intent.

**Last updated:** 2026-10-13.

## 1. Where we are

Recent chain (`git log --oneline`, linear on `main`):

- `6ccba14` T306 — work log and run lifecycle rows that close at `run_end`
- `e76605b` T307 — sub-agent activity bars in the run timeline
- `66173e5` T308 — real model and agent picker, branch picker shell
- `a0379a3` T309 — blocking `ask_user` tool + pending-question composer panel
  (code + `scripts/qa/t309.sh` + evidence)
- `7114c46` — qa-mock-llm scripted `ask` mock model (`QaMockAskingModel`)
- `9dea89c` — follow-up fix of `scripts/qa/t309.sh` + refreshed evidence;
  it reuses the T309 commit message (cosmetic duplicate — history left as is)
- `1f107c2` T310 code — run summary with changed files and open-diff
- `4cc6ccf` — qa-mock-llm scripted `files` mock model (`QaMockFilesModel`)

Older milestones: T304 `251ce2e`, T305 `65c19ff` (see `git log`).

**Current task: T310d** — the QA script for T310. The T310 code is already
committed (`1f107c2`); by explicit user request the code landed before its QA
proof, so T310d is a separate commit of script + evidence.

## 2. T310d — what to build (design already decided)

One file: `scripts/qa/t310.sh`, modeled on `scripts/qa/t308.sh` (security
bootstrap) + `scripts/qa/t309.sh` (mock-provider run flow). Both are proven —
mirror their calls verbatim where possible.

Happy mode (default):

1. Build gates: `:jhin-plugin-ui-kit:test :jhin-plugin-ui-default:test
   :jhin-plugin-tools-builtin:test :jhin-plugin-qa-mock-llm:test`.
2. Boot the full bundle (sessions ui-kit ui-default security llm llm-builtin
   agent tools-builtin qa-mock-llm) via `scripts/qa/run-kernel.sh`.
3. Create a mock provider with model `files` — copy the provider-create call
   from `scripts/qa/t309.sh` exactly (the body shape there is proven).
4. Create session + run. The `files` mock writes `docs/alpha.txt` (2 lines:
   "alpha one\nalpha two") and `src/beta.txt` (3 lines) via tool calls
   `qa-mock-file-1` / `qa-mock-file-2`, then answers "Done.".
5. Assert the run-end summary card in the chat HTML: "Changed files · 2", both
   paths present, stats +2/−0 and +3/−0. Save to
   `.sisyphus/evidence/T310/summary.html`.
6. `POST /ui/action/open-diff` with
   `{"action":"open-diff","payload":{"sessionId":S,"path":"docs/alpha.txt"}}`
   (and the same for `src/beta.txt`) → the `client` directive list must patch
   `right-panel-diff-view` and the diff must contain the file content lines.
   Save to `.sisyphus/evidence/T310/diff.html`.

`--fail` mode:

1. Provider model `title` (text-only, zero file events) run.
2. Summary shows "No changed files." → `empty.txt`.
3. `open-diff` on a path with no recorded changes → error-toast directive
   "No recorded changes for ..." → `empty-diff.txt`.

Conventions: `set -e` with `if grep -q` (never bare `grep` in a pipeline),
re-exec guard `T310_INNER`, `timeout --kill-after=15 900` watchdog, HTTPS
`curl -k`, bearer token via CLI enrollment, header
`X-Jhin-Client: api=4; version=0.2.0; schema=5; caps=sse,open_url,secure_storage`
on every client request, evidence under `.sisyphus/evidence/T310/` including
`checks.txt`, `checks-fail.txt`, `summary.txt`, `browser-unavailable.txt`.
Both modes must exit 0.

Commit (English, one): `test(qa): T310 run summary and open-diff end-to-end
proofs` — script + evidence (`git add -f .sisyphus/evidence/T310`; `.sisyphus/`
is gitignored). Then push if the user asked for it.

## 3. Verified facts (do not re-derive)

- Wire: action `POST /ui/action/{name}` body `{"action":name,"payload":{...}}`
  → 200 `{"client":[...]}` directives. Rejections come back as error-toast
  directives, never 4xx; the only 4xx is unknown action.
- `ActionDescriptors.of(name, payloadMap, includeList)`: `payloadMap` is merged
  into the body; `include` collects DOM input ids.
- Tool-use event payload: `{id, name, arguments}` (`arguments` is a JSON
  string). Events API: `GET /sessions/{id}/events?fromSeq=0` → rows
  `{seq, ts, type, payload}`.
- Mock models (qa-mock-llm; `QaMockFactory`): `ask` (`ASK_MODEL`) → one
  `ask_user` (`qa-mock-ask-1`); `files` (`FILES_MODEL`) → two writes then
  "Done."; `title`, `fail`, default (`qa-mock-output.txt`).
- T310 code (all committed in `1f107c2`):
  `screens/RunSummaryBuilder.java` — accumulator `record(toolName, input)`,
  `files()`, `recordDelete`; `FileStat(path, add, del, kind)` with
  `ADDED/MODIFIED/DELETED`; `write` → ADDED first time, `edit` → MODIFIED;
  fed from `EventFrames.useTool`, reset in `openRun`, summary frames appended
  in `endRunFrames` on both paths; `StreamRoute` feeds `sessionId` into the
  translator.
  `MessageCardBuilder.runSummaryCard(seq, sessionId, files)` and
  `emptyRunSummaryCard` ("No changed files.").
  `OpenDiffAction.java` + `Actions` registration `open-diff`: payload
  `{sessionId, path}`, replays recorded write/edit tool-use payloads via
  `EventLog.list(sessionId, 0)` into one hunk `{header, lines}`, emits
  `setState(chat_right_panel, true)`, `setState(chat_diff_file, path)`,
  `patch(right-panel-diff-view, diffViewNode(content, true))`, toast.
- `diff_view` is decorative until T311: the ui-kit builder throws without the
  demo marker (`docs/sdui.md` §2.6). T310 passes `demo(true)`; remove it when
  T311 lands.
- D-6 (plan ruling): changed files come from run events, never from git.
- T309 plan deviation (recorded): double-answer rejected with 200 + error
  toast, not 409/4xx — see `.sisyphus/evidence/T309/double-answer.txt`.

## 4. Workflow quirks in this environment

- Subagent (`build`) sessions die mid-chunk (compaction) and may still have
  finished the work: **always** check `git status` / `git log` before redoing
  anything; resume the same session via `task_id` ("Execute Next now — edits
  first") or start the next micro-chunk.
- The `Sisyphus-Junior` agent type is broken here (hook ZodError + 3-turn cap);
  use `build`.
- QA scripts follow `scripts/qa/t308.sh` / `t309.sh` end to end.
- Commit messages are English; one milestone message per the plan's Commit
  lines. Never rewrite history; push only when asked.
- Repo rules still hold: `kernel/` and `sdk/` are frozen for this plan; no new
  Ui primitive names (68-name catalog); zero external binaries in tools.

## 5. After T310d

Next milestone is T311 per the plan (the real diff view — the point where the
`diff_view` demo marker can go away). Read the T311 section of
`jhin-t3code-experience-plan.md` and follow the same micro-chunk loop.
