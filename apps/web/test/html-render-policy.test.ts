import { describe, expect, it } from "vite-plus/test";

import { RENDERED_PAGE_POLICY, withRenderedPagePolicy } from "../src/plugins/html-render/policy.ts";

const META = `<meta http-equiv="Content-Security-Policy" content="${RENDERED_PAGE_POLICY}">`;

describe("a rendered page's policy (preview.md D1689)", () => {
  it("comes first, after the doctype and any comments before it", () => {
    expect(withRenderedPagePolicy("<!doctype html><html><head><script>x()</script>")).toBe(
      `<!doctype html>${META}<html><head><script>x()</script>`,
    );
    expect(withRenderedPagePolicy("  <!-- a -->\n<!DOCTYPE html>\n<p>hi")).toBe(
      `  <!-- a -->\n<!DOCTYPE html>${META}\n<p>hi`,
    );
    expect(withRenderedPagePolicy("<script>x()</script><p>hi")).toBe(
      `${META}<script>x()</script><p>hi`,
    );
    // A comment that never ends takes the rest of the page: the policy goes before it.
    expect(withRenderedPagePolicy("<!-- open <script>x()</script>")).toBe(
      `${META}<!-- open <script>x()</script>`,
    );
    // A legacy doctype with its public and system ids.
    const legacy =
      '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">';
    expect(withRenderedPagePolicy(`${legacy}<p>hi`)).toBe(`${legacy}${META}<p>hi`);
  });

  it("allows the page's own code and HTTPS, and nothing over plain HTTP", () => {
    expect(RENDERED_PAGE_POLICY).toContain("script-src 'unsafe-inline' 'unsafe-eval' https:");
    expect(RENDERED_PAGE_POLICY).toContain("connect-src https: data: blob:");
    expect(RENDERED_PAGE_POLICY).not.toMatch(/\bhttp:|\bws:|wss:|\*/);
  });
});
