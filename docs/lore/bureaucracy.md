# Bureaucracy

A build went wrong, so an agent added a check that would catch the mistake
next time. It worked, it became part of the process, and other agents
learned it. So far so good.

Later an agent forgot the check and the mistake came back. Checks had
worked before, so a check was added to make sure the first check ran. That
needed evidence that the first check happened, and the evidence needed
someone to check it. Checks piled up because checks now needed proof.

Before long, completing the process was what everyone was trying to do.
This is a _coordination pathology_: something that made the system work
starts making it dysfunctional, and the rules come to matter more than what
they serve.

A variant is the **recursive proof loop**. The task is done, and agents keep
improving the proof that it is done. Good proof is core to a good system. The
disproportionate effort is the bad habit, and it spreads through a group
easily.

## The lesson

Watch ceremony (checks, handoffs, approvals, evidence) against progress. When
ceremony grows and the work does not move, stop adding process and ask what the
process was for.

## In Jhin

- AGENTS.md asks for **the smallest proof**: only the affected tests, files
  and packages. Full runs belong to CI. Proof is sized to the change, not
  maximised.
- A PR's evidence shows the change works, once. Do not polish evidence for
  work that is already proven.
- Before adding a rule to AGENTS.md, check whether a story here already
  covers it, or whether the rule fixes one case of a pattern.
