# ADR: The web client (HTML wire, contract level 4)

**Status:** accepted · **Date:** 2026-10-11 · **Supersedes:** the Flutter
SDUI client of contract level 3 · **Normative companion:**
[sdui.md](sdui.md) (the wire itself)

This ADR records *why* the Jhin UI wire became HTML and which rules the
implementation is bound by. The wire format itself — payloads, frame shapes,
directive shapes, attribute protocol — is specified in
[sdui.md](sdui.md); this document does not restate it, it explains it and
fixes the policies around it.

## 1. Decision

1. **The wire becomes HTML, in one cutover.** The server renders screens to
   HTML from the same `Ui` fluent builder plugins already use; the client is
   a thin vanilla-JS DOM runtime. There is **no** `caps=html` negotiation
   gate and **no** dual-wire period: a request that declares `api < 4` (or
   sends no `X-Jhin-Client` header) is answered with `426 Upgrade Required`
   and the JSON body
   `{"error":"contract_upgrade","message":"This server speaks the HTML UI contract (api=4). Upgrade your client.","minApi":4}`.
   The old JSON node-tree wire is deleted, not deprecated.
2. **The server owns the HTML.** `ui-kit` serializes `UiNode` → HTML
   (`HtmlRenderer` + one renderer class per primitive family); the client
   owns no primitive registry and no layout logic. The former 15-step widget
   wrapping order collapses into a CSS application order on a single box
   (sdui.md §2.3).
3. **Patches stay surgical.** Stream and action patches carry HTML fragments
   applied by `innerHTML` / `outerHTML` swap — never a full screen reload,
   never a JSON prop merge.
4. **Contract constants.** `SDUI_CONTRACT = 4`, `SDUI_CONTRACT_MIN = 4`,
   `CLIENT_SCHEMA = 5`, `CLIENT_SCHEMA_MIN = 5`
   (`sdk/src/main/java/com/astroreen/jhin/sdk/ApiVersion.java`). The plugin
   contract level (`ApiVersion.CURRENT = 1`) is untouched.

## 2. Why HTML

The product's core need is that **an AI agent must be able to see the
rendered UI and iterate on it.** The Flutter client could not satisfy it:

- **No DOM, no accessibility tree.** Flutter renders to a canvas, so an agent
  sees only pixels. Pixel-based UI control measures at roughly 15% of human
  performance (OSWorld, Anthropic 2024), while structural DOM snapshots let a
  model read and address the interface directly. HTML gives us
  `document.querySelector('[data-jhin-type="button"]')`, an ARIA tree and a
  screenshot that maps back to a call-site.
- **Model priors.** LLMs are trained overwhelmingly on HTML/CSS/JS. Every AI
  UI product — v0, bolt.new, Lovable, Claude Artifacts — targets
  HTML/React/Tailwind; none targets Flutter/Dart. Backend-authored UI quality
  is therefore structurally better in HTML, for the same prompt and the same
  model.
- **An unbounded render plane.** The level-3 contract's 68-name primitive
  catalog is a ceiling: "the UI can represent anything the user's heart
  desires" is not expressible in a bounded catalog of handwritten widgets.
  HTML plus CSS is unbounded, and the catalog survives only as the *authoring
  vocabulary* (`Ui`), not as the rendering limit.

Cost accepted: a big-bang cutover (broken window between the cutover task and
catalog parity), and the loss of native desktop/mobile packaging in exchange
for a PWA.

## 3. Escaping policy

The critical risk of rendering HTML from LLM output, file contents and tool
output is injection. The policy is narrow on purpose:

- **`HtmlEsc` is the only escaping authority.** Every text prop (`text`,
  `label`, `title`, `subtitle`, `placeholder`, `message`, code bodies, the
  markdown source before parsing) and every prop interpolated into `style`,
  `class` or an attribute goes through it: `&`, `<`, `>`, `"`, `'` →
  entities. No renderer may concatenate a prop into a tag by hand, not even
  "temporarily".
- **Attribute values are always quoted.** Double-quoted and escaped; the one
  single-quoted attribute, `data-jhin-action`, carries JSON escaped by the
  same authority.
- **commonmark runs with raw HTML disabled** — both HTML blocks and inline
  HTML. Markdown is server-rendered; there is no client-side markdown or
  syntax-highlighting library.
- **`Ui.raw(String html)` is the single unescaped path.** It exists for
  trusted, server-authored chrome only (hand-tuned SVG art, the shell's own
  decorations). It is additive API and the only addition to the `Ui` builder.
  **Rule:** no product screen may use it. `RawEscapeSweepTest` fails the
  build when a screen under `plugins/ui-default/.../screens/` calls it, and
  the T201 QA artifacts record both that the hatch works
  (`Ui.raw("<img onerror=…>")` appears verbatim) and that the sweep reports
  zero uses in product screens.

