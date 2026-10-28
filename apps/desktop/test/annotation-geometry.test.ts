import { PreviewAnnotation } from "@jhin/desktop-api";
import { describe, expect, it } from "vite-plus/test";

import {
  inside,
  isUsableRect,
  normalizeRect,
  pathFromPoints,
  strokeBounds,
  unionRects,
} from "../src/preview/annotation-geometry.ts";

describe("the annotation overlay's geometry (desktop.md D1690)", () => {
  it("makes a rectangle of a drag in any direction, and takes only one big enough", () => {
    expect(normalizeRect(50, 40, 10, 20)).toEqual({ x: 10, y: 20, width: 40, height: 20 });
    expect(isUsableRect(normalizeRect(0, 0, 3, 40))).toBe(false);
    expect(isUsableRect(normalizeRect(0, 0, 4, 4))).toBe(true);
  });

  it("smooths a stroke through its midpoints, as T3's pathFromPoints", () => {
    expect(pathFromPoints([])).toBe("");
    expect(pathFromPoints([{ x: 1, y: 2 }])).toBe("M 1 2 l 0.01 0.01");
    expect(
      pathFromPoints([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 0 },
      ]),
    ).toBe("M 0 0 Q 10 10 15 5 L 20 0");
  });

  it("bounds a stroke with its width, and every target together", () => {
    const stroke = strokeBounds(
      [
        { x: 10, y: 10 },
        { x: 30, y: 20 },
      ],
      4,
    );
    expect(stroke).toEqual({ x: 3, y: 3, width: 34, height: 24 });
    expect(unionRects([])).toBeUndefined();
    expect(unionRects([stroke, { x: 50, y: 0, width: 10, height: 10 }])).toEqual({
      x: 3,
      y: 0,
      width: 57,
      height: 27,
    });
    expect(inside(stroke, 3, 27)).toBe(true);
    expect(inside(stroke, 2, 27)).toBe(false);
  });
});

describe("an annotation's targets (desktop.md D1691)", () => {
  const base = {
    id: "annotation_1",
    pageUrl: "http://localhost:3000/",
    pageTitle: "Shop",
    comment: "",
    elements: [],
    createdAt: "2026-10-28T12:00:00.000Z",
  };
  const region = { id: "region_1", rect: { x: 0, y: 0, width: 10, height: 10 } };
  const stroke = {
    id: "stroke_1",
    color: "#3b82f6",
    width: 4,
    points: [
      { x: 0, y: 0 },
      { x: 5, y: 5 },
    ],
    bounds: { x: -7, y: -7, width: 19, height: 19 },
  };

  it("takes a region or a drawing without elements, and refuses none of them", () => {
    expect(PreviewAnnotation.safeParse({ ...base, regions: [region] }).success).toBe(true);
    expect(PreviewAnnotation.safeParse({ ...base, strokes: [stroke] }).success).toBe(true);
    expect(PreviewAnnotation.safeParse(base).success).toBe(false);
    expect(PreviewAnnotation.safeParse({ ...base, regions: [], strokes: [] }).success).toBe(false);
  });

  it("bounds strokes: two points at least, 2 000 at most, 50 strokes", () => {
    expect(
      PreviewAnnotation.safeParse({ ...base, strokes: [{ ...stroke, points: [{ x: 0, y: 0 }] }] })
        .success,
    ).toBe(false);
    const many = Array.from({ length: 2001 }, (_, x) => ({ x, y: 0 }));
    expect(
      PreviewAnnotation.safeParse({ ...base, strokes: [{ ...stroke, points: many }] }).success,
    ).toBe(false);
    expect(
      PreviewAnnotation.safeParse({ ...base, strokes: Array.from({ length: 51 }, () => stroke) })
        .success,
    ).toBe(false);
  });
});
