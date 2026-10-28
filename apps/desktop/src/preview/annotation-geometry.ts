// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/desktop/src/preview/PickPreload.ts
// (`normalizeRect`, `isUsableRect`, `pathFromPoints`, `strokeBounds`, `unionRects`). The geometry
// of the annotation overlay's Region and Draw tools (docs/plans/desktop.md, D1690), apart from
// the preload so it is tested on its own.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export function normalizeRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/** T3's: big enough to be meant, not a click. */
export const isUsableRect = (rect: Rect) => rect.width >= 4 && rect.height >= 4;

/** T3's smoothing: quadratic curves through the midpoints. */
export function pathFromPoints(points: readonly Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y} l 0.01 0.01`;
  let path = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index]!;
    const next = points[index + 1]!;
    path += ` Q ${current.x} ${current.y} ${(current.x + next.x) / 2} ${(current.y + next.y) / 2}`;
  }
  const last = points[points.length - 1]!;
  return `${path} L ${last.x} ${last.y}`;
}

export function strokeBounds(points: readonly Point[], width: number): Rect {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const padding = width + 3;
  const left = Math.min(...xs) - padding;
  const top = Math.min(...ys) - padding;
  return {
    x: left,
    y: top,
    width: Math.max(...xs) + padding - left,
    height: Math.max(...ys) + padding - top,
  };
}

/** The smallest rectangle around every target. */
export function unionRects(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export const inside = (rect: Rect, x: number, y: number) =>
  x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