Backstops: the shell response carries a strict CSP
(`default-src 'self'; script-src 'self' 'nonce-…'; object-src 'none';
base-uri 'none'`), and the XSS matrix (every injectable prop position, with
`<script>alert(1)</script>` as the value) is a named QA artifact, not an
afterthought.

## 4. The `data-jhin-*` attribute set

This is the agent-visible contract. Seven attributes, no more:

| Attribute | Carried by | Purpose |
|-----------|-----------|---------|
| `data-jhin-type` | **every** rendered node | the primitive name — the bridge from a pixel to the renderer class |
| `data-jhin-id` | nodes with an `id` prop | the patch/`setScreen`/stream-frame address, and the focus-restore key |
| `data-jhin-when` | nodes with a `when` prop | the raw expression the runtime re-evaluates on state change |
| `data-jhin-template` | nodes with a `${…}` string prop | the raw template the runtime re-interpolates |
| `data-jhin-action` | action-bearing nodes | the action JSON (single-quoted attribute, JSON escaped) |
| `data-jhin-confirm` | actions with a `confirm` | the confirmation message shown before dispatch |
| `data-jhin-icon` | the `<svg>` of an `icon` node | the icon name (inline-SVG registry) |

Two conventions make the set collision-free: the HTML `id` attribute is set
**only** on nodes that opt in via the `id` prop, and the runtime's own
elements use the `jhin-` prefix (`#jhin-root`, overlay containers). Interactive
nodes additionally carry `aria-label` (`semanticsLabel`), `title` (`tooltip`)
and `aria-disabled` (`enabled: false`) — standard attributes, not part of the
`data-jhin-*` set.

## 5. Patch semantics and focus restore

| Channel | Application |
|---------|-------------|
| `patch` (directive and stream frame) | **innerHTML** of `#<id>`: the element, its id and its attributes survive; only the content is replaced |
| `replace` (stream frame) | **outerHTML**: the element itself is replaced — for changes not expressible as inner content |
| `node` (stream frame) | append to the stream view, or replace the whole container when the view carries `mode: replace`; a re-delivered `id` replaces that item in place |
| `remove` (stream frame) | drop the item and **tombstone** the id — a replay never resurrects it |
| `setScreen` (directive) | replace the HTML of a known screen id |

**Focus and selection restore** is a client rule, because `innerHTML` destroys
the focused node:

1. before the swap, if `document.activeElement` lives inside the target,
   record its `data-jhin-id` (or a stable selector) plus `selectionStart` and
   `selectionEnd`;
2. swap;
3. if an element with the same `data-jhin-id` exists in the new content,
   restore focus and the selection offsets.

`replace` applies the same rule one level up. A patch whose target id is
absent targets the nearest ancestor `[data-jhin-id]`; with no such ancestor
it is **dropped with a `console.warn`** — never a throw, never a full reload.
Scroll behaviour is unchanged from T100: `node`, `replace` and `remove` jump
to the bottom while the view is following, a >24 px free-scroll disables
following, and `patch` never scrolls.

This is what makes `text_delta` at token frequency affordable: the server
re-renders one markdown block (deltas batched at ≤60 ms) and the runtime
swaps that block's content, leaving the composer untouched.

## 6. Capability matrix

The web client advertises, on every request:

```
X-Jhin-Client: api=4; version=<app version>; schema=5; caps=sse,open_url,secure_storage
```

| Capability | Advertised | Reason |
|------------|-----------|--------|
| `sse` | yes | `EventSource`, with a fetch-stream fallback |
| `open_url` | yes | `window.open` |
| `secure_storage` | yes | `localStorage["jhin.token"]` |
| `tls_pinning` | **no** | browser-impossible: the user agent owns certificate validation |
| `multi_profile` | **no** | browser-impossible in a useful sense: the origin *is* the server |

Consequence, unchanged from level 3: `Directives.filter` keeps dropping
`setServerUrl` (no `multi_profile`) and — by the same filter — `openProfiles`,
since the client-owned profile surface does not exist in the web runtime.
`setToken`/`clearToken` and `openUrl` survive because the matching caps are
advertised.

