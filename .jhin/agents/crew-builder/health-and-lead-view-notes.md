# Health clear (D1283) and Lead view tell (D1282): what to know

- Run tools as `export PATH=$PWD/node_modules/.bin:$PATH` then `~/.t3/jhin-heavy vp ...` (vp is not on PATH in the checkout). Browser tests: `vp test run --project browser <file>`.
- Health: `Sensors.clearable()` decides clears from the detector's own measure only (not the narrower-group "quiet" rule). Clear and dismiss both go through `appendIf` and act only on `status === "open"`. After a clear, `after()` counts from `clearedAt` by time (no stream positions).
- Warnings leave the window only with time, so plugin-level tests cannot make a measure drop; test clears at the `Sensors` level and inject events with `log.append(HEALTH_STREAM, ...)`.
- A proof-loop warning in plugin tests needs 3 `slices.prove` calls at maxEdits 2 (the raise is awaited on the third).
- `slices_prove` items accept only kind command | screenshot | link; put notes into a command item's output.
- Lead view: "Tell without waiting" = `agents.send {to, body, messageId}`; unanswered() only counts kind "ask", so told notes show no "No answer" line.

## D1284 (broader warning closes under a narrower one)
- `broaderThanNarrower(health)` in sensors.ts; the plugin's evaluate() runs it after the raises and calls `clear(id, {reason: "narrower", narrowerWarningId})`. `Warning.narrowerWarningId` is the additive field.
- Plugin test trick: messages to an agent no slice names count for the node alone, so the node warns before the mission does.
- The e2e (civilization.spec.ts) is CI-only; say so in the proof instead of running it.
- The other builder's files show in `git status` in the shared checkout: say so to the lead, do not touch them.

## D1291 (late analyst answer) and D1292 (lore brief bound)
- Late answers: `agents.message.answered` for an own ask (OWN_ASK + askedBefore) goes into `answersSeen`; `linkLate(warningId)` runs on the answered event and again whenever a `warningAnalysed` lands (replay order), and records only while the analysis is `failed` (appendIf). `Analysis.late` is the marker.
- Test with a faked clock: `vi.useFakeTimers({ toFake: ["setTimeout","clearTimeout"] })`, await a fact (a promise the stub resolves when reached), then advance. Same pattern for `LORE_BRIEF_TIMEOUT_MS` in agents.test.ts.
- When all 3 heavy slots are busy a foreground `vp` call can pass the 120 s tool timeout: run it with run_in_background and wait with `until [ -s file ]; do sleep 3; done`.

## D1293 (report card) and D1290 (feed retries)
- Plugins in apps/web do not import each other: cross-plugin navigation goes through a client command (`civilization.mission.open`, `civilization.inbox.open`, …). A new one is additive; add it to the plugin's row in docs/map.md.
- Browser tests: `vp test run --project browser <file>`; `toHaveTextContent` matches the whole text, use `getByText(x, { exact: true })` for a part.
- node-feeds: `retryGap(n)`; lasting codes = NOT_THERE + COMMAND_INPUT_INVALID/COMMAND_OUTPUT_INVALID; tests use the injected `clock`/`later` and a `failingFeed(code)` helper.
