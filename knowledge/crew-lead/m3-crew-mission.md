# M3 crew mission (2026-10-28)

Mission 3d9fe42b-962f-4f79-ae64-ea2b337e8d6e in project m3-crew
(e2518efb-…), on Laptop (node 8466c21d-…).

- Base trap: m3-run-crew branches from main, which lacks D1561–D1564. Those
  live on the unmerged feat/m3-user-settings (D1561) and feat/m3-away-names
  (D1562–D1564). Item 1 (userSettings in the agent form) needs D1561. I asked
  the owner which base to use (ask 5420e7f0-…). Slice b964a1a6 stays blocked
  until they answer.
- D ranges handed out: item 2 (builder2) D1565–D1566, item 3 (builder)
  D1567–D1568, item 1 (builder) D1569–D1570, spare D1571–D1574.
- Shared working tree: builders don't edit docs/plans/agents.md or
  docs/map.md and don't commit. The lead pastes their decision text, moves
  the Deferred item, and commits each item with explicit paths
  (`git commit -- <paths>`). Never push.
- Slices: 300163e0 (item 2, builder2, wave 1), e72c00f5 (item 3, builder,
  wave 1), ebec6532 (review 2+3, reviewer, wave 2), b964a1a6 (item 1,
  wave 2, blocked), 816daeb8 (review item 1, wave 3).

## Owner's answer (2026-10-28)

The owner chose (a): `git merge` feat/m3-user-settings into m3-run-crew, no
rebase. Done as ad7ee47c, and slice b964a1a6 is unblocked (planned, wave 2).
D1562–D1564 (feat/m3-away-names) are still not on m3-run-crew.

## Wave 1 done (20:30)

- Item 2 (builder2): apps/web/src/lib/node-feeds.ts,
  apps/web/src/plugins/inbox/store.ts, apps/web/test/inbox-away.test.ts.
  The proof had no decision text, so I asked builder2 for it.
- Item 3 (builder): packages/missions-api/src/node.ts,
  plugins/orchestrator/test/mesh.test.ts. D1567/D1568 text is in its proof.
  Concern sent to the reviewer: it rewrites caller.id to the agent, which may
  defeat `node:` checks such as D1542's no-relay rule.
- Wave 2 orchestrator: 67c328d0-6414-4a9d-a4a6-6c992ba266b1.

## Item 2's decision text (from builder2, 20:3x)

It re-reads on a mesh change and adds no public id; `meshChanged` is an
internal NodeFeedSource hook. builder2's D1565 text is in their answer
(message d7703f58-…). I take D1565 as the decision. builder2's "D1566" only
lists limits, so those go to Deferred as two M3 lines instead of becoming a
decision: (1) an item that arrives while its sender is already away has no
mark until the next mesh change (agents.inbox.received doesn't carry it);
(2) a member's inbox read through a connection is re-read on that
connection's mesh change, not on the member's own. D1566 stays free.

## Item 2 committed (53167d28)

- Commit: `git add <paths>` + `git commit -F -`. The pre-commit hook runs
  vp fmt on the staged files.
- Item 3: the reviewer confirmed my caller.id concern and set
  changes-requested. Sent back to the builder: keep `node:X` as the caller,
  pass the verified agent to the three `by:` writes only, no Invocation
  field, plus a RELAY_REFUSED test.
- Item 1: the builder is on it (apps/web/src/plugins/agents/form.tsx,
  definition.ts, apps/web/test/agent-form.browser.test.tsx).

## Item 3 committed (dd57629e)

The reworked item 3 was approved and committed with D1567 and D1568, plus a
docs/map.md mention in the @jhin/missions-api row. Only item 1 (b964a1a6)
and its review (816daeb8) remain; after that, the mission's report step.

## Stall 20:37–20:51 (the owner noticed)

- A review slice is done only once its reviewer runs slices.prove on it.
  Recording slices.review on the reviewed slices is not enough. The reviewer
  did only the latter, so ebec6532 stayed active and the orchestrator kept
  waiting in wave 2. Tell reviewers both steps in the handoff spec.
- My slip: the orchestrator wakes the lead only at the end of a wave, so I
  didn't notice that item 1 (b964a1a6) had been proven at 20:34. Check
  missions_get after every commit instead of waiting to be woken.

- 20:52: the reviewer proved ebec6532, so wave 2 ended. Wave 3 orchestrator:
  7c4a61ff-7a6c-4395-aa6d-eab51ac4188d (review of item 1).
- Review check false positive: reviewCheck hashes the whole working tree,
  so in a shared tree every other slice's work marks a reviewed slice
  "changed-after-review". Items 2 and 3 were committed from their reviewed
  files (I checked mtimes against the review time). Worth a Deferred line
  in the M3 run note.

## Wave 3 (20:52)

- The reviewer approved item 1. I sent the test back myself: it used
  `expect.poll` on the fake node, which breaks AGENTS.md's no-polling rule.
  The builder replaces it with a promise per method resolved by the fake's
  call, then the reviewer re-reviews.
- D1569 and the Deferred strike for item 1 are written in agents.md and
  map.md, uncommitted. The builder's "D1570" only said "no new id", so it
  was folded into D1569. D1566, D1570 and D1571–D1574 stay free.
- Reviewers miss the no-polling rule: name it in review specs.

## Done (20:57)

Item 1 committed as 20a4b1c7, and the mission is closed as done. Lessons
for next time:
- After every commit, read missions_get or the slices yourself. The owner
  had to prod me twice: verdicts sent to the builder don't reach the lead.
- Review slices must say "then slices.prove this slice".
- Review specs must name the no-polling test rule.
- reviewCheck hashes the whole working tree, which is wrong for a shared
  checkout.
