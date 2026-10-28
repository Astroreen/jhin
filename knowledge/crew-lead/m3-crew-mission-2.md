# M3 crew mission 2 (2026-10-28, from 20:58)

Mission 3d846c75-be4a-494d-9452-25350562d941, with the same rules as
mission 1 (see m3-crew-mission.md). Decisions: item 1 D1570, item 2 D1571,
item 3 D1572–D1573, spare D1574. The owner said D1570–D1574 this time.
D1566 is still unused but not offered.

Slices:
- d1beef31 item 1, away-since survives a restart (builder2, wave 1).
- 9c282d65 item 3, teams.down removes agents (builder, wave 1). BLOCKED on
  the owner's decision (ask d943f9ac-…). My recommendation is A,
  `teams.down { remove: true }`: per-member errors, generations and
  knowledge kept, roster dropped.
- 4d6afa10 item 2, health warns of a run's node away (builder, wave 2). It
  depends on d1beef31: same file, plugins/health/src/sensors.ts.
- Reviews: b0d2d9e0 (item 1) and c59a06c1 (item 3) in wave 2, b6f265f7
  (item 2) in wave 3. Their specs say "prove THIS slice" and "send the
  verdict to lead@crew".

Orchestrator: de0f146d-64d9-4c36-8d5f-e30776e5b2d7 (wave 1).

The owner may take Server (builder2 and the reviewer) down on purpose. Let
the design handle it: slices wait, and health warns (D1548). Don't reassign.
After each commit, read missions_get myself instead of waiting to be woken.

- Orchestrator trap: a blocked slice in a wave makes the run end at once
  with outcome "decide", and then nobody waits on the other slices'
  proofs. Keep a blocked slice in a later wave. I moved item 3 to wave 2
  and its review to wave 3, then started the orchestrator again for wave 1.

## The owner's decision on item 3 (21:11)

Option A: `teams.down { remove: true }`. An away member is reported per
member and the call goes on; generations and knowledge stay, as with
teams.leave. Slice 9c282d65 is unblocked, moved back to wave 1 and handed
to the builder directly with slices_handoff, while orchestrator 0bd35e06
runs wave 1. Its review c59a06c1 is back in wave 2. If the running
orchestrator doesn't wait for 9c282d65's proof, check the slice myself.

## Wave 1 done (21:14)

- Item 1 (builder2) touched: packages/testing/src/mesh.ts (startMeshNode
  `members` option), plugins/health/package.json (optional storage.kv@^1),
  plugins/health/src/index.ts, sensors.ts, test/sensors.test.ts, and the new
  test/away-restart.test.ts. Its decision text hasn't reached me yet.
- Item 3 (builder) touched: packages/agent-api/src/teams.ts,
  plugins/teams/src/index.ts, plugins/teams/test/teams.test.ts. The D1572
  text is in the builder's message 57be9b86.
- Wave 2 orchestrator: 2dfb4cc1-5276-4ca1-be55-b5493e05afa3. I told the
  builder to HOLD item 2 until item 1 is committed: same file, sensors.ts.

## Items 1 and 3 committed (21:17)

- My hold on item 2 arrived too late: it was queued while the builder was
  already in a turn, and they had started editing sensors.ts. That's fine.
- Way out: a review records `work.tree`, a real git tree of the reviewed
  working dir. Stage the reviewed blobs (`git update-index --cacheinfo
  100644,$(git rev-parse $T:$f),$f`) and commit, and the commit is exactly
  what was reviewed while the later edits stay in the working tree. Then
  check HEAD:$f against $T:$f. The pre-commit vp fmt didn't change them.
- b7e37ae4 item 1 (D1570, plus a Deferred line on flapping and stale
  entries); 5094047f item 3 (D1572, plus a Deferred line on a failed member
  keeping its definition). D1571 is for item 2; D1573 and D1574 are free.

## The owner's Server outage (about 21:17–21:24)

- Wave 3's orchestrator found the reviewer's slice `away` and ended with
  "decide" (reason away) without waiting. Health raised D1548's away warning
  at 21:17:03 and cleared it (`node-back`) at 21:23:57.
- I waited with missions_wait { away: [slice] }. Its first return said
  changed:true with head 72 while Server was still away, perhaps a flap or
  an unrelated change. The second returned once Server was back, and then I
  started orchestrator cf427f6e for wave 3.
- The run's lead is on Laptop, which stayed up, so D1571's away-run warning
  wasn't exercised by this outage.
- Item 2's D1571 text and Deferred line are written in agents.md and map.md,
  uncommitted.

## Item 2 sent back (21:25)

The reviewer confirmed my concern (a). Making `missions.orchestration`
answer run:null instead of failing lets orchestrate (~1130) start a second
run while the first run's node is away. I chose the opt-in fix: a new
optional input, which only health passes, and the default stays as before.
Once the D1571 text changes, update agents.md (it says "with `run` then
null rather than an error"; add "when asked with <flag>").

## Done (21:28)

Item 2 is 6d86ea19, and the mission is closed as done. Proof-loop lesson
(health warning 56b50bb3): read the slice before writing to its builder.
Don't ask for a proof that is already there, and don't send hold-or-go
corrections to an agent that may be mid-turn. Builders also re-prove just to
fix wording (21:27:13, after the review): tell them a proof is needed only
when the code changes.
