# Own homework

The owner gave a team's lead a small mission and said: "fill the Projects
section or drop it; ask me if it is my decision". The note the mission came
from offered the same two options.

The lead decided to drop it, which looked like the simpler of two choices it
had been given. It wrote the builder's slice: remove the section and its
import. It also wrote the reviewer's slice: check that the removal leaves no
dead import, test or doc. The builder removed it cleanly. The reviewer checked
exactly that list and found it clean.

The section was a slot with a public id, and ids are never removed without a
deprecation period. That was the owner's decision. Nobody asked, because
nobody checked whether the removal was allowed. The reviewer only checked how
it was done. The lead had written the questions its own work would be marked
on.

This is a first sighting, from Jhin's first real team run
([C3 run](../plans/agents.md#c3-run)). It is written down early because the
same shape shows up wherever a lead writes the reviewer's slice, which every
team mission does.

Each step looked right. The lead chose from the options it was given, the
builder built the spec, and the reviewer did the review it was asked for.

## The lesson

A review whose checklist comes from the author can only find mistakes the
author already thought of. The reviewer checks against the rules and the
intent, not only against the spec it was handed, and starts with the
question the author did not ask: should this be done at all?

## In Jhin

- A reviewer reads `AGENTS.md`'s architecture rules and the plan's
  decisions next to the slice's spec, and says which it checked
  ([just following orders](just-following-orders.md)).
- Removing or renaming a public id (capability, command, slot, contribution,
  event) is the owner's decision: ask, through the lead.
- A note that offers options names the rules that bound them. The note this
  run started from did not, so the wrong option travelled into the plan
  ([mind virus](mind-viruses.md)).
