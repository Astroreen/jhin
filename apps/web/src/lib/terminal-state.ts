// Ported from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/terminalUiStateStore.ts
// (tabs, split groups, open state and height per thread), apps/web/src/types.ts (the
// defaults) and packages/shared/src/terminalLabels.ts. Kept per device in localStorage.
import { toDisposable, type Disposable } from "@jhin/sdk";

export const DEFAULT_THREAD_TERMINAL_HEIGHT = 280;
const DEFAULT_THREAD_TERMINAL_ID = "term-1";
export const MAX_TERMINALS_PER_GROUP = 4;

export interface ThreadTerminalGroup {
  readonly id: string;
  readonly terminalIds: readonly string[];
  /** Side by side unless "vertical" (stacked). */
  readonly splitDirection?: "vertical";
}

export interface ThreadTerminalUiState {
  readonly terminalOpen: boolean;
  readonly terminalHeight: number;
  readonly terminalIds: readonly string[];
  readonly activeTerminalId: string;
  readonly terminalGroups: readonly ThreadTerminalGroup[];
  readonly activeTerminalGroupId: string;
}

export const DEFAULT_THREAD_TERMINAL_UI_STATE: ThreadTerminalUiState = Object.freeze({
  terminalOpen: false,
  terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
  terminalIds: [],
  activeTerminalId: "",
  terminalGroups: [],
  activeTerminalGroupId: "",
});

function terminalNumber(terminalId: string): string | undefined {
  return /^term(?:inal)?-(\d+)(?:-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})?$/i.exec(
    terminalId,
  )?.[1];
}

/** "Terminal 2" for `term-2`; other ids as they are. */
export function terminalLabel(terminalId: string): string {
  const number = terminalNumber(terminalId);
  return number === undefined ? terminalId : `Terminal ${number}`;
}

/** The tab's name: the program the terminal runs, else its number. */
export function terminalSessionLabel(
  terminalId: string,
  summary: { readonly label?: string } | undefined,
): string {
  const label = summary?.label?.trim();
  return label !== undefined && label.length > 0 ? label : terminalLabel(terminalId);
}

/** The lowest `term-N` not taken. */
export function nextTerminalId(existing: readonly string[]): string {
  const used = new Set(existing.map(terminalNumber));
  let next = 1;
  while (used.has(String(next))) next += 1;
  return `term-${next}`;
}

function normalizeTerminalIds(terminalIds: readonly string[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of terminalIds) {
    const trimmed = id.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ids.push(trimmed);
  }
  return ids;
}

const fallbackGroupId = (terminalId: string) => `group-${terminalId}`;

