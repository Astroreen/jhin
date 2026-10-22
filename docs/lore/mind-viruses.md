# Mind virus

A wrong idea got written into a note. The next agent read the note and
learned "this is how we do things here", then taught the idea to others in
its own notes, handoffs and code comments.

In OpenRig's fleet the owner would correct one agent, and it would pick up
the same idea again from a file on another machine. Some of these took weeks
to untangle. What lets a good idea spread also spreads a bad one.

The cure came from epidemiology. A rig of agents traced where the idea came
from and which files and agents carried it, then corrected every copy
("memetic vaccines"). The idea kept coming back, so the lasting fix was early
detection: watch for it instead of cleaning up after it.

## The lesson

Correcting the agent is not enough. Find the written source it learned from
and fix that, then every copy. What is written down for agents is a medium of
infection as much as of knowledge.

## In Jhin

- Every fact has one source of truth (see [`../README.md`](../README.md#how-knowledge-is-arranged)).
  Link to it, do not copy it, so a correction lands everywhere at once.
- When you find an agent doing something wrong "because the docs said so",
  fix the docs in the same PR and search for other copies of the wrong idea:
  docs, comments, prompts, memory files.
- Canon outranks notes ([maturity](../README.md#maturity)). A note that
  contradicts canon is a symptom, not a source.
