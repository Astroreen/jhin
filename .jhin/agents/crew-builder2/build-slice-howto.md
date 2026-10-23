# Building a slice here (learned in generation 1)

- Tools: `node_modules/.bin/vp` (not on PATH); wrap every heavy command in `~/.t3/jhin-heavy`.
  `pnpm`: `npx pnpm@11.25.0`; a new workspace dependency needs `install --offline`, which edits only that package's lock entry.
- `slices_prove` items are `{kind:"command", command, output}` only (also screenshot/link). No "note" kind: put the file list in the last item's output.
- `vp check --fix <files>` also formats docs/plans/agents.md; it is shared with the other builder, so edit only your lines.
- Decisions go at the end of the owning plan section (A4 has a "D672–D680 stay reserved" line: insert before it); Deferred lines are struck through as `~~...~~ A4, D1285.`.
- Web view components have no render harness except `*.browser.test.tsx` (vitest browser works; `createRoot` + `act`). Prefer pure helpers in `route.ts`/`lib/*.ts` and unit-test those.
- A test seam without a new command: find an observable difference (e.g. a cached library vs a rebuilt one fails differently) and add a control assertion before the event.
- In a shared checkout, a typecheck error in the other builder's file is mid-edit: filter it out, rerun later.
- Retry/backoff in a store: inject `delay(run, ms) => cancel` as a last parameter (missions store idiom) and drive it in tests with a fake that records `{run, ms}`; reset the pause on the first delivered event, not on subscribe (else a stream rejected at once loops at the first pause).
- A test that waits for a stream subscription needs a "followed" promise from the fake client; `await until(ready)` resolves before the streams exist.
- Editing a file with `python3` string replace: `vp check --fix` rewraps code, so a later replace on the same text can silently miss; assert the replace happened.

## Lessons from D1288/D1289 (Mission 3)

- A compaction can land a second slice handoff on top of an unfinished one: check `slices_get` and `git diff` for each before trusting the summary; prove each slice with its own files.
- `~/.t3/jhin-heavy` can queue for minutes ("all 3 slots busy"); the harness moves the command to background after 120 s. Wait for its notification, don't re-run.
- Guarded browser storage: pure helper in `lib/` taking `Pick<Storage,"getItem"|"setItem"> | undefined` (unit-tested with a map), plugin passes `globalThis.localStorage` in try/catch; plugin tests use `vi.stubGlobal("localStorage", …)` + `afterEach(vi.unstubAllGlobals)`.
- Lint warns on shadowed names (`form`, `start`): name test locals distinctly.
- Modes places only apply on the same node (`kept.node === route.node`): test data needs `node`.

## Lessons from D1294 (public-ids)

- `scripts/public-ids.ts`: one `ID` regex with two groups (double-quoted, template) + `idOf(first, template)`; every declaring pattern/extractor must use both groups. Test the extractor with a template-literal string inside a test template (escape backticks and `${`).
- Slot extraction from `slots.contribute("x", …)` adds the slot id too: include it in expected sets.
- `agents_send` takes `body`, not `message`.

## Lessons from D1295 (tombstone deletes)

- Cross-plugin "is X active" without a dependency: add a `before` hook in the api package (like `missions.step` / `missions.deleting`), the owning plugin answers by throwing its own coded error. Test it with an extra plugin passed into the test node helper.
- A fold that deletes must not early-return when the parent record is missing (health's sensors fold may have slices without their mission); remove dependants regardless.
- Orchestrator tests that continue after a step: put destructive calls (delete) at the end of the test, not mid-way.
- `expect.poll` counts as polling: await a `Promise.withResolvers()` resolved by a callback instead.
- A new service for a view component (e.g. `dialogs`) goes in `shared` in `plugins/missions/index.tsx` and `MissionsServices` in view.tsx.
