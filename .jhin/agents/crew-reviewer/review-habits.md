# Review habits (learned in the "eight Deferred items" mission)

- Read the code, not only the tests. The lead sent back a first pass that only reran tests. Answer concrete questions in the notes (permissions, failure order, who else calls it).
- Hunt for consumers of a changed contract: a capability minor bump (e.g. `client.modes` 1.1) also needs the *consumers that call the new method* to raise their `requires`/`optional` range. D1273 was changes-requested for exactly that.
- Reviews are tied to the checkout tree: any later edit (even a doc comment) makes earlier approvals "changed-after-review". After the last edit, re-record every done slice's `slices_review` on the final tree, and run nothing that rewrites files (no `vp check --fix`).
- The lead sometimes re-sends a handoff that is already done (duplicates arrive queued). Check `slices_list` first; if the review slice is done, just answer and re-record if the tree moved.
- Shared checkout: judge only the builder's listed files/hunks. When committed slices share files with later waves, confirm with `git diff HEAD -- <file>` that the remaining hunks are additive and belong to others.
- `slices_list` output is huge; save to file and parse with `python3 -I`.
- Heavy commands: `~/.t3/jhin-heavy node_modules/.bin/vp run --filter … typecheck`; tests run fine directly with `node_modules/.bin/vp test run <files>`.
- Before calling a new file "reinvented", look for an existing component (e.g. `@jhin/ui` `Alert`) and say why it does or doesn't fit.
- The review's tree (`git.tree`) takes untracked files in (only ignored ones out), and `.jhin/` is not ignored: writing a note there invalidates earlier approvals. Write notes only after the lead says the commit is in.
- Sequence that worked: review → record `slices_review` → `slices_prove` on the review slice → after the last edit, re-record every done slice's review once, on the final tree.

# Learned in the "Follow and steer a long run" mission, wave 2

- When a fix lands after approvals, re-review it (rerun its test), then re-record every done slice's review once on the final tree; the lead says when the tree is final, and tells you when the commit is in before you write here.
- Reading order that was quick: `git diff HEAD -- <the builder's listed files>` (not the branch diff, it mixes committed slices), then the D-number block in docs/plans/agents.md via `git diff HEAD -- docs/plans/agents.md | grep -A20 "D12xx\."`.
- Detector-style code (health sensors): check that the new "clear" measure mirrors the "raise" measure; a conservative mismatch (late, never wrong) is a nit, a false clear is a blocker. Also look at sibling commands that act on a status (e.g. dismiss) when a new status is added.
- Manifest change (optional capability): compare the form with source-control/threads package.json; the builder runs pack:smoke, rerun only if cheap.

# Wave 4 of the same mission

- Duplicate handoffs of reviews already done arrive after the commit (the same slice id, again). Check `git log`/`git status` and the slice's review first; answer "duplicate, done on tree X, commit Y" and do not re-review.
- To find the ids of wave handoffs the lead did not give: `slices_list` with `missionId`, `assignee` (my address) and `status: active` returns just my review slices (small output).
- For a parser change, probe it by hand without writing in the repo: `node /tmp/probe.mjs` importing the `.ts` source directly (Node 24 strips types). It found the footnote and `//host` edges the tests did not cover. Never drop a probe test file into the repo (it changes the tree).
- An e2e change that cannot be run locally: read `e2e/tests/support/streams.ts` (`follow().until` checks stored events first, so order cannot hang) and check the precondition the new wait relies on is recorded somewhere (here: the struck Deferred text).
- Backoff/retry code: check stop paths (dispose, refresh, connection replaced), a late callback of a superseded attempt, injected timers in tests, and that the pause resets only where the decision says.

# Mission 3 ("Loose ends"), wave 2

- Replay/ordering code (health follows several streams merged in time order): check what the decide step reads. `appendIf` reads the health log to its head before deciding, so a replay cannot double-write; trace both orders (answer first, failure first) instead of trusting the test that covers only one.
- A localStorage key is not one of the five public-id kinds (capability, command, slot, contribution, event) that `scripts/public-ids.ts` guards; say so in the notes and check that nothing secret (tokens) reaches it.
- Every mission re-sends each review handoff after it is done and committed: check `git log` for the commit and answer "duplicate" in two lines.

# Mission 3, wave 4

- Reading the code beat the lead's framing twice: "is a client-side schema failure told apart?" (no: no client parse exists, so no code => passing; the decision text already said so) and the node-warning-first precondition of an e2e (find it recorded in the struck Deferred text). Check the decision text against the code before asking for a change.
- A new client command: compare its registration with a sibling (`civilization.agent.open`), the map row, and run `node scripts/public-ids.ts --list | grep <name>` (reads the working tree, so it sees uncommitted ids).
- A forged-sender check should compare against the address the node resolved (`agents.conversation` `with`), not a string the view builds.
- After the lead edits a doc in the commit step, re-record every review once more on that tree; it is cheap (one call per slice, short notes).

# Mission 3, wave 6 (deleting records)

- When a feature adds a tombstone/removal event, list every fold consumer by grepping `applyMissionEvent`-style imports (`grep -rln "<Events>\|apply<X>Event"`): if they all fold through the shared function, a removed record is just absent; then check only the code that does special things around events (health's ingest, orchestrator's report path) and the UI's not-found path.
- A "before" hook that refuses (here `missions.deleting` → RUN_ACTIVE): check it is declared beside its sibling hook, named in the map row and the decision, that no handler = allowed, and note the check-then-act window (same as missions.step) instead of blocking on it.
- A review of an already-committed slice arrives again after the commit: compare `git log` first and answer "duplicate".
