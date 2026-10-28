# Nobody's turn

A team of four worked a mission across two machines. The reviewer recorded
both of its verdicts and reported them to the lead. The lead read the
report, committed the approved items, and waited for the orchestrator to
wake it at the end of the wave. The orchestrator waited for the review
slice's proof. The builders had nothing handed to them. Every agent was
idle, and every one of them was right: each had done its part and was
waiting for the next signal from someone else.

Nothing was broken, so nothing complained. The orchestrator's wait timed out
every ten minutes and simply started again. After fourteen minutes the owner
noticed that the streams had gone quiet and asked the lead what the mission
was waiting for. The lead found it in a minute: the review slice had never
been proven, because its handoff named the verdicts and not the proof.

Half an hour later it happened again in another shape. The builder asked the
reviewer to look at a changed test, and the reviewer sent its approval back
to the builder. The lead, whose run had ended, waited for an approval that
nobody was going to send it.

This is a first sighting, from the [M3 run](../plans/agents.md#m3-run), and
an echo of the [C3 run](../plans/agents.md#c3-run), where the owner heard
nothing back.

## The lesson

A wait is a promise that someone will speak. When everyone waits, check who
holds the next turn. If the answer is nobody, the team has stopped, however
calm it looks. Silence is not progress. A process has to notice when nobody
holds the next step and hand it to someone who can take it.

## In Jhin

- A wait that ends with nothing moved, while the agents at work are idle,
  wakes the lead with the slices nobody works on (D1575).
- A handoff names everything that closes the slice, not only the work
  (D1576). A verdict goes to whoever handed out the review (D1577).
- An owner who sees quiet streams and idle agents asks the lead what the
  mission waits for. That question is cheap, and it found both stops.
