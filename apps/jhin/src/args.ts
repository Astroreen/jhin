/** The CLI's arguments: positionals, and options by name. */
export interface Args {
  readonly positionals: readonly string[];
  /** Every `--key value`, `--key=value` or bare `--flag` (true); the last one of a name wins. */
  readonly options: ReadonlyMap<string, string | true>;
  /** Every value of each option, in order, for options that repeat (`--permission`). */
  readonly repeated: ReadonlyMap<string, readonly (string | true)[]>;
}

export function parseArgv(argv: readonly string[]): Args {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  const repeated = new Map<string, (string | true)[]>();
  const set = (key: string, value: string | true) => {
    options.set(key, value);
    repeated.set(key, [...(repeated.get(key) ?? []), value]);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) {
      set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      set(body, true);
    } else {
      set(body, next);
      index += 1;
    }
  }
  return { positionals, options, repeated };
}
