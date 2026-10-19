// Fractional order keys and the order of pinned and active threads follow T3 Code
// (MIT, see THIRD_PARTY_NOTICES.md): packages/client-runtime/src/state/threadSort.ts.

const DIGITS = "abcdefghijklmnopqrstuvwxyz";

/** Parses a time; null when absent or unreadable. */
function toSortableTimestamp(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function isValidOrderKey(key: string): boolean {
  if (key.length === 0) return false;
  for (const char of key) if (!DIGITS.includes(char)) return false;
  // A trailing minimum digit would leave no room to sort a key just before
  // this one; generators never produce it, so it counts as corrupt.
  return key.at(-1) !== DIGITS[0];
}

/** The midpoint of two digit strings read as fractions in (0, 1); "" is the open bound. */
function midpoint(a: string, b: string): string {
  if (b !== "" && a >= b) throw new Error("midpoint: bounds out of order");
  if (b !== "") {
    let n = 0;
    while ((a.charAt(n) || DIGITS[0]) === b.charAt(n)) n += 1;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a === "" ? 0 : DIGITS.indexOf(a.charAt(0));
  const digitB = b === "" ? DIGITS.length : DIGITS.indexOf(b.charAt(0));
  if (digitB - digitA > 1) return DIGITS.charAt(Math.round((digitA + digitB) / 2));
  if (b.length > 1) return b.charAt(0);
  return DIGITS.charAt(digitA) + midpoint(a.slice(1), "");
}

/**
 * A key that sorts strictly between two neighbours; null bounds are the ends
 * of the list. Null instead of a throw when the keys are corrupt or out of
 * order: the caller then rewrites the list's keys.
 */
export function orderKeyBetween(before: string | null, after: string | null): string | null {
  const a = before ?? "";
  const b = after ?? "";
  if (a !== "" && !isValidOrderKey(a)) return null;
  if (b !== "" && !isValidOrderKey(b)) return null;
  if (b !== "" && a >= b) return null;
  return midpoint(a, b);
}

/** `count` keys spread evenly, for rewriting a whole list. */
export function spreadOrderKeys(count: number): string[] {
  let width = 2;
  let space = DIGITS.length ** width;
  while (space <= (count + 1) * 2) {
    width += 1;
    space *= DIGITS.length;
  }
  const step = space / (count + 1);
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let value = Math.round(step * (i + 1));
    if (value % DIGITS.length === 0) value += 1;
    let key = "";
    for (let digit = 0; digit < width; digit += 1) {
      key = DIGITS.charAt(value % DIGITS.length) + key;
      value = Math.floor(value / DIGITS.length);
    }
    keys.push(key);
  }
  return keys;
}

export interface OrderAssignment {
  readonly id: string;
  readonly orderKey: string;
}

/**
 * The keys to write so that `movedId` sits where `orderedIds` has it: one key
 * between its neighbours when they have keys, else new keys for the whole
 * list. `keysById` includes rows that are not shown (another project's): their
 * keys are kept clear of, and they get no writes.
 */
export function planReorder(input: {
  readonly orderedIds: readonly string[];
  readonly keysById: ReadonlyMap<string, string | null | undefined>;
  readonly movedId: string;
}): OrderAssignment[] {
  const { orderedIds, keysById, movedId } = input;
  const shown = new Set(orderedIds);
  const reserved = new Set(
    [...keysById].flatMap(([id, key]) => (!shown.has(id) && key != null ? [key] : [])),
  );
  const movedIndex = orderedIds.indexOf(movedId);
  if (movedIndex === -1) return [];
  const beforeId = movedIndex > 0 ? orderedIds[movedIndex - 1]! : null;
  const afterId = movedIndex < orderedIds.length - 1 ? orderedIds[movedIndex + 1]! : null;
  const beforeKey = beforeId === null ? null : (keysById.get(beforeId) ?? null);
  const afterKey = afterId === null ? null : (keysById.get(afterId) ?? null);
  if ((beforeId === null || beforeKey !== null) && (afterId === null || afterKey !== null)) {
    let key = orderKeyBetween(beforeKey, afterKey);
    while (key !== null && reserved.has(key)) key = orderKeyBetween(key, afterKey);
    if (key !== null) return [{ id: movedId, orderKey: key }];
  }
  const keys = spreadOrderKeys(orderedIds.length + reserved.size)
    .filter((key) => !reserved.has(key))
    .slice(0, orderedIds.length);
  return orderedIds.flatMap((id, index) => {
    const key = keys[index]!;
    return keysById.get(id) === key ? [] : [{ id, orderKey: key }];
  });
}

interface Orderable {
  /** Unique across nodes. */
  readonly key: string;
  readonly createdAt: string;
  readonly orderKey: string | undefined;
}

/** Pinned threads: those with a key by key, then the rest newest first (T3's sortPinnedThreadsByOrderKey). */
export function sortPinned<T>(items: readonly T[], of: (item: T) => Orderable): T[] {
  const keyed = items.filter((item) => of(item).orderKey !== undefined);
  const keyless = items.filter((item) => of(item).orderKey === undefined);
  keyed.sort((left, right) => {
    const a = of(left);
    const b = of(right);
    return a.orderKey! < b.orderKey!
      ? -1
      : a.orderKey! > b.orderKey!
        ? 1
        : a.key.localeCompare(b.key);
  });
  keyless.sort(
    (left, right) =>
      (toSortableTimestamp(of(right).createdAt) ?? 0) -
        (toSortableTimestamp(of(left).createdAt) ?? 0) || of(left).key.localeCompare(of(right).key),
  );
  return [...keyed, ...keyless];
}

/**
 * Active threads (T3's sortActiveThreadsByOrderKey): those never dragged first,
 * newest first by when they were created or came back from the shelf; then the
 * dragged ones by key.
 */
export function sortActive<T>(
  items: readonly T[],
  of: (item: T) => Orderable & { readonly unsettledAt: string | undefined },
): T[] {
  const anchor = (item: T) =>
    Math.max(
      toSortableTimestamp(of(item).createdAt) ?? 0,
      toSortableTimestamp(of(item).unsettledAt) ?? 0,
    );
  return items.toSorted((left, right) => {
    const a = of(left);
    const b = of(right);
    if (a.orderKey === undefined && b.orderKey !== undefined) return -1;
    if (a.orderKey !== undefined && b.orderKey === undefined) return 1;
    const order =
      a.orderKey !== undefined && b.orderKey !== undefined
        ? a.orderKey < b.orderKey
          ? -1
          : a.orderKey > b.orderKey
            ? 1
            : 0
        : anchor(right) - anchor(left);
    return order || a.key.localeCompare(b.key);
  });
}
