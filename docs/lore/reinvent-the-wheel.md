# Reinvent the wheel

In OpenRig, a Slack integration was nearly finished. It connected Slack to
the messaging primitive the agents already used to talk to each other. The
work was set aside for a month.

When it came back, an agent was asked to finish it. It searched for "Slack",
which was reasonable, and then did what it was asked: Slack worked. But it had
written a whole new messaging system from scratch and connected Slack to that,
right next to the one that already existed.

It was about the hundredth time. Graph databases and memory products did not
stop it. The agent apologised and offered to write a note saying a Slack
integration exists. That fixes this one case and nothing else.

The documentation was all there. The agent did not know that a messaging
primitive existed, so it never thought to ask. **You cannot search for what
you do not know exists.**

## The lesson

The fix is a map read before the search, not a better search: everything
that exists, an inch deep and a mile wide, so the agent recognises "we already
have that" and follows the route to the details.

## In Jhin

- Read [`../map.md`](../map.md) before building anything. If what you need is
  close to something on it, extend that thing.
- If it is not on the map, check [`../plans/t3-roadmap.md`](../plans/t3-roadmap.md):
  a workstream may be building it right now.
- When you add something, add its line to the map in the same PR. A thing
  missing from the map gets built twice.
