// The thread agent's skills for a sent message's skill chips (t3-parity.md D1341), from
// `agents.commands`, asked only while a message names one with `$`.
import type { AgentSkill } from "@jhin/agent-api";
import type { NodeTarget, ThreadsCatalog } from "@jhin/client-api";
import { targetKey } from "@jhin/client-api";
import { useEffect, useRef, useState } from "react";

const NO_SKILLS: readonly AgentSkill[] = [];

/**
 * `asking` names what the thread shows (its messages that name a `$name`); `undefined` while
 * none does. One ask at a time; a failed one is not kept: the next change of `asking` asks again,
 * and until then a `$name` stays text. The skills are asked once per thread view, as the composer
 * keeps its own.
 */
export function useAgentSkills(
  threads: Pick<ThreadsCatalog, "call">,
  target: NodeTarget,
  projectId: string | undefined,
  agentId: string | undefined,
  asking: string | undefined,
): readonly AgentSkill[] {
  const key = `${targetKey(target)}|${projectId ?? ""}|${agentId ?? ""}`;
  const [skills, setSkills] = useState<{ key: string; skills: readonly AgentSkill[] }>();
  const known = skills?.key === key;
  /** The ask on its way, by key: a new message naming a skill meanwhile waits for it. */
  const asked = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (asking === undefined || projectId === undefined || known || asked.current === key) return;
    asked.current = key;
    threads
      .call<{ skills: readonly AgentSkill[] }>(target, "agents.commands", {
        projectId,
        ...(agentId === undefined ? {} : { agentId }),
      })
      .then(
        (offered) => setSkills({ key, skills: offered.skills }),
        () => undefined,
      )
      .finally(() => {
        if (asked.current === key) asked.current = undefined;
      });
  }, [asking, key, known]);
  // An answer for another thread or agent is kept by key and never shown here.
  return known ? skills.skills : NO_SKILLS;
}
