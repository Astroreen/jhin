import type { ConfigCall } from "./config-change.ts";

/** A comment written directly above a key of a config file (D81). */
export interface ConfigReadComment {
  /** The key's path inside its section; `[]` for the section's own key. */
  readonly path: readonly string[];
  readonly text: string;
}

/** What `host.config.get` answers for one section; secrets come redacted (security.md D417). */
export interface ConfigRead {
  /** Absent when the section is not defined or its value is invalid. */
  readonly value?: unknown;
  readonly error?: string;
  /** Why the effective value is invalid, by dotted path (D84). */
  readonly issues?: readonly { readonly path: string; readonly message: string }[];
  readonly layers: { readonly node?: unknown; readonly project?: unknown };
  /** Comments above the section's keys in the config files (D81); older nodes send none. */
  readonly comments?: readonly ConfigReadComment[];
}

const notFound = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "COMMAND_NOT_FOUND" || code === "METHOD_NOT_FOUND";
};

/**
 * Reads `sections` of a node (config-ui.md D1624): `host.config.sections` in
 * one call where the node has it; else one `host.config.get` per section, all
 * in flight together. `onSection` gets each section as its answer lands; a
 * section whose read fails lands with the failure as its `error`. Resolves
 * with every section once all have landed.
 */
export async function readConfigSections(
  call: ConfigCall,
  sections: readonly string[],
  onSection?: (section: string, read: ConfigRead) => void,
): Promise<ReadonlyMap<string, ConfigRead>> {
  const read = new Map<string, ConfigRead>();
  const land = (section: string, answer: ConfigRead) => {
    read.set(section, answer);
    onSection?.(section, answer);
  };
  if (sections.length === 0) return read;
  try {
    const answer = (await call("host.config.sections", { sections: [...sections] })) as {
      sections: Record<string, ConfigRead>;
    };
    for (const section of sections) {
      land(
        section,
        answer.sections[section] ?? { error: `The node did not read ${section}`, layers: {} },
      );
    }
    return read;
  } catch (error) {
    if (!notFound(error)) {
      for (const section of sections)
        land(section, { error: (error as Error).message, layers: {} });
      return read;
    }
  }
  // A node older than D1624.
  await Promise.all(
    sections.map(async (section) => {
      try {
        land(section, (await call("host.config.get", { section })) as ConfigRead);
      } catch (error) {
        land(section, { error: (error as Error).message, layers: {} });
      }
    }),
  );
  return read;
}
