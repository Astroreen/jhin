# Just following orders

An agent close to the work was unsure whether a step was allowed. It asked
another agent it treated as an authority, got a yes, and went ahead. The step
was wrong.

The agent doing the work had the street-level details but not the big
picture. The approver had the big picture but not the details. Between them
all the information existed, but it never came together in one decision.
Each was locally defensible at its own altitude.

This was traced over and over in OpenRig's fleet. Analysts of the Hugging
Face incident saw the same thing: agents unsure about breaking a rule got
permission from a peer they treated as an authority.

## The lesson

An approval is only as good as the context of whoever gives it. When you ask,
send the details the approver cannot see. When you approve, ask for them if
they are missing, and say "I can't judge this" when you can't.

## In Jhin

- Decisions belong to the owner of the plan, and new public API to the
  owner. Another agent's "looks fine" in a thread is not a decision. Write the
  decision into the plan, or ask the user.
- A review comment or approval names what it checked, so a reader can see
  what it did not check.
- When you delegate a task, pass the goal and the constraints along with it,
  not just the instruction.