function assignUniqueGroupId(baseId: string, used: Set<string>): string {
  let candidate = baseId;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${baseId}-${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function normalizeTerminalGroups(
  groups: readonly ThreadTerminalGroup[],
  terminalIds: readonly string[],
): ThreadTerminalGroup[] {
  if (terminalIds.length === 0) return [];
  const valid = new Set(terminalIds);
  const assigned = new Set<string>();
  const next: ThreadTerminalGroup[] = [];
  const usedGroupIds = new Set<string>();
  for (const group of groups) {
    const ids = normalizeTerminalIds(group.terminalIds).filter(
      (id) => valid.has(id) && !assigned.has(id),
    );
    if (ids.length === 0) continue;
    for (const id of ids) assigned.add(id);
    const baseId =
      group.id.trim().length > 0 ? group.id.trim() : fallbackGroupId(ids[0] ?? terminalIds[0]!);
    next.push({
      id: assignUniqueGroupId(baseId, usedGroupIds),
      terminalIds: ids,
      ...(group.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
    });
  }
  for (const id of terminalIds) {
    if (assigned.has(id)) continue;
    next.push({ id: assignUniqueGroupId(fallbackGroupId(id), usedGroupIds), terminalIds: [id] });
  }
  return next;
}

const arraysEqual = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

function groupsEqual(a: readonly ThreadTerminalGroup[], b: readonly ThreadTerminalGroup[]) {
  return (
    a.length === b.length &&
    a.every((group, index) => {
      const other = b[index]!;
      return (
        group.id === other.id &&
        (group.splitDirection ?? "horizontal") === (other.splitDirection ?? "horizontal") &&
        arraysEqual(group.terminalIds, other.terminalIds)
      );
    })
  );
}

function stateEqual(a: ThreadTerminalUiState, b: ThreadTerminalUiState): boolean {
  return (
    a.terminalOpen === b.terminalOpen &&
    a.terminalHeight === b.terminalHeight &&
    a.activeTerminalId === b.activeTerminalId &&
    a.activeTerminalGroupId === b.activeTerminalGroupId &&
    arraysEqual(a.terminalIds, b.terminalIds) &&
    groupsEqual(a.terminalGroups, b.terminalGroups)
  );
}

export function normalizeThreadTerminalUiState(
  state: ThreadTerminalUiState,
): ThreadTerminalUiState {
  const terminalIds = normalizeTerminalIds(state.terminalIds);
  const activeTerminalId = terminalIds.includes(state.activeTerminalId)
    ? state.activeTerminalId
    : (terminalIds[0] ?? "");
  const terminalGroups = normalizeTerminalGroups(state.terminalGroups, terminalIds);
  const activeFromState = terminalGroups.some((group) => group.id === state.activeTerminalGroupId)
    ? state.activeTerminalGroupId
    : null;
  const activeFromTerminal =
    terminalGroups.find((group) => group.terminalIds.includes(activeTerminalId))?.id ?? null;
  const normalized: ThreadTerminalUiState = {
    terminalOpen: state.terminalOpen,
    terminalHeight:
      Number.isFinite(state.terminalHeight) && state.terminalHeight > 0
        ? state.terminalHeight
        : DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds,
    activeTerminalId,
    terminalGroups,
    activeTerminalGroupId: activeFromState ?? activeFromTerminal ?? terminalGroups[0]?.id ?? "",
  };
  return stateEqual(state, normalized) ? state : normalized;
}

function copyGroups(groups: readonly ThreadTerminalGroup[]) {
  return groups.map((group) => ({
    id: group.id,
    terminalIds: [...group.terminalIds],
    ...(group.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
  }));
}

function upsertTerminalIntoGroups(
  state: ThreadTerminalUiState,
  terminalId: string,
  mode: "split" | "new",
  splitDirection: "horizontal" | "vertical" = "horizontal",
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  const effectiveMode = normalized.terminalIds.length === 0 ? "new" : mode;
  if (terminalId.trim().length === 0) return normalized;

  const isNew = !normalized.terminalIds.includes(terminalId);
  const terminalIds = isNew ? [...normalized.terminalIds, terminalId] : [...normalized.terminalIds];
  const groups: { id: string; terminalIds: string[]; splitDirection?: "vertical" }[] = copyGroups(
    normalized.terminalGroups,
  );

  const existingIndex = groups.findIndex((group) => group.terminalIds.includes(terminalId));
  if (existingIndex >= 0) {
    groups[existingIndex]!.terminalIds = groups[existingIndex]!.terminalIds.filter(
      (id) => id !== terminalId,
    );
    if (groups[existingIndex]!.terminalIds.length === 0) groups.splice(existingIndex, 1);
  }

  if (effectiveMode === "new") {
    const groupId = assignUniqueGroupId(
      fallbackGroupId(terminalId),
      new Set(groups.map((group) => group.id)),
    );
    groups.push({ id: groupId, terminalIds: [terminalId] });
    return normalizeThreadTerminalUiState({
      ...normalized,
      terminalOpen: true,
      terminalIds,
      activeTerminalId: terminalId,
      terminalGroups: groups,
      activeTerminalGroupId: groupId,
    });
  }

  let activeIndex = groups.findIndex((group) => group.id === normalized.activeTerminalGroupId);
  if (activeIndex < 0) {
    activeIndex = groups.findIndex((group) =>
      group.terminalIds.includes(normalized.activeTerminalId),
    );
  }
  if (activeIndex < 0) {
    const groupId = assignUniqueGroupId(
      fallbackGroupId(normalized.activeTerminalId),
      new Set(groups.map((group) => group.id)),
    );
    groups.push({ id: groupId, terminalIds: [normalized.activeTerminalId] });
    activeIndex = groups.length - 1;
  }
  const destination = groups[activeIndex];
  if (destination === undefined) return normalized;
  if (
    isNew &&
    !destination.terminalIds.includes(terminalId) &&
    destination.terminalIds.length >= MAX_TERMINALS_PER_GROUP
  ) {
    return normalized;
  }
  if (!destination.terminalIds.includes(terminalId)) {
    const anchor = destination.terminalIds.indexOf(normalized.activeTerminalId);
    if (anchor >= 0) destination.terminalIds.splice(anchor + 1, 0, terminalId);
    else destination.terminalIds.push(terminalId);
  }
  if (splitDirection === "vertical") destination.splitDirection = "vertical";
  else delete destination.splitDirection;

  return normalizeThreadTerminalUiState({
    ...normalized,
    terminalOpen: true,
    terminalIds,
    activeTerminalId: terminalId,
    terminalGroups: groups,
    activeTerminalGroupId: destination.id,
  });
}

/** Opens the drawer (with a first terminal) or closes it; its terminals keep running. */
export function setThreadTerminalOpen(
  state: ThreadTerminalUiState,
  open: boolean,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (open && normalized.terminalIds.length === 0) {
    return upsertTerminalIntoGroups(normalized, DEFAULT_THREAD_TERMINAL_ID, "new");
  }
  if (normalized.terminalOpen === open) return normalized;
  return { ...normalized, terminalOpen: open };
}

export function setThreadTerminalHeight(
  state: ThreadTerminalUiState,
  height: number,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (!Number.isFinite(height) || height <= 0 || normalized.terminalHeight === height) {
    return normalized;
  }
  return { ...normalized, terminalHeight: height };
}

/** Adds `terminalId` next to the active terminal, in the active group (at most four). */
export function splitThreadTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
  direction: "horizontal" | "vertical" = "horizontal",
): ThreadTerminalUiState {
  return upsertTerminalIntoGroups(state, terminalId, "split", direction);
}

/** Adds `terminalId` as a group of its own. */
export function newThreadTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
): ThreadTerminalUiState {
  return upsertTerminalIntoGroups(state, terminalId, "new");
}

export function setThreadActiveTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (!normalized.terminalIds.includes(terminalId)) return normalized;
  const activeTerminalGroupId =
    normalized.terminalGroups.find((group) => group.terminalIds.includes(terminalId))?.id ??
    normalized.activeTerminalGroupId;
  if (
    normalized.activeTerminalId === terminalId &&
    normalized.activeTerminalGroupId === activeTerminalGroupId
  ) {
    return normalized;
  }
  return { ...normalized, activeTerminalId: terminalId, activeTerminalGroupId };
}

/** Removes a terminal; the last one closes the drawer and forgets the thread's layout. */
export function closeThreadTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (!normalized.terminalIds.includes(terminalId)) return normalized;
  const remaining = normalized.terminalIds.filter((id) => id !== terminalId);
  if (remaining.length === 0) return DEFAULT_THREAD_TERMINAL_UI_STATE;

  const closedIndex = normalized.terminalIds.indexOf(terminalId);
  const nextActive =
    normalized.activeTerminalId === terminalId
      ? (remaining[Math.min(closedIndex, remaining.length - 1)] ?? remaining[0] ?? "")
      : normalized.activeTerminalId;
  const groups: ThreadTerminalGroup[] = [];
  for (const group of normalized.terminalGroups) {
    const ids = group.terminalIds.filter((id) => id !== terminalId);
    if (ids.length > 0) groups.push({ ...group, terminalIds: ids });
  }
  const nextGroupId =
    groups.find((group) => group.terminalIds.includes(nextActive))?.id ??
    groups[0]?.id ??
    fallbackGroupId(nextActive);
  return normalizeThreadTerminalUiState({
    terminalOpen: normalized.terminalOpen,
    terminalHeight: normalized.terminalHeight,
    terminalIds: remaining,
    activeTerminalId: nextActive,
    terminalGroups: groups,
    activeTerminalGroupId: nextGroupId,
  });
}

