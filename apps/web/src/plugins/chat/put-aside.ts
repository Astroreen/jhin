// The draft a prefilled answer puts aside (docs/plans/t3-parity.md D1001). T3 keeps a question's
// answer apart from the prompt; Jhin's composer has one text, so while an answer to edit shows,
// the draft waits here and comes back once the questions go.
import { useEffect, useRef, useState } from "react";

export interface PutAside {
  /** A draft is aside: the text shown is an answer, not the thread's draft, and is not saved. */
  readonly active: boolean;
  /**
   * Another device's draft that arrived (D486): while a draft is aside it replaces that one and
   * true is returned; otherwise false, and the caller shows it.
   */
  takeRemote(prompt: string): boolean;
}

export function usePutAside(options: {
  /** The draft the composer keeps: another draft's composer never gets this one back. */
  readonly draftKey: string;
  /**
   * The question showing with an answer to edit: `key` names it (its request and question), so
   * its answer is put in once while it shows.
   */
  readonly seed: { readonly key: string; readonly text: string } | undefined;
  /** Whether questions show at all: once they go, the draft comes back. */
  readonly asking: boolean;
  readonly prompt: string;
  /** Sets the composer's text, its caret at the end. */
  setPrompt(value: string): void;
}): PutAside {
  const [aside, setAside] = useState<{ key: string; prompt: string } | undefined>();
  // The latest, for a remote draft that arrives between renders.
  const asideNow = useRef(aside);
  asideNow.current = aside;
  const put = (next: { key: string; prompt: string } | undefined) => {
    asideNow.current = next;
    setAside(next);
  };

  const seedKey = options.seed?.key;
  useEffect(() => {
    if (options.seed === undefined) return;
    // The first answer of a request puts the draft aside; a later one replaces only the answer.
    if (asideNow.current === undefined) {
      put({ key: options.draftKey, prompt: options.prompt });
    }
    options.setPrompt(options.seed.text);
    // Once per question shown: never again while its answer is edited.
  }, [seedKey]);

  useEffect(() => {
    const kept = asideNow.current;
    if (options.asking || kept === undefined) return;
    put(undefined);
    if (kept.key === options.draftKey) options.setPrompt(kept.prompt);
  }, [options.asking]);

  // Another draft: what was put aside is not its own.
  useEffect(() => {
    if (asideNow.current !== undefined && asideNow.current.key !== options.draftKey) {
      put(undefined);
    }
  }, [options.draftKey]);

  return {
    active: aside !== undefined && aside.key === options.draftKey,
    takeRemote(prompt) {
      const kept = asideNow.current;
      if (kept === undefined || kept.key !== options.draftKey) return false;
      put({ ...kept, prompt });
      return true;
    },
  };
}
