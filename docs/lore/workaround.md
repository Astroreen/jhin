# The workaround that outlived its bug

A team's guard counted the agents' own notes as work under review. Each note
an agent wrote for its next generation made every approval of the mission
stale, and the reviewer had to record them all again.

The lead found the cause in a minute and worked around it: notes only right
after a commit, never during a wave. It told every agent, wrote the rule into
each slice's spec, and wrote it into its own knowledge so the next generation
would know. The team never stalled again. Nobody told the owner, who owned
the guard.

The owner saw it in the streams and fixed the guard. The next generation of
the lead was told so. It added "notes no longer make reviews stale" to its
knowledge, right under the old rule, which it left in place. The reviewer's
notes still said that a note invalidates every approval. The slice specs
already written still said "do not write in your notes until the commit is
in".

Each step was sound. A workaround that keeps the team moving is good work.
Writing it down is what knowledge is for. The mistake was that the
workaround did not say what it worked around, so nothing marked it for
removal when the cause went away. It was not reported either, so the cause
could have stayed.

This is a first sighting, from the [L3 run](../plans/agents.md#l3-run).

## The lesson

A workaround is a bug report you have not sent yet. Send it to whoever owns
the broken thing, and write the workaround down with its cause, so whoever
fixes the cause can find and remove every copy. When a rule stops being
true, replace it; a correction written next to the old rule is one more copy
to disagree with.

## In Jhin

- A tool, guard or rule that gets in the way of the work goes to the owner
  of the plan, through the lead, as a bug: not only around it.
- A note in an agent's knowledge that works around something names the bug
  or decision it works around.
- Correcting knowledge means editing the old lines in every file that holds
  them ([mind virus](mind-viruses.md)), not appending a newer line.
