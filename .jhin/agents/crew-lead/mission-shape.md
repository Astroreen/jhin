# Running a mission with one shared checkout

All crew members work in the same checkout (/tmp/jhin-l3-run/repo); builders'
home project is the repo, there is no per-builder worktree.

- `missions.orchestrate` ends after every wave (`wave-done`) and wakes the
  lead: commit approved work there, then run it again.
- The mission step `commit` (review: true) is refused unless EVERY done slice
  was reviewed on the current tree of the whole checkout (D1242, `git.tree`:
  untracked files count, ignored ones don't). Pipelining reviews beside the
  next builds makes it refuse forever. What works: a build wave, then a
  review-only wave, then the step, then commit. Builders are fast (~2 min a
  slice), so this costs little.
- Since D1261 (node runs it from 2026-10-23) a review's tree leaves
  `.jhin/agents/` out: notes no longer make reviews stale. Other untracked
  files still do.
- Builders never commit; the lead commits each approved slice by pathspec.
  `docs/plans/agents.md` and `docs/map.md` are shared: stage only that
  item's hunks with /tmp/jhin-l3-run/lead-tools/stage-hunks.py <regex> <files>
  (context diffs; `--unidiff-zero` misplaced a paragraph once). After the
  last item, `git status` must be clean but for `.jhin/`.
- Slices that share files go to the same builder, after the earlier one is
  committed.
- The reviewer's first reviews were 30-second test reruns; tell it what to
  read and what to answer, then it reviews properly.

- The check covers committed slices too: before each `commit` step every done
  slice of the mission is re-recorded on the current tree (Deferred in L2).
- Teammates' note files under `.jhin/` change the tree as well; tell them to
  write notes only after a commit.

First mission (2026-10-23): eight agents.md Deferred items, D1271–D1278,
mission 95f01c28-1e97-47b0-be61-fdd381504cb9, closed done with commits
f751b8ab..aeac3945 on l3-run/crew. D1279–D1280 left unused.

Second mission (2026-10-23): seven items, D1281–D1287, mission
4ad1d431-febe-4ddc-94e4-ae269cfc113f. Waves: build (4) → review → commit →
build (3) → review → commit. Specs now tell builders and reviewer not to
write in `.jhin/` until the commit is in, and the review spec asks for code
reading with concrete answers. Closed done: 6c775f6a..a5eaaca8.

- stage-hunks.py matches by regex on changed lines: a multi-line struck
  Deferred item whose `~~` opening line lacks the D number lands in another
  hunk and is left behind. After each wave's commits `git status` must be
  clean; fix leftovers with `git commit --fixup=<sha>` and
  `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash <base>`, then count `~~`
  per commit.
- Since D1263 an open `agents_ask` of the lead holds only the slices the lead
  blocked (create the slice with status `blocked` first); before it, D1223
  held every mission. So ask the owner with `agents_ask` and block that slice.
- Third mission (c473e01c, D1288–D1295): the owner answered the item-8
  question (deleting missions as tombstones, amends D651) within minutes;
  the other seven ran meanwhile. Orchestrator re-hands review slices that
  were already proved ("duplicate handoff"); the reviewer just says so.
- Telling the reviewer what to check (concrete questions per slice) gives
  real reviews; the second-generation reviewer did it well from the spec.
- Fourth mission (17867ecd, D1296–D1300): A2 header hiding, A1 settle on
  rotate (lead decided: settle, config `settlePreviousGeneration`), A8 re-ask
  on `agents` events, A3 missions of a deleted project (owner: keep them,
  reachable; nothing deleted as a side effect). Closed done b5efd975..9b925161.
- A blocked slice in the current wave makes `missions.orchestrate` return
  `decide` at once, without waiting for the other slices' proofs: move the
  blocked slice to a later wave.
- Build waves, then ONE review slice (`reviews` = all build slices) in the
  last wave works. A fix after a review makes every slice stale
  (changed-after-review, the tree is the whole checkout): ask the reviewer to
  record all reviews again on the final tree before taking `commit`.
- The reviewer sometimes sends change requests to the wrong builder; name
  the assignee in the review spec.
