// Bounding a terminal's history follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// BoundedTerminalHistory in apps/server/src/terminal/Manager.ts.

/** What a session keeps of its output: lines and UTF-8 bytes. */
export interface HistoryLimits {
  readonly lines: number;
  readonly bytes: number;
}

/** What the kept output adds up to. */
export interface KeptCount {
  /** `\n` characters. */
  lineBreaks: number;
  /** UTF-8 bytes. */
  bytes: number;
  /** The newest output ends with `\n`: its last line is complete, not one more. */
  endsWithNewline: boolean;
}

export interface TrimPlan {
  /** Output events to forget whole, by sequence. */
  readonly forget: ReadonlySet<number>;
  /** The oldest event left, cut at its start: its new data. */
  readonly cut?: { readonly sequence: number; readonly data: string };
}

export const lineBreaks = (data: string): number => {
  let count = 0;
  for (let index = data.indexOf("\n"); index !== -1; index = data.indexOf("\n", index + 1)) {
    count += 1;
  }
  return count;
};

/** Lines as T3 counts them: an unterminated last line is one more. */
const lineCount = (count: KeptCount) =>
  count.lineBreaks === 0 && count.bytes === 0
    ? 0
    : count.lineBreaks + (count.endsWithNewline ? 0 : 1);

/**
 * Forgets the oldest output until what is kept fits `limits`: whole events
 * first, then the oldest one left is cut after a line break (for lines) or
 * at a code point (for bytes, never inside a surrogate pair). `count` is
 * updated to what is left. The newest event is never forgotten whole: a
 * single line longer than the byte limit keeps its end.
 */
export function planTrim(
  outputs: readonly { readonly sequence: number; readonly data: string }[],
  count: KeptCount,
  limits: HistoryLimits,
): TrimPlan {
  const forget = new Set<number>();
  let index = 0;
  /** The oldest event left, as cut so far. */
  let data = outputs[0]?.data ?? "";
  let cutFrom: number | undefined;
  const dropWhole = () => {
    count.lineBreaks -= lineBreaks(data);
    count.bytes -= Buffer.byteLength(data);
    forget.add(outputs[index]!.sequence);
    index += 1;
    data = outputs[index]?.data ?? "";
    cutFrom = undefined;
  };
  const cutAt = (offset: number) => {
    const dropped = data.slice(0, offset);
    count.lineBreaks -= lineBreaks(dropped);
    count.bytes -= Buffer.byteLength(dropped);
    data = data.slice(offset);
    cutFrom = outputs[index]!.sequence;
  };
  const last = () => index >= outputs.length - 1;

  let linesToDrop = lineCount(count) - limits.lines;
  while (linesToDrop > 0 && index < outputs.length) {
    const breaks = lineBreaks(data);
    if (breaks < linesToDrop || (breaks === linesToDrop && data.endsWith("\n") && !last())) {
      if (last()) break;
      linesToDrop -= breaks;
      dropWhole();
      continue;
    }
    let offset = 0;
    for (let line = 0; line < linesToDrop; line += 1) offset = data.indexOf("\n", offset) + 1;
    cutAt(offset);
    linesToDrop = 0;
  }

  while (count.bytes > limits.bytes && index < outputs.length) {
    const excess = count.bytes - limits.bytes;
    if (Buffer.byteLength(data) <= excess && !last()) {
      dropWhole();
      continue;
    }
    let offset = 0;
    let bytes = 0;
    while (bytes < excess && offset < data.length) {
      const codePoint = data.codePointAt(offset)!;
      bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
      offset += codePoint <= 0xffff ? 1 : 2;
    }
    cutAt(offset);
  }
  return cutFrom === undefined ? { forget } : { forget, cut: { sequence: cutFrom, data } };
}

/** The tail of `text` within `limits`, as a session would keep it. */
export function boundHistory(text: string, limits: HistoryLimits): string {
  if (text.length === 0) return text;
  const count: KeptCount = {
    lineBreaks: lineBreaks(text),
    bytes: Buffer.byteLength(text),
    endsWithNewline: text.endsWith("\n"),
  };
  const plan = planTrim([{ sequence: 0, data: text }], count, limits);
  return plan.cut?.data ?? text;
}
