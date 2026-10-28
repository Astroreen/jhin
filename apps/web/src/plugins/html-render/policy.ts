/**
 * The content security policy a rendered page runs under in the reader's client
 * (docs/plans/preview.md, D1689): its own inline code and anything over HTTPS (a
 * CDN's chart library, its fonts), but no subresource or request over plain HTTP or
 * `ws:`, so it reads nothing from the reader's loopback (the node's own address) or
 * from the devices of the reader's network that serve plain HTTP; no frames, form
 * posts or plugins. The frame navigating itself is not a policy's to stop.
 */
export const RENDERED_PAGE_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:",
  "style-src 'unsafe-inline' https: data:",
  "img-src https: data: blob:",
  "font-src https: data:",
  "media-src https: data: blob:",
  // The page's own data and blob URLs reach no network.
  "connect-src https: data: blob:",
  "worker-src blob: data:",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const META = `<meta http-equiv="Content-Security-Policy" content="${RENDERED_PAGE_POLICY}">`;

/** Comments and a doctype the page starts with: the policy goes after them, never into quirks mode. */
const PROLOGUE = /^(?:\s|<!--[\s\S]*?-->)*(?:<!doctype[^>]*>)?/i;

/**
 * The page with the policy as its first element: before any of its own scripts or
 * resources, and a policy of the page's own can only narrow it.
 */
export function withRenderedPagePolicy(html: string): string {
  const prologue = PROLOGUE.exec(html)?.[0] ?? "";
  return `${prologue}${META}${html.slice(prologue.length)}`;
}