/** Shows `terminalId` (opening the drawer), as a click on a card's terminal indicator does. */
export function revealThreadTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  const withTerminal = normalized.terminalIds.includes(terminalId)
    ? { ...normalized, terminalOpen: true }
    : newThreadTerminal(normalized, terminalId);
  return setThreadActiveTerminal(withTerminal, terminalId);
}

const STORAGE_KEY = "jhin.terminal.ui";

/** What a stored value may hold; anything else falls back to the default. */
function parseStored(value: unknown): Record<string, ThreadTerminalUiState> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const states: Record<string, ThreadTerminalUiState> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const candidate = raw as Partial<ThreadTerminalUiState> | null;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !Array.isArray(candidate.terminalIds) ||
      !candidate.terminalIds.every((id) => typeof id === "string") ||
      !Array.isArray(candidate.terminalGroups)
    ) {
      continue;
    }
    const groups = candidate.terminalGroups.filter(
      (group): group is ThreadTerminalGroup =>
        typeof group === "object" &&
        group !== null &&
        typeof group.id === "string" &&
        Array.isArray(group.terminalIds) &&
        group.terminalIds.every((id: unknown) => typeof id === "string"),
    );
    states[key] = normalizeThreadTerminalUiState({
      terminalOpen: candidate.terminalOpen === true,
      terminalHeight:
        typeof candidate.terminalHeight === "number"
          ? candidate.terminalHeight
          : DEFAULT_THREAD_TERMINAL_HEIGHT,
      terminalIds: candidate.terminalIds,
      activeTerminalId:
        typeof candidate.activeTerminalId === "string" ? candidate.activeTerminalId : "",
      terminalGroups: groups,
      activeTerminalGroupId:
        typeof candidate.activeTerminalGroupId === "string" ? candidate.activeTerminalGroupId : "",
    });
  }
  return states;
}