**Token storage trade-off (documented, accepted).** The token lives in
`localStorage["jhin.token"]`, which is readable by any script running on the
origin. Jhin is single-user and self-hosted, the origin serves only Jhin's
own assets, and the shell ships a strict CSP with `object-src 'none'` — so
the exposure is bounded by "an XSS on your own server", which the escaping
policy of §3 is designed to prevent. A `HttpOnly` cookie would move the
secret out of JS reach but would require CSRF handling and would break the
"paste a token from the CLI" pairing flow; that is a deliberate
non-decision, revisitable if Jhin ever becomes multi-user.

## 7. Client-owned surfaces

Exactly **one**: the **pairing fallback**. When the bootstrap answers
`401`/`403`, the runtime renders a built-in enroll form (hard-coded in
`app.js`, posting the server's enroll action) — because a server that will
not talk to you cannot send you a screen. It is never server-driven.

There is **no client-owned profile screen** in the web runtime (the origin is
the server) and no other client-owned product surface. Everything
product-shaped — sidebar, chat, composer, settings, providers, palette,
dialogs — is server-driven HTML. The runtime's own chrome is a `#jhin-root`
div, the overlay containers (toasts, confirm dialog, undo notice) and the
pairing fallback; nothing else.

## 8. The agent iteration loop

The loop this whole ADR exists to enable:

1. **Boil** — `scripts/qa/run-kernel.sh .sisyphus/evidence/dev` boots
   `kernel/build/libs/kernel-*.jar` with a throwaway `JHIN_HOME`, waits for
   `GET /_jhin/health` and tees `kernel.log`.
2. **See** — browser tools: navigate to `http://localhost:8443/` (or the
   QA HTTP port when the self-signed TLS port is unreachable), take an ARIA
   snapshot (YAML) and a screenshot.
3. **Map** — every node carries `data-jhin-type` and (when addressable)
   `data-jhin-id`. To find the code behind a visible box, grep the renderers
   under `plugins/ui-kit/src/main/java/com/astroreen/jhin/plugin/uikit/html/renderers/`
   for the type and the screen builders under
   `plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/screens/`
   for the id.
4. **Iterate** — edit Java for structure and props, `app.css` for looks; then
   `./gradlew :kernel:bootJar` plus `scripts/qa/build-plugin.sh` for the two
   plugins, restart, reload the browser, re-snapshot and compare.
5. **Prove** — the per-task `scripts/qa/t<N>.sh` (curl + gradle, headless, no
   human in the loop) plus the agent's own browser evidence, both archived
   under `.sisyphus/evidence/<task>/`. One commit per task, Conventional
   Commits, English.

Browser verification is an **agent step, not a script step**: QA scripts stay
curl + gradle so they run headless; snapshots and screenshots are produced by
the executor and saved as evidence.

## 9. Binding constraints

Degradation (direction inverted from level 3 — the server can only emit types
it knows, so the risk is a stale `app.js` against a newer server):

- unknown `data-jhin-type` in the runtime's directive and prop-applier paths:
  ignored with a `console.warn`;
- unknown markup: inert — the browser renders it and the page still paints;
- unknown token reference: rendered as the literal string;
- `when` parse failure: the node stays **visible**;
- `${…}` failure: the raw template stays as text;
- unknown icon name: an empty `<svg>` plus a console log;
- unknown directive op: ignored, never thrown;
- the client never crashes on server content.

Hard prohibitions (the Must-NOT-Have list, binding on every task):

1. **No JS framework, no bundler, no npm, no TypeScript, no build step.**
   `app.js` and `app.css` are committed, hand-written, dependency-free files.
2. **No `eval`, no `new Function`.** The expression evaluator is a parser;
   server content never reaches the JS engine. `innerHTML` is used *only* in
   the patch/replace applier of §5.
3. **No unescaped HTML path except `Ui.raw`** (§3); `RawEscapeSweepTest`
   stays green.
4. **No client-side markdown or syntax-highlighting library.** Markdown is
   server-rendered; `code_block` ships plain `<pre><code>`.
5. **No WebSocket.** SSE only.
6. **No dual-wire, no `caps=html` gate.** One wire, one serializer.
7. **No kernel changes.** No kernel static serving, no new kernel routes;
   `KernelPurityTest` stays green with zero edits.
8. **No SDK dependency additions.** `commonmark` belongs to `ui-kit` only;
   the SDK keeps `slf4j-api` + `jackson-databind`.
9. **No changes to the `Ui` public API** beyond the additive `Ui.raw` — every
   plugin screen must compile untouched.
10. **No deletion of `UiNode.toJson()`** — the control plane (action
    payloads, dumps, tests) still needs it; HTML is a second view over the
    same tree.
11. **No server-side session state for rendering.** The renderer is a pure
    function `UiNode → String`.
12. **No new client-owned screens beyond the pairing fallback** (§7).
