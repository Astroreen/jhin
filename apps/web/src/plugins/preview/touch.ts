// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): the touch path of
// apps/web/src/browser/ServerBrowserSurface.tsx (a tap clicks, a pan scrolls, and the
// editable-at-point probe decides whether a tap raises the soft keyboard), as a pure state
// machine the surface runs (docs/plans/preview.md, D1203).

/** A tap moves less than this, in client pixels. */
const TAP_SLOP_PX = 8;
/** A probe answer is reused for a tap this near (page pixels) and this soon. */
const PROBE_REUSE_PX = 24;
const PROBE_REUSE_MS = 10_000;

interface PagePoint {
  readonly x: number;
  readonly y: number;
}

/** What the surface does for a touch: ask the node, send input, or move the focus. */
export type TouchAction =
  | { readonly type: "probe"; readonly point: PagePoint }
  | {
      readonly type: "wheel";
      readonly point: PagePoint;
      readonly deltaX: number;
      readonly deltaY: number;
    }
  | { readonly type: "tap"; readonly point: PagePoint }
  | { readonly type: "focus" }
  | { readonly type: "blur" };

interface TouchPointer {
  readonly pointerId: number;
  readonly isPrimary: boolean;
  readonly clientX: number;
  readonly clientY: number;
  /** The page point under the pointer; undefined outside the page. */
  readonly point: PagePoint | undefined;
}

interface Gesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  lastX: number;
  lastY: number;
  panning: boolean;
}

interface Probe {
  readonly x: number;
  readonly y: number;
  editable: boolean | null;
  answered: boolean;
  tapped: boolean;
}

export interface TouchGestures {
  down(pointer: TouchPointer): TouchAction[];
  /** `scale`: page pixels per client pixel, for the pan's wheel deltas. */
  move(pointer: TouchPointer, scale: number): TouchAction[];
  up(pointer: TouchPointer): TouchAction[];
  cancel(pointerId: number): void;
  /** The node answered a probe. */
  answered(result: PagePoint & { readonly editable: boolean }): TouchAction[];
  /** A probe got no answer: nothing waits for it any more. */
  failed(point: PagePoint): void;
  /** Control was lost: everything in flight is dropped. */
  reset(): void;
}

export function createTouchGestures(now: () => number = () => performance.now()): TouchGestures {
  let gesture: Gesture | null = null;
  let probe: Probe | null = null;
  let last: (PagePoint & { editable: boolean; at: number }) | null = null;
  return {
    down(pointer) {
      if (!pointer.isPrimary) return [];
      gesture = {
        pointerId: pointer.pointerId,
        startX: pointer.clientX,
        startY: pointer.clientY,
        lastX: pointer.clientX,
        lastY: pointer.clientY,
        panning: false,
      };
      const point = pointer.point;
      if (point === undefined) {
        probe = null;
        return [];
      }
      const reusable =
        last !== null &&
        now() - last.at < PROBE_REUSE_MS &&
        Math.hypot(point.x - last.x, point.y - last.y) < PROBE_REUSE_PX;
      probe = {
        x: point.x,
        y: point.y,
        editable: reusable ? last!.editable : null,
        answered: false,
        tapped: false,
      };
      return [{ type: "probe", point }];
    },
    move(pointer, scale) {
      const touch = gesture;
      if (touch === null || touch.pointerId !== pointer.pointerId) return [];
      if (
        !touch.panning &&
        Math.hypot(pointer.clientX - touch.startX, pointer.clientY - touch.startY) < TAP_SLOP_PX
      ) {
        return [];
      }
      touch.panning = true;
      const actions: TouchAction[] =
        pointer.point === undefined
          ? []
          : [
              {
                type: "wheel",
                point: pointer.point,
                deltaX: (touch.lastX - pointer.clientX) * scale,
                deltaY: (touch.lastY - pointer.clientY) * scale,
              },
            ];
      touch.lastX = pointer.clientX;
      touch.lastY = pointer.clientY;
      return actions;
    },
    up(pointer) {
      const touch = gesture;
      if (touch === null || touch.pointerId !== pointer.pointerId) return [];
      gesture = null;
      const pending = probe;
      if (touch.panning) {
        probe = null;
        return [];
      }
      if (pointer.point === undefined) return [];
      const actions: TouchAction[] = [];
      // iOS requires focus during the tap; late probe replies only raise Android's keyboard.
      if (pending?.editable === true) actions.push({ type: "focus" });
      else if (pending?.editable === false) actions.push({ type: "blur" });
      if (pending !== null && !pending.answered) pending.tapped = true;
      else probe = null;
      actions.push({ type: "tap", point: pointer.point });
      return actions;
    },
    cancel(pointerId) {
      if (gesture?.pointerId === pointerId) gesture = probe = null;
    },
    answered(result) {
      last = { x: result.x, y: result.y, editable: result.editable, at: now() };
      const pending = probe;
      if (pending === null || pending.x !== result.x || pending.y !== result.y) return [];
      pending.editable = result.editable;
      pending.answered = true;
      if (!pending.tapped) return [];
      // The tap already ended: a late answer raises Android's keyboard only.
      probe = null;
      return [{ type: result.editable ? "focus" : "blur" }];
    },
    failed(point) {
      if (probe !== null && probe.x === point.x && probe.y === point.y) probe = null;
    },
    reset() {
      gesture = probe = last = null;
    },
  };
}