export interface TerminalUiStore {
  get(threadKey: string): ThreadTerminalUiState;
  update(
    threadKey: string,
    change: (state: ThreadTerminalUiState) => ThreadTerminalUiState,
  ): ThreadTerminalUiState;
  subscribe(listener: () => void): Disposable;
}

/** The drawer's layout per thread on this device, followed across tabs of the browser. */
export function createTerminalUiStore(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage,
): TerminalUiStore & Disposable {
  const read = () => {
    try {
      return parseStored(JSON.parse(storage?.getItem(STORAGE_KEY) ?? "{}"));
    } catch {
      return {};
    }
  };
  let states = read();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    states = read();
    notify();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return {
    get: (threadKey) => states[threadKey] ?? DEFAULT_THREAD_TERMINAL_UI_STATE,
    update(threadKey, change) {
      const current = states[threadKey] ?? DEFAULT_THREAD_TERMINAL_UI_STATE;
      const next = change(current);
      if (next === current) return current;
      const { [threadKey]: _previous, ...rest } = states;
      states = stateEqual(normalizeThreadTerminalUiState(next), DEFAULT_THREAD_TERMINAL_UI_STATE)
        ? rest
        : { ...rest, [threadKey]: next };
      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify(states));
      } catch {
        // Not kept on this device; the layout still applies to this page.
      }
      notify();
      return next;
    },
    subscribe(listener) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
    dispose() {
      globalThis.removeEventListener?.("storage", onStorage);
      listeners.clear();
    },
  };
}
