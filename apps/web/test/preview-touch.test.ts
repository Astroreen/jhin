import { describe, expect, it } from "vite-plus/test";

import { createTouchGestures } from "../src/plugins/preview/touch.ts";

const at = (clientX: number, clientY: number, point = { x: clientX, y: clientY }) => ({
  pointerId: 1,
  isPrimary: true,
  clientX,
  clientY,
  point,
});

describe("touch on the browser page (D1203)", () => {
  it("clicks on a tap and asks the node what it lands on", () => {
    const touch = createTouchGestures(() => 0);
    expect(touch.down(at(10, 10))).toEqual([{ type: "probe", point: { x: 10, y: 10 } }]);
    expect(touch.move(at(13, 12), 1)).toEqual([]);
    expect(touch.up(at(13, 12))).toEqual([{ type: "tap", point: { x: 13, y: 12 } }]);
  });

  it("scrolls on a pan, in page pixels, and never clicks", () => {
    const touch = createTouchGestures(() => 0);
    touch.down(at(100, 100));
    expect(touch.move(at(100, 80), 2)).toEqual([
      { type: "wheel", point: { x: 100, y: 80 }, deltaX: 0, deltaY: 40 },
    ]);
    expect(touch.move(at(90, 70), 2)).toEqual([
      { type: "wheel", point: { x: 90, y: 70 }, deltaX: 20, deltaY: 20 },
    ]);
    expect(touch.up(at(90, 70))).toEqual([]);
  });

  it("focuses the page's input when a late answer says the tapped point is text", () => {
    const touch = createTouchGestures(() => 0);
    touch.down(at(10, 10));
    expect(touch.up(at(10, 10))).toEqual([{ type: "tap", point: { x: 10, y: 10 } }]);
    expect(touch.answered({ x: 10, y: 10, editable: true })).toEqual([{ type: "focus" }]);
  });

  it("blurs the input on a late answer for a point that is not text", () => {
    const touch = createTouchGestures(() => 0);
    touch.down(at(10, 10));
    touch.up(at(10, 10));
    expect(touch.answered({ x: 10, y: 10, editable: false })).toEqual([{ type: "blur" }]);
  });

  it("focuses during the tap when the answer came first, and does not again", () => {
    const touch = createTouchGestures(() => 0);
    touch.down(at(10, 10));
    expect(touch.answered({ x: 10, y: 10, editable: true })).toEqual([]);
    expect(touch.up(at(10, 10))).toEqual([
      { type: "focus" },
      { type: "tap", point: { x: 10, y: 10 } },
    ]);
  });

  it("reuses an answer near and soon, so iOS can focus during the next tap", () => {
    let now = 0;
    const touch = createTouchGestures(() => now);
    touch.down(at(10, 10));
    touch.answered({ x: 10, y: 10, editable: true });
    touch.up(at(10, 10));
    now = 5_000;
    touch.down(at(20, 20));
    expect(touch.up(at(20, 20))).toEqual([
      { type: "focus" },
      { type: "tap", point: { x: 20, y: 20 } },
    ]);
    // Too late or too far: the input is left alone until the node answers.
    now = 20_000;
    touch.down(at(20, 20));
    expect(touch.up(at(20, 20))).toEqual([{ type: "tap", point: { x: 20, y: 20 } }]);
  });

  it("forgets a probe that got no answer, and a cancelled touch", () => {
    const touch = createTouchGestures(() => 0);
    touch.down(at(10, 10));
    touch.up(at(10, 10));
    touch.failed({ x: 10, y: 10 });
    expect(touch.answered({ x: 10, y: 10, editable: true })).toEqual([]);
    touch.down(at(30, 30));
    touch.cancel(1);
    expect(touch.up(at(30, 30))).toEqual([]);
  });

  it("ignores a second finger and a tap outside the page", () => {
    const touch = createTouchGestures(() => 0);
    expect(touch.down({ ...at(10, 10), isPrimary: false })).toEqual([]);
    expect(touch.down({ ...at(10, 10), point: undefined })).toEqual([]);
    expect(touch.up({ ...at(10, 10), point: undefined })).toEqual([]);
  });

  it("forgets the probe of a touch lifted outside the page", () => {
    const touch = createTouchGestures(() => 0);
    touch.down(at(10, 10));
    expect(touch.up({ ...at(10, 10), point: undefined })).toEqual([]);
    expect(touch.answered({ x: 10, y: 10, editable: true })).toEqual([]);
    // Nor does the answer it got focus the next tap elsewhere.
    touch.down(at(200, 200));
    expect(touch.up(at(200, 200))).toEqual([{ type: "tap", point: { x: 200, y: 200 } }]);
  });
});
