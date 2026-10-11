# Jhin SDUI contract (level 4)

Jhin's UI is server-driven and the wire is **HTML**: the server authors
screens with the `Ui` fluent builder over a primitive catalog, serializes the
resulting tree to semantic HTML, and a thin vanilla-JS DOM runtime drives
bootstrap, actions, directives, state, expressions and SSE. The client
hardcodes exactly one surface — the pairing fallback, the built-in enroll
form shown when the bootstrap answers 401/403 — and one endpoint, the
bootstrap fetch (`GET /_jhin/bootstrap`); everything else comes from the
server. The browser renders markup it does not know as inert, and the runtime
ignores attributes it does not know, so the client never crashes on server
content.

This document is the **normative wire contract, level 4** (`api: 4`). It
defines what the web client parses and what the server emits. The version
constants (`sdk/src/main/java/com/astroreen/jhin/sdk/ApiVersion.java`) are
**api 4 / minApi 4 / schema 5 / minSchema 5**. There is **no level-3
compatibility path**: the JSON node-tree wire is gone, and a request that
declares `api < 4` is answered with `426 Upgrade Required` (section 6).
Server side: `plugins/ui-kit/` (the `Ui` builder and the HTML renderer) and
`plugins/ui-default/` (bootstrap, screens, actions, streams, the web shell
and its assets). Client side:
`plugins/ui-default/src/main/resources/web/app.js`. See
[architecture.md](architecture.md) for the runtime,
[web-client.md](web-client.md) for the decisions behind the HTML wire and
[plugin-dev.md](plugin-dev.md) for writing plugins.

**Conformance format.** Every prop key in this document is machine-parseable:
prop keys always appear backticked, one key per table row, in the second
column of a table whose header row contains `Prop`. The ui-kit builder
conformance test asserts that every key the builders can emit is documented
here, so the doc and the code cannot drift apart.

## 1. Bootstrap payload

`GET /_jhin/bootstrap` returns the whole client start-up payload. The client
advertises itself in every request with the `X-Jhin-Client` header
(section 6); a request that declares `api < 4`, or carries no header at all,
is refused with `426 Upgrade Required` instead of a payload. Two producers
exist:

**Kernel fallback** (a bare kernel without a UI plugin; `KernelRoutes`) —
unchanged, and exempt from the upgrade gate so a bare server can always be
probed:

```json
{
  "api": 1,
  "empty": true,
  "kernel": "0.2.0",
  "plugins": [],
  "message": "This server has no UI plugin installed."
}
```

**`jhin.ui` payload, contract level 4** (a plugin route on the same path
supersedes the fallback silently; `BootstrapRoute`):

```json
{
  "api": 4,
  "empty": false,
  "title": "Jhin",
  "contract": { "api": 4, "minApi": 4, "schema": 5, "minSchema": 5 },
  "theme":   { "...unchanged: appearance, canvas, accent, colors, stageArt, mode..." },
  "tokens":  { "...unchanged: the eleven UiTokens families..." },
  "density": "comfortable",
  "keymap":  [ { "key": "mod+enter", "command": "composer.send", "when": "composerFocus" } ],
  "palette": { "...unchanged T115 command-palette metadata..." },
  "entry": "sessions",
  "screens": [ { "id": "sessions", "html": "<div data-jhin-type=\"shell\" …>…</div>" } ],
  "screenEndpoint": "/ui/screen/{id}",
  "actionEndpoint": "/ui/action/{name}",
  "streamEndpoint": "/ui/stream/session/{sessionId}",
  "shell": { "js": "/ui/assets/app.js", "css": "/ui/assets/app.css" },
  "fallbacks": { "offline": "<div …>…</div>", "error": "<div …>…</div>" }
}
```

Rules:

- `screens[]` keeps its role: the **inline subset** the bootstrap embeds (the
  static screens), in registration order, cached and never lazily fetched —
  only `refresh` re-fetches them. Dynamic ids (`chat:<session-id>`, `pair`,
  `version_gate`) are resolved by the screen endpoint. Same as before, with
  `html` in place of a serialized tree.
- `shell` names the asset routes (`GET /ui/assets/app.js`,
  `GET /ui/assets/app.css`). The field is present from the level-4 cutover
  onwards — while the `GET /` route still inlines identical content, the
  field already names the routes, so the runtime never branches on phase.
- `theme`, `tokens`, `density`, `keymap` and `palette` are **unchanged** in
  shape. They drive `TokenCss` (section 9.4) and the runtime's keymap merge.

Top-level fields:

| Field | Type | Description |
|-------|------|-------------|
| `api` | int | contract level the payload was produced at (`4`) |
| `empty` | bool | `true` tells the client to render its built-in empty state ("no UI plugin installed") instead of a screen stack |
| `title` | string | product chrome title |
| `contract` | object | version block, see below |
| `theme` | object | theme seed block, see below |
| `tokens` | object | design-token overrides, see below |
| `density` | string | control density: `compact`, `comfortable` or `spacious`; selects the `[data-density]` scale on `<html>` (section 9.4) |
| `keymap` | array | default key bindings, `[{key, command, when?}]`, see below |
| `palette` | object | command-palette metadata (T115), unchanged |
| `entry` | string | the screen id pushed first |
| `screens` | array | inline screens `[{id, html}]`, in registration order |
| `screenEndpoint` | string | path template for on-demand screens; the client substitutes `{id}` (URL-encoded) and expects `{id, html}` |
| `actionEndpoint` | string | path template for action posts; the client substitutes `{name}` |
| `streamEndpoint` | string | path template for the per-session SSE topic; the client substitutes `{sessionId}` |
| `shell` | object | the runtime asset routes `{js, css}` |
| `fallbacks` | object | server-rendered offline and error art as HTML strings (`offline`, `error`), cached by the client on first success |

`contract` keys:

| Key | Meaning |
|-----|---------|
| `api` | the server's wire contract level (`4`) |
| `minApi` | the lowest wire level the server still speaks (`4` — there is no downgrade path) |
| `schema` | the client persisted-data schema version the server was built for (`5`, see [updates.md](updates.md)) |
| `minSchema` | the lowest persisted-data schema the server accepts (`5`); a client whose stored schema is lower MUST refuse to render product screens and show the built-in `version_gate` "update required" surface |

`theme` keys:

| Key | Type | Description |
|-----|------|-------------|
| `appearance` | `system`/`light`/`dark` | theme mode |
| `canvas` | `#RRGGBB` or `#AARRGGBB` | background seed color |
| `accent` | `#RRGGBB` or `#AARRGGBB` | accent seed color |
| `colors` | object | optional override map keyed by token names (`error`, `success`, `warning`, `info`, `surface`, `outline`, `onCanvas`, `onAccent`, `accentHover`, `accentMuted`, …); overrides win over generation |
| `stageArt` | object | the five `stage-art-*` backdrop tokens of the selected catalogue theme (`stage-art-top`, `stage-art-mid`, `stage-art-bottom`, `stage-art-highlight`, `stage-art-line`), as `#RRGGBB` hex; theme-scoped metadata the sidebar stage backdrop paints from (T95), not palette generation |
| `mode` | `system`/`light`/`dark` | legacy level-1 spelling of the same idea; MUST equal `appearance` |

From `{appearance, canvas, accent}` the **server** generates the full palette
(`PaletteGen`/`Oklch`) and emits it as CSS custom properties in the two
`:root` layers of section 9.4; `colors` overrides are applied last, by token
name. The client performs no palette math and parses no token values.

`tokens` overrides the built-in defaults key-by-key; any absent key keeps the
built-in. All numbers are logical px; `typography.*.weight` is 100–900.

| Token group | Keys and built-in defaults |
|-------------|----------------------------|
| `spacing` | `xs` 4, `sm` 8, `md` 12, `lg` 16, `xl` 24, `xxl` 32 |
| `radius` | `sm` 6, `md` 10, `lg` 14, `full` 9999 |
| `typography` | `h1` {size 28, height 1.25, weight 700}, `h2` {size 22, height 1.30, weight 700}, `h3` {size 18, height 1.35, weight 600}, `body` {size 14, height 1.50, weight 400}, `small` {size 12, height 1.45, weight 400}, `mono` {size 13, height 1.55, weight 400, font monospace} |
| `elevation` | `none` 0, `sm` 1, `md` 4, `lg` 8 |
| `motion` | `instant` 0, `fast` 120, `normal` 200, `slow` 320, `panel` 0 |

- `motion.panel` (ms) is the panel-animation duration: 0 = instant, 400 = max.
  `motion.instant`/`fast`/`normal`/`slow` are the general durations. The client
  must honor the OS reduced-motion preference by collapsing all durations to 0
  regardless of server values.
- `keymap` is the *default* keymap the server wants; the client merges user
  overrides (persisted, migrated — see [updates.md](updates.md)) over it, and
  the last matching rule wins. `key` strings join modifiers with `+`
  (`mod+enter`; `mod` is Cmd on macOS, Ctrl elsewhere); `when` is a command
  context name evaluated client-side.

The shipped default `keymap` (the `jhin.ui` payload, in registration order):

| `key` | `command` | `when` |
|-------|-----------|--------|
| `mod+enter` | `composer.send` | `composerFocus` |
| `mod+enter` | `composer.sendAlternate` | `composerFocus && turnRunning` |
| `ctrl+alt+enter` | `composer.sendAndNew` | `composerFocus` |
| `shift+enter` | `composer.newline` | `composerFocus` |
| `mod+up` | `composer.recallPrev` | `composerFocus` |
| `mod+down` | `composer.recallNext` | `composerFocus` |
| `mod+shift+m` | `modelPicker.toggle` | `composerFocus \|\| !editableFocus` |
| `mod+shift+h` | `composer.host` | `composerFocus \|\| !editableFocus` |
| `mod+shift+e` | `composer.effort` | `composerFocus \|\| !editableFocus` |
| `mod+shift+a` | `composer.mode` | `composerFocus \|\| !editableFocus` |
| `mod+shift+x` | `composer.workspace` | `composerFocus \|\| !editableFocus` |
| `mod+shift+g` | `composer.branch` | `composerFocus \|\| !editableFocus` |
| `mod+shift+l` | `composer.previousWorktree` | `composerFocus \|\| !editableFocus` |
| `ctrl+k` | `palette.open` | — |
| `ctrl+z` | `thread.undo` | — |
| `alt+left` | `nav.back` | — |
| `alt+right` | `nav.forward` | — |
| `mod+n` | `thread.new` | — |
| `mod+[` | `navigation.back` | `!terminalFocus` |
| `mod+]` | `navigation.forward` | `!terminalFocus` |
| `mod+j` | `terminal.toggle` | — |
| `mod+w` | `terminal.close` | `terminalFocus` |
| `mod+w` | `rightPanel.close` | `!terminalFocus` |
| `mod+alt+n` | `chat.newWithoutProject` | `!terminalFocus` |
| `mod+shift+enter` | `thread.steerQueuedMessage` | `!terminalFocus` |
| `mod+1` … `mod+9` | `thread.jump1` … `thread.jump9` | `isDesktop` |

The `composer.sendAlternate` rule is registered *after* the `composer.send`
rule and both match `mod+enter` — the last matching rule wins, so the
running-turn gate takes the chord only while `turnRunning` holds and the
idle composer keeps the T68 send. The picker chords open the matching
composer picker dialogs (T103). The T116 additions align the list with the
upstream t3code defaults (`packages/shared/src/keybindings.ts:21-104`,
commit `37de6cb`): the `!terminalFocus` guards, the `mod+[` / `mod+]`
navigation pair, `mod+alt+n` new-thread-without-project, `mod+shift+enter`
queue-as-steer, `mod+j` terminal toggle, the `mod+w` precedence (the focused
terminal closes first, the right panel otherwise) and the `mod+1..9` thread
jumps gated on `isDesktop`. `thread.stop` has no default chord — it is
dispatched programmatically (the stop button's `cancel` action when a run is
live). The upstream `mod+alt+enter` send-and-background is the existing T68
`ctrl+alt+enter` → `composer.sendAndNew` binding (T103 dropped the
draft-route branch; Jhin has no draft route).

The `theme`/`density`/`tokens.motion.panel` seed values are not fixed
constants: the `jhin.ui` plugin persists them server-side (its `settings.json`
over the `jhin.ui` config section, keys `appearance`, `canvas`, `accent`,
`density`, `panelMotionMs`) and the settings screen's `save-appearance` action
writes them, so the next bootstrap carries the saved values. The same store
holds the thread-behavior proxy keys `autoSettleDefault` and `inactivityDays`
(`save-thread-behavior`); they are `jhin.ui`-owned preferences — the
auto-settle sweep threshold itself stays the `jhin.sessions.inactivityMs`
operator config.

The authoring model (section 2) is unchanged — the server builds a tree of
`UiNode` values:

```json
{"type": "text", "props": {"text": "Hello", "style": "h2"}, "children": []}
```

`children` is optional; a string child is a text shorthand. At level 4 this
tree is a **server-side** model only: it never travels the wire. What travels
is the HTML the renderer produces from it (section 9), while `UiNode.toJson()`
stays in service for the control plane (action payloads, dumps, tests).

## 2. Node model

A node is `{"type": "<primitive>", "props": {…}, "children": […]}` inside the
server. Every node accepts the universal prop surface below, applied once by
`HtmlRenderer`/`UniversalProps` before the primitive renderer runs, plus the
per-primitive props of section 2.6. The catalog and the prop vocabulary are
**unchanged**: level 4 changes the serialization (HTML instead of a JSON
tree), the application order (section 2.3) and the direction of degradation
(section 2.4) — not the vocabulary a plugin writes.

### 2.1 Universal props

| Group | Prop | Type | Default | Meaning |
|-------|------|------|---------|---------|
| Meta | `id` | string | — | node identity; target of `patch`/`setScreen` and of stream item patches |
| Meta | `when` | expression | — | hide the node when the expression evaluates `false` (section 7) |
| Meta | `visible` | bool | `true` | static visibility |

| Group | Prop | Type | Default | Meaning |
|-------|------|------|---------|---------|
| Box | `width` | num or token | — | logical px |
| Box | `height` | num or token | — | logical px |
| Box | `minWidth` | num or token | — | constraint |
| Box | `maxWidth` | num or token | — | constraint |
| Box | `minHeight` | num or token | — | constraint |
| Box | `maxHeight` | num or token | — | constraint |
| Box | `aspectRatio` | num | — | width / height ratio |

| Group | Prop | Type | Default | Meaning |
|-------|------|------|---------|---------|
| Box | `padding` | padding | — | inner spacing |
| Box | `margin` | padding | — | outer spacing |

A `padding`/`margin` value is a num, `[all]`, `[vertical,horizontal]`,
`[top,horizontal,bottom]`, `[top,right,bottom,left]` or
`{top,right,bottom,left}`; each component may be a token reference.

| Group | Prop | Type | Default | Meaning |
|-------|------|------|---------|---------|
| Box | `color` | color or token | — | background color |
| Box | `gradient` | object | — | `{type: linear/radial/sweep, begin, end, colors: [], stops?: []}`; `begin`/`end` are alignment literals |
| Box | `border` | color or token | — | border color |
| Box | `borderWidth` | num | — | border width |
| Box | `borderStyle` | `solid`/`none` | `solid` | border style |
| Box | `borderRadius` | num or token | — | corner radius |
| Box | `shadow` | object or token | — | `{color, blur, spread, offset: [x, y]}` |
| Box | `opacity` | num | 1.0 | 0.0–1.0 |
| Box | `clip` | clip | `none` | `none/hardEdge/softEdge/antiAlias/antiAliasWithSaveLayer` |
| Box | `transform` | matrix or object | — | 16-number column-major matrix, or `{translate: [x,y,z]?, rotate?: rad, scale?: [x,y]}` |
| Box | `align` | alignment | — | alignment inside the parent box; `alignment` is accepted as an alias |

| Group | Prop | Type | Default | Meaning |
|-------|------|------|---------|---------|
| Text | `fontFamily` | string | — | font family |
| Text | `fontSize` | num | — | font size |
| Text | `fontWeight` | num | — | 100–900 |
| Text | `fontStyle` | `normal`/`italic` | — | font style |
| Text | `letterSpacing` | num | — | letter spacing |
| Text | `wordSpacing` | num | — | word spacing |
| Text | `height` | num | — | line-height multiple |
| Text | `textAlign` | text align | — | `left/right/center/justify/start/end` |
| Text | `textDecoration` | `none`/`underline`/`overline`/`lineThrough` | — | decoration |
| Text | `textOverflow` | `clip`/`fade`/`ellipsis`/`visible` | — | overflow behavior |
| Text | `maxLines` | int | — | line limit |
| Text | `softWrap` | bool | — | wrapping |
| Text | `ellipsis` | bool | — | shorthand for `textOverflow: ellipsis` |

Text-style props apply when the built widget is text-bearing; on non-text
nodes they are ignored. On text-bearing primitives `overflow` is accepted as
an alias of `textOverflow`. The legacy level-1 text props `style`
(`h1/h2/h3/body/small/caption/mono` typography token; `caption` maps to
`small`), `bold`, `italic` and `color` remain accepted on text-bearing
primitives.

| Group | Prop | Type | Default | Meaning |
|-------|------|------|---------|---------|
| Flex | `flex` | int | — | wraps the node in `Expanded` |
| Flex | `fit` | `loose`/`tight` | — | wraps the node in `Flexible(fit)` |
| Flex | `mainAxisSize` | `min`/`max` | — | main axis size |
| Flex | `mainAxisAlignment` | main axis | — | `start/end/center/spaceBetween/spaceAround/spaceEvenly` |
| Flex | `crossAxisAlignment` | cross axis | — | `start/end/center/stretch/baseline` |
| Flex | `direction` | `row`/`column` | — | direction of the `flex` primitive |
| Flex | `gap` | num | — | manual interleave space between children |
| Flex | `spacing` | num | — | flex spacing (preferred over `gap` where both are set) |
| Flex | `scroll` | bool | — | legacy `container` scrollable |
| Flex | `textDirection` | `ltr`/`rtl` | — | layout order |
| Flex | `verticalDirection` | `up`/`down` | — | vertical order |
| Flex | `textBaseline` | `alphabetic`/`ideographic` | — | required with `crossAxisAlignment: baseline` |
| Flex | `overflow` | `visible`/`clip`/`fade`/`ellipsis` | — | child overflow |
| Flex | `clipBehavior` | clip | — | clipping behavior |

| Group | Prop | Type | Default | Meaning |
|-------|------|------|---------|---------|
| Interaction | `action` | action | — | the section 3 action object |
| Interaction | `onTap` | action | — | tap gesture |
| Interaction | `onLongPress` | action | — | long-press gesture |
| Interaction | `confirm` | string | — | confirmation prompt shown before the action dispatches |
| Interaction | `tooltip` | string | — | hover tooltip |
| Interaction | `cursor` | cursor | — | mouse cursor (`system/none/click/text/forbidden/grab/grabbing/wait/precise/allScroll/resizeUpDown/resizeLeftRight/alias/cell/contextMenu/copy/help/move/noDrop/progress/zoomIn/zoomOut`) |
| Interaction | `enabled` | bool | `true` | disabled nodes keep layout and drop interaction |
| Interaction | `focusable` | bool | — | participates in focus traversal |
| Interaction | `semanticsLabel` | string | — | semantics label |
| Interaction | `semanticsHint` | string | — | semantics hint |
| Interaction | `semanticsValue` | string | — | semantics value |

| Group | Prop | Type | Default | Meaning |
|-------|------|------|---------|---------|
| A11y | `excludeSemantics` | bool | `false` | exclude descendant semantics; the semantics label/hint/value props above wire into the same `Semantics` wrapper |

The extended universal surface — the level-3 additions, carried into level 4
unchanged. Every client that speaks `api=4` receives them in full; nothing is
stripped for an older level, because there is no older level:

| Group | Prop | Type | Default | Meaning |
|-------|------|------|---------|---------|
| Level 3 | `glass` | bool | `false` | render the node's surface with the glass treatment: a backdrop blur at the token blur radius, a tinted fill at the token opacity and the token saturation (`tokens.glass`). Only the five glass-capable surfaces honour it — `card`, `sheet`, `dialog`, `menu`, `banner` — other nodes ignore it. Without backdrop support the surface degrades to a solid fill at the tint colour |
| Level 3 | `glassTint` | color or token | — | the tint colour of the glass fill (the upstream `--alert-glass-tint`): a `$color.*` token or hex literal, painted as a 4% wash over the glass fill. Only the five glass-capable surfaces honour it; without backdrop support the wash drops with the glass fill (the solid fill wins) |
| Level 3 | `demo` | bool | `false` | the node is decorative: interactive but non-functional — it dispatches inline directives only (`setState`/`patch`/`dialog`/`toast`, never a server-side write) and the client renders the shared disabled-affordance marker for it: a small corner `preview` badge plus the shared tooltip `Preview only — not available in this build`. Every interactive node without a real effect MUST carry it (plan section 14.10; the T117 sweep enforces it). On a `tabs` node with `hasClose` the badge moves to the bottom-right so it never covers the last tab's close `X` |
| Level 3 | `statusPulse` | `pulse`/`ping`/`skeleton`/`preview-loading`/`none` | `none` | duty-cycled attention indicator on indicator-bearing nodes (`progress`): `pulse` runs the 2 s status pulse, `ping` the 2 s ping ring, `skeleton` the 2.4 s shimmer (the `tokens.motion` duty cycles); `preview-loading` (T108) renders the browser-preview bar — a 2 px full-width bar scaling 0.04 → 0.9 over 5.3 s with `cubic-bezier(0.1, 0.5, 0.2, 1)`, held at 0.9 (`forwards`), and reads the `loading` prop for its play state. Other nodes ignore it; the OS reduced-motion preference collapses every mode to a static render |
| Safe area | `safeArea` | bool or object | — | extends the node's padding by the platform safe-area insets (`MediaQuery.padding`): `true` covers all four edges, or `{top, bottom, left, right}` bools select per-edge. Edges the platform reports as zero add nothing |

### 2.2 Token references

Any string prop whose value starts with `$` is a token reference:
`$spacing.md`, `$color.accent`, `$radius.lg`, `$motion.fast`, `$size.sidebar`,
`$font.mono`. At level 4 the reference is resolved **by indirection**: the
renderer emits `$family.key` as `var(--<family>-<key>)` (the dot becomes a
hyphen), so the value is still resolved per theme — by the CSS cascade
instead of a client-side lookup table (section 9.4). Token namespaces mirror
the bootstrap `tokens` block plus `color` (theme palette), `size` (layout
constants such as `$size.sidebar`) and `font`. Unknown keys are rejected at
build time by `UiTokens`; a reference that still reaches the wire unresolved
renders as the literal string and the node still renders, exactly like the
`when`/`${…}` degrade rule (section 7).

`UiTokens` values are already verbatim CSS (`var(--accent)`,
`color-mix(in oklab, …)`, `0.625rem`, `cubic-bezier(0.32, 0.72, 0, 1)`,
`2.4s`), so the client never parses a token value: there is no
`parseCssLength` and no `parseCssDuration` in the runtime.

### 2.3 Universal prop application order

**One node → one element** (plus an explicit wrapper only where CSS cannot
express the prop). The former 15-step widget wrapping order survives as an
application **order** on a single box, because in CSS decoration, padding,
constraints, aspect ratio, opacity, transform, clip and alignment are all
properties of the same box. `UniversalProps` applies them in this order —
tested, not re-derivable:

1. **decoration** — `color`/`gradient`/`border`/`borderWidth`/`borderStyle`/`borderRadius`/`shadow`, plus the text style on text-bearing nodes;
2. **padding** — `padding`;
3. **constraints** — `minWidth`/`maxWidth`/`minHeight`/`maxHeight`/`width`/`height`;
4. **aspect-ratio** — `aspectRatio`;
5. **opacity** — `opacity`;
6. **transform** — `transform`;
7. **clip** — `clip`/`clipBehavior` as `overflow` (the radius from step 1 clips with it);
8. **align** — `align`/`alignment` as `justify-content`/`justify-items`/`align-self`;
9. **`title`** — the `tooltip` prop;
10. **pointer and keyboard handlers** — `action`/`onTap`/`onLongPress`/`confirm`/`enabled`/`cursor`/`focusable` as `data-jhin-action`, `data-jhin-confirm`, `cursor` and `tabindex`;
11. **ARIA** — `semanticsLabel`/`semanticsHint`/`semanticsValue`/`excludeSemantics` as `aria-label`/`aria-description`/`aria-valuetext`/`aria-hidden`, and `enabled: false` as `aria-disabled`;
12. **flex** — `flex` → `flex-grow`, `fit` → `flex` (`tight` fills, `loose` shrinks);
13. **margin** — `margin`.

Primitives that already own their interaction (`button`, `icon_button`,
`dropdown`) never receive a second handler: step 10 writes the action onto
the semantic element itself, so no node ever carries two dispatch paths.

### 2.4 Degradation rules

The direction is inverted from level 3. The server can only emit types it
knows, so the surviving risk is a **stale `app.js` against a newer server**,
not a stale client against a newer wire:

- Unknown markup is inert: the browser renders unknown classes and attributes
  without complaint, so the HTML always paints.
- An unknown `data-jhin-type` in the runtime's directive and prop-applier
  paths is ignored with a `console.warn` — never a throw.
- An unknown node type on the server renders the `jhin-unsupported`
  placeholder card.
- An unknown token reference renders as the literal string.
- A `when` parse failure keeps the node **visible** (only an explicit `false`
  hides).
- A `${…}` failure leaves the raw template in place as text.
- An unknown icon name renders an empty `<svg>` and logs (section 9.6).
- The client never crashes on server content.

### 2.5 Primitive catalog

The catalog is the **68 names** below — unchanged at level 4, which changes
the serialization and not the vocabulary. `container` stays as the legacy
name; `box` is its superset.

- Layout — `screen`, `shell`, `container`, `box`, `row`, `column`, `flex`,
  `expanded`, `flexible`, `stack`, `positioned`, `align`, `center`,
  `sized_box`, `aspect_ratio`, `wrap`, `grid`, `scroll`, `divider`, `spacer`,
  `list`, `list_row`, `table`, `tree`, `split`
- Text — `text`, `rich_text`, `markdown`, `code_block`
- Controls — `button`, `icon_button`, `icon`, `input`, `textarea`,
  `dropdown`, `checkbox`, `switch`, `slider`, `form`, `segmented`, `menu`,
  `tabs`, `kbd`, `scroll_fade`
- Surfaces — `card`, `drawer`, `sheet`, `dialog`, `banner`, `chip`, `badge`,
  `avatar`, `skeleton`, `progress`, `image`, `figure`, `hover_card`,
  `toast_stack`
- Data — `stream_view`, `chart_line`, `chart_bar`, `chart_pie`, `diff_view`
- Nav — `nav`
- Universal additions (level 3) — `glass`, `demo`, `statusPulse`, `safeArea`

The four universal additions are props of the universal surface (section
2.1), not node types; they are listed here because the contract catalog —
the set of names a server may emit on a node — is what this section defines.
The `glass` prop carries the optional `glassTint` companion (the tint colour
of the glass fill, section 2.1). Every primitive accepts the full universal
surface of section 2.1 in addition
to the props listed below. Required props are listed first; the Default
column shows the built-in default, `—` means no default (prop absent).

### 2.6 Per-primitive props

**Reserved input ids** are client affordances: an `input`/`textarea` node
carrying one attaches to client behaviour instead of behaving like a plain
field.

| Reserved `id` | Affordance |
|---------------|------------|
| `messageInput` | the composer host of the keyboard flow — the field the composer commands (`composer.send`, `composer.newline`, recall) edit |
| `keyCapture` | key-chord capture (T70): while focused, the next keystroke is recorded into the field's UiState value as a chord spec (`mod+shift+enter` — the platform's mod key is written `mod`) instead of typing, and the chord never reaches the keymap |

Layout primitives:

| Primitive | Prop | Type | Default | Description |
|-----------|------|------|---------|-------------|
| `screen` | `body` | node | — | screen content (required) |
| `screen` | `title` | string | — | app-bar title |
| `screen` | `appBar` | node | — | custom app-bar node |
| `screen` | `floatingAction` | node | — | floating action node |
| `shell` | `sidebar` | node | — | sidebar region (a `nav` with `kind: sidebar`) |
| `shell` | `header` | node | — | top header region |
| `shell` | `body` | node | — | main region; a shell without `body` degrades to a card with "Missing body" |
| `shell` | `detail` | node | — | optional right detail region |
| `shell` | `rail` | node | — | optional navigation rail for narrow widths |
| `shell` | `topbar` | node | — | workspace top bar (T95): rendered at the `layout.topbarHeight` token (52) with the workspace gutters and the safe-area insets; the body content under it wears the seven-stop topbar scroll fade |
| `shell` | `topbarCompact` | node | — | condensed top bar below the breakpoint (T95): the breadcrumb reduced to the current title; absent, `topbar` is reused |
| `shell` | `pageHeader` | node | — | page header row above the body: title plus the actions (T95) |
| `shell` | `terminal` | node | — | optional terminal drawer below the body row (T95); keeps its grip and caps at 40% of the viewport height below the breakpoint |
| `shell` | `stageBackdrop` | bool | `false` | paint the `theme.stageArt` gradient behind the sidebar under the sidebar-stage fade mask (T95) |
| `shell` | `breakpoint` | num | 768 | width below which the sidebar becomes a drawer (T95: the fixed responsive breakpoint — below it the sidebar overlays with a backdrop, the right panel is hidden and the gutters compress to 0.5rem) |
| `shell` | `sidebarWidth` | num or token | 280 | expanded sidebar width |
| `shell` | `sidebarCollapsedWidth` | num | 56 | collapsed sidebar width |
| `shell` | `collapsible` | bool | `false` | the sidebar can collapse |
| `shell` | `collapsed` | bool | `false` | current collapsed state; patchable via the node `id` |
| `container` | `children` | node array | — | child nodes |
| `container` | `direction` | `row`/`column` | `column` | layout direction |
| `container` | `gap` | num | 0 | space between children |
| `container` | `align` | alignment | — | child alignment |
| `container` | `scroll` | bool | `false` | scrollable container |
| `container` | `laneWidth` | length | — | chat content lane (T100): caps the container width and centers it — the `.chat-content-lane` recipe. The client `chatWidth` switch resolves the effective lane (`normal` keeps the server default `46rem`, `wide` forces `72rem`, `full` removes the cap), the way upstream sets `--chat-content-max-width` per `data-chat-width` on `:root` |
| `container` | `panelWidth` | length | — | right-panel dock (T105): a fixed width parsed against the interface rem base — the `--thread-details-panel-width` `17.5rem` default (index.css:129) |
| `container` | `rowKind` | string | — | timeline row kind (T101): one of the 14 chat row kinds (`message`, `assistant-meta`, `event`, `work`, `work-live`, `work-toggle`, `thinking`, `proposed-plan`, `working`, `worktree-setup`, `turn-fold`, `attempt-fold`, `context-compaction`, `unknown`); the client resolves the row's trailing gap from it (the upstream `pb-*` scale) |
| `container` | `rowKey` | string | — | continuation key (T101): `` `${type}:${subtype}` `` — consecutive stream items sharing the key render as one visual group with no gap inside (the upstream `continuesWorkLog` rule) |
| `box` | `child` | node | — | single child |
| `box` | `children` | node array | — | children (laid out per `direction` when several) |
| `box` | `direction` | `row`/`column` | — | children direction |
| `box` | `shape` | `rectangle`/`circle` | `rectangle` | decoration shape |
| `box` | `alignment` | alignment | — | alias of `align` |
| `row` | `children` | node array | — | children laid out horizontally; accepts the full Flex group |
| `column` | `children` | node array | — | children laid out vertically; accepts the full Flex group |
| `flex` | `direction` | `row`/`column` | — | required direction; accepts the full Flex group |
| `flex` | `children` | node array | — | children |
| `expanded` | `flex` | int | 1 | flex factor |
| `expanded` | `child` | node | — | child |
| `flexible` | `flex` | int | 1 | flex factor |
| `flexible` | `fit` | `loose`/`tight` | `loose` | fit |
| `flexible` | `child` | node | — | child |
| `stack` | `children` | node array | — | layered children (`positioned` allowed) |
| `stack` | `alignment` | alignment | `topLeft` | alignment of non-positioned children |
| `stack` | `fit` | `loose`/`passthrough`/`expand` | `loose` | stack fit |
| `stack` | `clipBehavior` | clip | `hardEdge` | clipping |
| `stack` | `textDirection` | `ltr`/`rtl` | — | layout order |
| `positioned` | `top` | num | — | offset from the top |
| `positioned` | `right` | num | — | offset from the right |
| `positioned` | `bottom` | num | — | offset from the bottom |
| `positioned` | `left` | num | — | offset from the left |
| `positioned` | `width` | num | — | width |
| `positioned` | `height` | num | — | height |
| `positioned` | `child` | node | — | the layered child |
| `align` | `align` | alignment | `center` | alignment (`alignment` accepted as alias) |
| `align` | `child` | node | — | child |
| `center` | `child` | node | — | child |
| `sized_box` | `width` | num | — | width |
| `sized_box` | `height` | num | — | height |
| `sized_box` | `child` | node | — | child |
| `aspect_ratio` | `aspectRatio` | num | — | width / height ratio (required; missing or non-positive degrades to the plain child) |
| `aspect_ratio` | `child` | node | — | child |
| `wrap` | `children` | node array | — | children |
| `wrap` | `direction` | `horizontal`/`vertical` | `horizontal` | run direction |
| `wrap` | `alignment` | wrap alignment | `start` | main-axis alignment (`start/center/end/spaceBetween/spaceAround/spaceEvenly`) |
| `wrap` | `spacing` | num | 0 | gap between items in a run |
| `wrap` | `runSpacing` | num | 0 | gap between runs |
| `wrap` | `runAlignment` | wrap alignment | `start` | run alignment |
| `wrap` | `crossAxisAlignment` | wrap alignment | `start` | cross-axis alignment |
| `wrap` | `textDirection` | `ltr`/`rtl` | — | layout order |
| `wrap` | `verticalDirection` | `up`/`down` | `down` | vertical order |
| `grid` | `columns` | int | — | required column count |
| `grid` | `childAspectRatio` | num | 1.0 | cell aspect ratio |
| `grid` | `crossAxisSpacing` | num | 0 | cross-axis gap |
| `grid` | `mainAxisSpacing` | num | 0 | main-axis gap |
| `grid` | `shrinkWrap` | bool | `false` | size to content |
| `grid` | `physics` | physics | — | `neverScrollable/alwaysScrollable/bouncing/clamping` |
| `grid` | `children` | node array | — | cells |
| `scroll` | `children` | node array | — | eager children |
| `scroll` | `items` | node array | — | lazy slot: with `itemCount`, only visible children build |
| `scroll` | `itemCount` | int | — | enables lazy building of `items` |
| `scroll` | `scrollDirection` | `vertical`/`horizontal` | `vertical` | scroll axis |
| `scroll` | `reverse` | bool | `false` | reversed order |
| `scroll` | `controller` | string | — | id of the scrollable to attach to |
| `scroll` | `physics` | physics | — | `neverScrollable/alwaysScrollable/bouncing/clamping` |
| `scroll` | `shrinkWrap` | bool | `false` | size to content |
| `divider` | `height` | num | 16 | total height |
| `divider` | `thickness` | num | — | line thickness |
| `divider` | `color` | color | — | line color |
| `divider` | `indent` | num | 0 | leading inset |
| `divider` | `endIndent` | num | 0 | trailing inset |
| `spacer` | `axis` | `vertical`/`horizontal` | `vertical` | spacer axis |
| `spacer` | `size` | num or token | `$spacing.sm` | spacer extent |
| `list` | `items` | node or string array | — | entries (strings are text shorthand) |
| `list` | `maxHeight` | num | — | height limit |
| `list` | `sections` | section array | — | grouped mode, see the section table below |
| `list` | `separator` | node | — | inserted between entries |
| `list` | `onReorder` | action | — | reorder affordance; reports the new order |
| `list` | `selection` | bool | `false` | selectable entries |
| `list` | `itemExtent` | num | — | fixed entry extent |
| `list` | `prototypeItem` | node | — | prototype for extent inference |
| `list` | `empty` | node | — | rendered when there are no items |
| `list` | `header` | node | — | node pinned above the scrollable, outside it (the sidebar header block) |
| `list` | `footer` | node | — | node pinned below the scrollable, outside it (the sidebar footer block) |
| `list` | `search` | object | — | client-side section filter `{key, fields?, empty?}`: the UiState string under `key` filters the section items against their `fields` (default `title`/`subtitle`, ASCII case-folded contains) and a match-count line renders above the sections while it is non-empty (`N matches`, or the `empty` text — default `No threads found` — when nothing matches) |
| `list_row` | `leading` | node | — | leading widget |
| `list_row` | `title` | node or string | — | title |
| `list_row` | `subtitle` | node or string | — | subtitle |
| `list_row` | `trailing` | node | — | trailing widget |
| `list_row` | `badge` | node | — | badge widget |
| `list_row` | `action` | action | — | tap action |
| `list_row` | `selected` | bool | `false` | selected tint (`sidebar-row-active` token + 1 px ring) |
| `list_row` | `onLongPress` | action | — | long-press action |
| `list_row` | `dragHandle` | bool | `false` | visual drag affordance (reorder itself goes through actions) |
| `list_row` | `statusIndicators` | string array | — | the leading status-indicator kinds (`working`, `idle`, `monitoring`, `needs-approval`, `needs-answer`, `failed`, `limited`, `snoozed`, `settled`, `unread`, `pinned`); an unknown kind falls back to `idle` and logs |
| `list_row` | `hoverReveal` | bool | `false` | the trailing cluster fades in on hover or focus |
| `list_row` | `searchMatch` | object | — | `{key, minChars?}` — the match pill shows in the trailing cluster when the UiState query under `key` is at least `minChars` (default 2) characters and matches the row's title or subtitle |
| `list_row` | `commandSubtitle` | string | no | the command id text of a palette-sourced row (T98, the `ThreadCommandSubtitle` port) — the trailing muted marker; absent on rows the palette did not produce |
| `list_row` | `dragging` | bool | `false` | the row renders as the lifted card (opaque surface + shadow) |
| `list_row` | `draggable` | bool | `false` | the row can be picked up by a long-press; the sectioned `list` drives the drag choreography (the flat list ignores it) |
| `list_row` | `dragLabel` | node | — | the reveal-label chip template shown on the dragged row while a drop target is hovered; the client swaps the template's icon and text with the hovered target's badge word (the upstream `dropVerbBadge` port) and paints the primary-tinted pill surface around it |
| `list_row` | `dropTargets` | target array | — | `[{id, label, accentWhenHovered, action?}]` — the section ids the row may be dropped on, the badge word per target, whether the hovered header takes the accent colour, and the lifecycle action the drop dispatches exactly once (absent for a purely decorative drag) |
| `table` | `columns` | column array | — | see the column table below |
| `table` | `rows` | cell array | — | arrays of cells (node or string) |
| `table` | `zebra` | bool | `false` | striped rows |
| `table` | `hoverable` | bool | `false` | hover highlight |
| `table` | `onRowTap` | action | — | row tap action |
| `table` | `stickyHeader` | bool | `false` | header stays visible while scrolling |
| `table` | `sort` | object | — | current sort `{column, ascending}` |
| `table` | `onSort` | action | — | sortable header tap; fires with `{column, ascending}` merged into the payload |
| `table` | `empty` | node | — | rendered when `rows` is missing or empty |
| `tree` | `items` | item array | — | nested items, see the item table below |
| `tree` | `onSelect` | action | — | fired with the selected item |
| `split` | `first` | node | — | leading pane (required) |
| `split` | `second` | node | — | trailing pane (required) |
| `split` | `axis` | `horizontal`/`vertical` | `horizontal` | pane direction |
| `split` | `initial` | num | — | initial divider position (px from the leading edge) |
| `split` | `min` | num | — | minimum first-pane extent |
| `split` | `max` | num | — | maximum first-pane extent |
| `split` | `minSecond` | num | — | minimum second-pane extent |
| `split` | `persistKey` | string | — | client store key the divider position persists under |
| `split` | `handleStyle` | `rail`/`grip`/`invisible` | `rail` | drag-handle look; the handle resizes by drag (mouse and touch) and by arrow keys (16 px steps) when focused |

Text primitives:

| Primitive | Prop | Type | Default | Description |
|-----------|------|------|---------|-------------|
| `text` | `text` | string | — | content (required) |
| `text` | `style` | `h1`/`h2`/`h3`/`body`/`small`/`caption`/`mono` | `body` | typography token |
| `text` | `bold` | bool | `false` | bold |
| `text` | `italic` | bool | `false` | italic |
| `text` | `color` | color | — | text color |
| `text` | `strutStyle` | object | — | `{size?, height?, leading?}` |
| `text` | `textWidthBasis` | `parent`/`longestLine`/`character` | `parent` | width basis (`character` has no HTML counterpart and degrades to `parent`) |
| `text` | `locale` | string | — | BCP-47 tag |
| `text` | `selectionColor` | color | — | selection color |
| `rich_text` | `spans` | span array | — | inline spans, see the span table below |
| `markdown` | `text` | string | — | markdown source (required) |
| `markdown` | `codeBlockStyle` | string | — | code-fence style name |
| `markdown` | `syntax` | bool | `false` | token-driven syntax coloring in fences (T104) |
| `markdown` | `skills` | string array | — | known `$skill` names; a known token renders the inline skill chip (T104) |
| `code_block` | `code` | string | — | source text (required) |
| `code_block` | `language` | string | — | language label |
| `code_block` | `wrap` | bool | `false` | wrap long lines |
| `code_block` | `copyable` | bool | `false` | copy affordance (copies via clipboard + toast) |
| `code_block` | `maxLines` | int | — | line limit |
| `code_block` | `lineNumbers` | bool | `false` | show line numbers |

Markdown block mapping (`markdown` parses its `text` and renders the mapped
nodes through the normal primitive pipeline):

| Markdown | Node |
|----------|------|
| paragraph (plain) | `text` |
| paragraph with inline markup | `rich_text` (spans: link → `action: {op: openUrl, value: href}` + `textDecoration: underline` + `color: $color.info-foreground` + a leading `icon: open_in_new` glyph on http(s) links, `strong` → `fontWeight: 700`, `em` → `fontStyle: italic`, inline code → `fontFamily: $font.mono`, `del` → `textDecoration: lineThrough`) |
| heading `#`…`###` | `text` (`style: h1`…`h3`) |
| heading `####`…`######` | `rich_text` with the small-heading run (`fontSize: 14`, `fontWeight: 600`; h6 adds `color: $color.muted-foreground`) |
| fenced / indented code | `code_block` (`code`, `language` from the info string, `copyable: true` — the header recipe: the muted language label and the ghost copy action) |
| display math `$$ … $$` | `code_block` (`language: math` — the non-feature: the raw TeX source shows in a mono block) |
| bullet / ordered list | `list` (`items`; ordered items carry their `1.` prefix; nested lists nest inside a `container` item) |
| task-list item | `list` item whose leading span is the checkbox glyph (`check_box` tinted `$color.accent` when checked, `check_box_outline_blank` tinted `$color.muted-foreground` otherwise — the glyph replaces the list marker) |
| blockquote | `card` (`children` = the mapped inner blocks) |
| blockquote `[!NOTE]` `[!TIP]` `[!IMPORTANT]` `[!WARNING]` `[!CAUTION]` | `column` bordered callout (`border: $color.info`/`$color.success`/`$color.accent`/`$color.warning`/`$color.error`, `borderRadius: $radius.sm`) with the icon + coloured title and the mapped body (the marker must sit alone on its first line, the GitHub rule) |
| `t3-citation://` link | `rich_text` span with `chip: {kind: citation, label: <quoted text>}` — the inline citation pill, no `openUrl` |
| known `$skill` token | `rich_text` span with `chip: {kind: skill, label: $name}` — the inline skill pill (only against the `skills` list; never inside code or links) |
| table | `table` (`columns`, `rows`) |
| thematic break | `divider` |
| standalone image (a paragraph's only content) | `image` (`src`, `semanticsLabel` from the alt text, `zoomable: true` — tapping opens the zoom dialog) |
| inline image | `rich_text` span with `image: {src, semanticsLabel?}` — stays in the sentence |
| footnote reference `[^1]` | plain text without a link action (the plain-refs non-feature) |

Markdown degrades (§2.4 — the client never crashes on server content):

- an unbalanced (unclosed) fenced code block degrades the whole `markdown`
  node to a single plain `text` carrying the raw source;
- a `$$` display-math marker that never closes stays plain text;
- unsupported or malformed blocks — HTML blocks, footnote definitions and
  references, definition lists, unknown elements — degrade to plain `text`
  (their text content; an HTML block keeps its raw source);
- unknown inline elements flatten to their plain text;
- `syntax: true` colours keywords, strings, numbers and comments through the
  semantic tokens (`$color.accent` / `$color.success` / `$color.warning` /
  `$color.muted-foreground`); unknown constructs keep the code foreground;
- `codeBlockStyle` is accepted; the contract defines no literal set yet, so
  every value renders the default `code_block` look;
- a parse that throws (beyond the degrades above) is caught: the raw source
  renders as plain `text` — the mapping never throws (§2.4).

Control primitives:

| Primitive | Prop | Type | Default | Description |
|-----------|------|------|---------|-------------|
| `button` | `label` | string | — | label (required) |
| `button` | `style` | `primary`/`secondary`/`danger`/`text` | `primary` | visual style |
| `button` | `action` | action | — | dispatch action |
| `button` | `icon` | icon name | — | leading icon |
| `button` | `confirm` | string | — | confirmation prompt |
| `icon_button` | `icon` | icon name | — | icon (required) |
| `icon_button` | `action` | action | — | dispatch action |
| `icon_button` | `iconSize` | num | — | icon size |
| `icon_button` | `color` | color | — | icon color |
| `icon_button` | `disabledColor` | color | — | disabled color |
| `icon_button` | `highlightColor` | color | — | highlight color |
| `icon_button` | `splashColor` | color | — | splash color |
| `icon_button` | `focusColor` | color | — | focus color |
| `icon_button` | `hoverColor` | color | — | hover color |
| `icon_button` | `padding` | padding | — | padding |
| `icon_button` | `alignment` | alignment | — | alignment |
| `icon_button` | `constraints` | object | — | size constraints `{minWidth, minHeight, …}` |
| `icon_button` | `autofocus` | bool | `false` | autofocus |
| `icon_button` | `isSelected` | bool | — | toggled state |
| `icon_button` | `selectedIcon` | icon name | — | icon when selected |
| `icon_button` | `mouseCursor` | cursor | — | mouse cursor |
| `icon_button` | `visualDensity` | density | — | visual density |
| `icon_button` | `enableFeedback` | bool | — | acoustic/haptic feedback |
| `icon_button` | `splashRadius` | num | — | splash radius |
| `icon_button` | `style` | object | — | ButtonStyle map |
| `icon` | `icon` | icon name | — | icon name (required) |
| `icon` | `size` | num | — | icon size |
| `icon` | `color` | color | — | icon color |
| `icon` | `semanticLabel` | string | — | semantics label |
| `icon` | `fill` | num | — | fill of variable icons |
| `icon` | `weight` | num | — | weight of variable icons |
| `icon` | `grade` | num | — | grade of variable icons |
| `icon` | `opticalSize` | num | — | optical size of variable icons |
| `icon` | `shadows` | shadow array | — | icon shadows |
| `icon` | `textDirection` | `ltr`/`rtl` | — | rendering direction |
| `icon` | `blendMode` | blend mode | — | color blend mode |
| `input` | `id` | string | — | UiState field id (required) |
| `input` | `label` | string | — | label |
| `input` | `value` | string | — | current value |
| `input` | `placeholder` | string | — | placeholder |
| `input` | `multiline` | bool | `false` | multiline |
| `input` | `obscure` | bool | `false` | obscure text |
| `input` | `keyboard` | keyboard type | — | legacy spelling of `keyboardType` |
| `input` | `required` | bool | `false` | validation |
| `input` | `min` | num | — | validation bound |
| `input` | `max` | num | — | validation bound |
| `input` | `pattern` | string | — | validation pattern |
| `input` | `errorText` | string | `Invalid value` | validation failure text |
| `input` | `keyboardType` | keyboard type | — | `text/number/phone/email/url/visiblePassword/multiline` |
| `input` | `textInputAction` | ime action | — | `done/go/next/previous/search/send/newline/…` |
| `input` | `textCapitalization` | `none`/`words`/`sentences`/`characters` | — | capitalization |
| `input` | `maxLength` | int | — | length limit |
| `input` | `maxLengthEnforcement` | `none`/`enforced`/`truncateAfterCompositionEnds` | — | limit enforcement |
| `input` | `minLines` | int | — | minimum lines |
| `input` | `maxLines` | int | — | maximum lines |
| `input` | `expands` | bool | `false` | fill the parent |
| `input` | `autocorrect` | bool | `true` | autocorrect |
| `input` | `enableSuggestions` | bool | `true` | suggestions |
| `input` | `obscuringCharacter` | string | bullet (U+2022) | obscuring character |
| `input` | `enableInteractiveSelection` | bool | `true` | selection gestures |
| `input` | `readOnly` | bool | `false` | read-only |
| `input` | `showCursor` | bool | — | cursor visibility |
| `input` | `autofocus` | bool | `false` | autofocus |
| `input` | `cursorWidth` | num | — | cursor width |
| `input` | `cursorHeight` | num | — | cursor height |
| `input` | `cursorRadius` | num | — | cursor radius |
| `input` | `cursorColor` | color | — | cursor color |
| `input` | `mouseCursor` | cursor | — | mouse cursor |
| `input` | `textAlign` | text align | — | text alignment |
| `input` | `scrollPadding` | padding | — | scroll padding |
| `input` | `restorationId` | string | — | restoration id |
| `input` | `hintText` | string | — | decoration hint |
| `input` | `helperText` | string | — | decoration helper |
| `input` | `labelText` | string | — | decoration label |
| `input` | `prefixIcon` | icon name | — | decoration prefix icon |
| `input` | `suffixIcon` | icon name | — | decoration suffix icon |
| `input` | `counterText` | string | — | decoration counter |
| `input` | `semanticCounterText` | string | — | semantics counter text |
| `input` | `prefix` | string | — | decoration prefix text |
| `input` | `suffix` | string | — | decoration suffix text |
| `input` | `fillColor` | color | — | decoration fill color |
| `input` | `filled` | bool | `false` | decoration filled |
| `input` | `hoverColor` | color | — | decoration hover color |
| `input` | `focusColor` | color | — | decoration focus color |
| `input` | `floatingLabelBehavior` | `never`/`always`/`auto` | `auto` | label floating |
| `input` | `border` | border spec | — | input border: `underline/outline/none` or a `{style?, width?, radius?, color?}` map (overrides the universal decoration on this node) |
| `input` | `enabledBorder` | border spec | — | border when enabled |
| `input` | `focusedBorder` | border spec | — | border when focused |
| `input` | `errorBorder` | border spec | — | border on error |
| `input` | `focusedErrorBorder` | border spec | — | border when focused with an error |
| `input` | `disabledBorder` | border spec | — | border when disabled |
| `input` | `contentPadding` | padding | — | decoration content padding |
| `input` | `isDense` | bool | — | dense decoration |
| `input` | `isCollapsed` | bool | — | collapsed decoration |
| `input` | `dense` | bool | — | dense layout |
| `input` | `alignLabelWithHint` | bool | — | label alignment |
| `input` | `constraints` | object | — | decoration constraints |
| `input` | `style` | object | — | TextStyle map |
| `input` | `toolbarOptions` | object | — | `{copy, cut, paste, selectAll}` bools |
| `input` | `smartDashesType` | bool | — | smart dashes |
| `input` | `smartQuotesType` | bool | — | smart quotes |
| `input` | `onEditingChanged` | action | — | editing-state change |
| `input` | `onAppended` | action | — | text appended |
| `input` | `onRemoved` | action | — | text removed |
| `input` | `decoration` | object | — | full InputDecoration map; the flattened keys above win when both are present |
| `textarea` | (any) | — | — | accepts the full `input` prop set; `multiline` defaults to `true` |
| `dropdown` | `id` | string | — | UiState field id (required) |
| `dropdown` | `items` | item array | — | `[{label, value}]` |
| `dropdown` | `value` | any | — | selected value |
| `dropdown` | `action` | action | — | change action |
| `dropdown` | `hint` | string | — | placeholder |
| `dropdown` | `isExpanded` | bool | `false` | expand width |
| `dropdown` | `isDense` | bool | `false` | dense |
| `dropdown` | `elevation` | num | 8 | menu elevation |
| `dropdown` | `icon` | icon name | — | trailing icon |
| `dropdown` | `iconSize` | num | — | icon size |
| `dropdown` | `alignment` | alignment | — | alignment |
| `dropdown` | `borderRadius` | num | — | menu radius |
| `dropdown` | `itemHeight` | num | — | item height |
| `dropdown` | `selectedItemBuilder` | node array | — | custom selected rendering |
| `dropdown` | `menuMaxHeight` | num | — | menu height limit |
| `dropdown` | `focusColor` | color | — | focus color |
| `dropdown` | `dropdownColor` | color | — | menu color |
| `checkbox` | `id` | string | — | UiState field id (required) |
| `checkbox` | `label` | string | — | label |
| `checkbox` | `value` | bool | `false` | checked state |
| `checkbox` | `tristate` | bool | `false` | null state allowed |
| `checkbox` | `fillColor` | color | — | fill color |
| `checkbox` | `hoverColor` | color | — | hover color |
| `checkbox` | `focusColor` | color | — | focus color |
| `checkbox` | `disabledColor` | color | — | disabled color |
| `checkbox` | `thumbIcon` | icon name | — | check icon |
| `checkbox` | `trackColor` | color | — | track color |
| `checkbox` | `mouseCursor` | cursor | — | mouse cursor |
| `checkbox` | `splashRadius` | num | — | splash radius |
| `checkbox` | `dense` | bool | `false` | dense |
| `switch` | `id` | string | — | UiState field id (required) |
| `switch` | `label` | string | — | label |
| `switch` | `value` | bool | `false` | on state |
| `switch` | `activeColor` | color | — | thumb color when on |
| `switch` | `activeTrackColor` | color | — | track color when on |
| `switch` | `inactiveThumbColor` | color | — | thumb color when off |
| `switch` | `inactiveTrackColor` | color | — | track color when off |
| `switch` | `thumbColor` | color | — | thumb color |
| `switch` | `trackColor` | color | — | track color |
| `switch` | `trackOutline` | color | — | track outline color |
| `switch` | `thumbIcon` | icon name | — | thumb icon |
| `switch` | `mouseCursor` | cursor | — | mouse cursor |
| `switch` | `splashRadius` | num | — | splash radius |
| `switch` | `focusColor` | color | — | focus color |
| `switch` | `hoverColor` | color | — | hover color |
| `switch` | `dense` | bool | `false` | dense |
| `slider` | `id` | string | — | UiState field id (required) |
| `slider` | `min` | num | 0 | minimum |
| `slider` | `max` | num | 1 | maximum |
| `slider` | `step` | num | — | discrete step (absent = continuous) |
| `slider` | `label` | string | — | value label |
| `slider` | `value` | num | — | current value |
| `slider` | `activeColor` | color | — | active color |
| `slider` | `inactiveColor` | color | — | inactive color |
| `slider` | `thumbColor` | color | — | thumb color |
| `slider` | `overlayColor` | color | — | overlay color |
| `slider` | `semanticFormatterCallback` | string | — | accessibility value template; `{value}` is replaced with the current value |
| `slider` | `mouseCursor` | cursor | — | mouse cursor |
| `slider` | `onChangeStart` | action | — | drag start |
| `slider` | `onChangeEnd` | action | — | drag end |
| `form` | `fields` | node array | — | field nodes (required) |
| `form` | `submit` | object | — | `{label, action}` (required) |
| `form` | `autovalidateMode` | `disabled`/`always`/`onUserInteraction` | `disabled` | validation mode |
| `form` | `onChanged` | action | — | any-field change |
| `segmented` | `segments` | segment array | — | `[{label, value, icon?}]` |
| `segmented` | `value` | any | — | selected value |
| `segmented` | `action` | action | — | selection action |
| `menu` | `trigger` | node | — | the node that opens the menu |
| `menu` | `items` | item array | — | see the menu item table below |
| `menu` | `breakpoint` | num | — | below this width the menu opens as a `sheet` |
| `tabs` | `items` | item array | — | see the tabs item table below |
| `tabs` | `activeIndex` | int | 0 | selected tab; patchable via the node `id` |
| `tabs` | `variant` | `underline`/`pill`/`segmented` | `underline` | visual variant |
| `tabs` | `hasClose` | bool | `false` | render a per-tab close `X` (T105): closing removes the tab with a client-side `patch` on the node `id`; an item marked `closable: false` is a no-op |
| `tabs` | `closeAction` | action | — | run when the last closable tab closes (T105) — the panel-close `setState` |
| `kbd` | `chord` | string | — | the chord to render as key pills (required); modifiers join with `+` and `mod` resolves per platform (Cmd on macOS, Ctrl elsewhere); unknown chord tokens render literally and log, never throw |
| `scroll_fade` | `child` | node | — | the scrollable the fade wraps (required) |
| `scroll_fade` | `edge` | `top`/`bottom`/`start`/`end` | `top` | scrolled edge the gradient paints at |
| `scroll_fade` | `height` | num or token | 24 | fade extent (px) |
| `scroll_fade` | `mode` | `topbar`/`virtualized` | `topbar` | fade recipe (`topbar` for chrome bars, `virtualized` for lazy lists) |

Surface primitives:

| Primitive | Prop | Type | Default | Description |
|-----------|------|------|---------|-------------|
| `card` | `children` | node array | — | content |
| `card` | `title` | string | — | title |
| `drawer` | `children` | node array | — | content |
| `drawer` | `title` | string | — | title |
| `sheet` | `title` | string or node | — | title |
| `sheet` | `body` | node | — | content |
| `sheet` | `footer` | node | — | footer row |
| `sheet` | `height` | num or token | — | sheet height |
| `sheet` | `dismissible` | bool | `true` | can be dismissed |
| `dialog` | `title` | string or node | — | dialog title |
| `dialog` | `content` | node | — | dialog content |
| `dialog` | `actions` | node array | — | action buttons |
| `banner` | `content` | node | — | notice content |
| `banner` | `actions` | node array | — | notice actions |
| `banner` | `onDismiss` | action | — | dismiss action |
| `chip` | `label` | string | — | label (required) |
| `chip` | `icon` | icon name | — | leading icon |
| `chip` | `avatar` | node | — | leading avatar |
| `chip` | `selected` | bool | `false` | selected state |
| `chip` | `onDeleted` | action | — | delete action; without it the delete affordance is hidden |
| `chip` | `variant` | `assist`/`filter`/`input`/`action` | `assist` | chip variant |
| `chip` | `kind` | `neutral`/`image`/`video`/`file`/`mention`/`terminal`/`element`/`preview-annotation`/`review-comment`/`pull-request`/`pr-open`/`pr-draft`/`pr-merged`/`pr-closed`/`skill`/`thread`/`citation` | `neutral` | the ContextChip colour identity (T103): the client tints the pill with the kind's restrained accent — fill at 11% alpha, border mixed 34% and label 22% toward the accent — so only the hue carries the identity; `neutral` keeps the plain chip; an unknown literal degrades to `neutral` |
| `badge` | `label` | string | — | label |
| `badge` | `color` | color | — | color |
| `badge` | `count` | num | — | count |
| `badge` | `dot` | bool | `false` | dot mode |
| `badge` | `max` | num | 99 | counts above render as `<max>+` |
| `avatar` | `image` | string | — | image src or dataUri |
| `avatar` | `initials` | string | — | initials fallback |
| `avatar` | `icon` | icon name | — | icon fallback |
| `avatar` | `color` | color | — | background color |
| `avatar` | `size` | num | — | diameter |
| `avatar` | `shape` | `circle`/`square` | `circle` | shape |
| `skeleton` | `variant` | `text`/`circle`/`rect`/`list` | `text` | shape variant |
| `skeleton` | `lines` | int | 3 | line count for `text`/`list` |
| `skeleton` | `width` | num | — | width |
| `skeleton` | `height` | num | — | height |
| `skeleton` | `shimmer` | bool | `true` | shimmer animation; collapses under reduced motion |
| `progress` | `kind` | `linear`/`circular` | `linear` | kind |
| `progress` | `value` | num | — | 0..1; omitted = indeterminate |
| `progress` | `color` | color | — | color |
| `progress` | `statusPulse` | `pulse`/`ping`/`skeleton`/`preview-loading`/`none` | `none` | the duty-cycled attention indicator (section 2.1 level 3): `pulse` runs the 2 s stepped status pulse, `ping` the 2 s ping ring, `skeleton` the 2.4 s shimmer — the mode renders the indicator dot (the upstream status-pill treatment); `preview-loading` (T108) renders the browser-preview bar (the upstream `preview-loading-progress` keyframe) and reads `loading`; a complete indicator (`value` ≥ 1.0) renders the static complete bar and never animates; reduced motion collapses every mode to the static render |
| `progress` | `loading` | bool | `false` | T108: the `preview-loading` play state — `true` runs the 5.3 s scaleX animation once and holds at 0.9, `false` keeps the bar hidden (the upstream `data-loading` attribute). Ignored by every other mode |
| `image` | `src` | string | — | image URL (`src` or `dataUri` required) |
| `image` | `dataUri` | string | — | inline data |
| `image` | `width` | num | — | width |
| `image` | `height` | num | — | height |
| `image` | `fit` | box fit | `cover` | `cover/contain/fill/fitWidth/fitHeight/none/scaleDown` |
| `figure` | `shape` | `rectangle`/`circle`/`triangle` | — | shape (required) |
| `figure` | `color` | color | — | fill color (required) |
| `figure` | `width` | num | — | width (required) |
| `figure` | `height` | num | — | height (required) |
| `hover_card` | `trigger` | node | — | the node that opens the card on hover (required; tap-and-hold on touch) |
| `hover_card` | `content` | node | — | card content (required) |
| `hover_card` | `delay` | num | 500 | hover delay (ms) before the card opens |
| `hover_card` | `placement` | `top`/`bottom`/`left`/`right` | `top` | card placement around the trigger; nesting-safe |
| `toast_stack` | `items` | item array | — | the transient notices, see the item table below (required) |
| `toast_stack` | `direction` | `top`/`bottom` | `bottom` | screen edge the stack grows from; items queue, each dismissible, each with its own window |

Data primitives:

| Primitive | Prop | Type | Default | Description |
|-----------|------|------|---------|-------------|
| `stream_view` | `id` | string | — | stream id (required) |
| `stream_view` | `topic` | string | — | SSE endpoint path (required) |
| `stream_view` | `mode` | `append`/`replace` | `append` | frame application mode |
| `stream_view` | `itemLimit` | int | — | oldest items are dropped |
| `stream_view` | `autoScroll` | bool | `false` | follow new items (T100 anchoring: an appended/replaced/removed item jumps to the bottom while the view follows the end — scrolling away beyond the 24 px anchor offset switches to free-scrolling; a `patch` frame never scrolls) |
| `stream_view` | `empty` | node | — | rendered while there are no items |
| `chart_line` | `series` | series array | — | `[{label?, color?, points or values}]` |
| `chart_bar` | `items` | item array | — | `[{label, value, color?}]` (single series) |
| `chart_bar` | `series` | series array | — | `[{label?, color?, values: [{label, value}]}]` (grouped) |
| `chart_pie` | `items` | item array | — | `[{label, value, color?}]` |
| `diff_view` | `file` | string | — | file path shown in the stat header |
| `diff_view` | `language` | string | — | language label |
| `diff_view` | `hunks` | hunk array | — | the diff hunks, see the hunk table below (required) |
| `diff_view` | `view` | `unified`/`split` | `unified` | layout; toggling is a client-side `setState`/`patch`, no round-trip |
| `diff_view` | `colorScheme` | `default`/`blue-orange` | `default` | diff colour scheme (the `data-diff-color-scheme` mapping) |
| `diff_view` | `stats` | object | — | `{additions, deletions}` rendered as the green/red stat header |
| `diff_view` | `demo` | bool | — | MUST be `true`: the view is decorative and renders from server-authored hunks only — no diff engine exists client-side or server-side |

`diff_view` is decorative and always carries `demo: true` (section 2.1): it
renders exactly the hunks the server authors, with the `diff-addition` /
`diff-deletion` token backgrounds and line numbers; it computes nothing.

Nav:

| Primitive | Prop | Type | Default | Description |
|-----------|------|------|---------|-------------|
| `nav` | `kind` | `tabs`/`bottom`/`drawer`/`rail`/`sidebar` | `tabs` | navigation kind |
| `nav` | `items` | item array | — | see the nav item table below |
| `nav` | `activeIndex` | int | — | highlight by index |
| `nav` | `activeId` | string | — | highlight by item id; wins over `activeIndex`; a miss falls back to `activeIndex` (or 0) |

Item and part shapes:

| Node | Prop | Type | Required | Description |
|------|------|------|----------|-------------|
| `nav` item | `label` | string | yes | visible label |
| `nav` item | `icon` | icon name | no | icon |
| `nav` item | `screen` | string | no | screen id to navigate to |
| `nav` item | `action` | action | no | custom action |
| `nav` item | `badge` | node | no | badge widget |
| `nav` item | `count` | num | no | count badge |
| `nav` item | `section` | string | no | sidebar section label (`sidebar` kind renders section groups) |
| `nav` item | `enabled` | bool | no | defaults to `true` |
| `menu` item | `label` | string | yes | visible label |
| `menu` item | `icon` | icon name | no | icon |
| `menu` item | `action` | action | no | dispatch action |
| `menu` item | `confirm` | string | no | confirmation prompt |
| `menu` item | `disabled` | bool | no | disabled entry |
| `menu` item | `divider` | bool | no | render as a divider |
| `menu` item | `danger` | bool | no | destructive styling |
| `menu` item | `children` | item array | no | the nested submenu (T98), one level deep, same item shape; a popup opens a nested popup, a sheet renders the children as an indented group |
| `menu` item | `checked` | bool | no | the radio-style check mark (T98, the `Auto-settle behavior` entries) |
| `menu` item | `separatorBefore` | bool | no | render a divider above the entry (T98) |
| `tabs` item | `label` | string | yes | visible label |
| `tabs` item | `icon` | icon name | no | icon |
| `tabs` item | `badge` | node | no | badge widget |
| `tabs` item | `panel` | node | no | tab panel node |
| `tabs` item | `closable` | bool | no | T105: whether the tab can be closed (default `true`); `false` is a pinned no-op |
| `tabs` item | `closeAction` | action | no | T105: extra action run when this tab closes |
| `table` column | `label` | string | yes | header label |
| `table` column | `width` | num | no | column width |
| `table` column | `sortable` | bool | no | sortable header |
| `table` column | `align` | text align | no | cell alignment |
| `tree` item | `label` | string | yes | visible label |
| `tree` item | `icon` | icon name | no | icon |
| `tree` item | `expanded` | bool | no | initial expansion |
| `tree` item | `action` | action | no | select action |
| `tree` item | `badge` | node | no | trailing badge widget (T107: the changed-files A/M/D status) |
| `tree` item | `stat` | string | no | trailing stat text (T107: the changed-files `+n −m` line stats) |
| `tree` item | `items` | item array | no | nested children |
| `rich_text` span | `text` | string | yes | span text |
| `rich_text` span | `style` | text style | no | span style |
| `rich_text` span | `action` | action | no | tappable span; an unknown action drops the action and keeps the text |
| `rich_text` span | `tooltip` | string | no | span tooltip |
| `rich_text` span | `icon` | icon name | no | T104: an inline registry glyph instead of text, coloured by `style.color` when set (the external-link glyph, the task-list checkbox) |
| `rich_text` span | `chip` | `{kind, label}` | no | T104: an inline context pill instead of text (`kind: citation` for `t3-citation://` links, `skill` for known `$skill` tokens); never interactive by itself |
| `rich_text` span | `image` | `{src, semanticsLabel?}` | no | T104: an inline image instead of text (an image inside a sentence) |
| `list` section | `label` | string | yes | section label (empty sections still show it) |
| `list` section | `id` | string | no | section id |
| `list` section | `collapsible` | bool | no | can collapse |
| `list` section | `collapsed` | bool | no | initial collapsed state |
| `list` section | `items` | node array | yes | section entries |
| `list` section | `when` | expression | no | §8.7 gate over the screen state; `false` removes the whole section (header included), unset or failing keeps it |
| `list` section | `uppercase` | bool | no | render the label uppercased (the data stays canonical) |
| `list` section | `count` | num | no | count-badge number (the rounded-full pill) |
| `list` section | `badgeStyle` | token name | no | the pill surface token (`sidebar-control-surface`); falls back to the secondary surface |
| `list` section | `storeKey` | string | no | client-store key the collapse state persists under; the stored value wins over `collapsed` once read |
| `list` section | `boundaryLabel` | string | no | the boundary label revealed only while a drag is live (the upstream zero-height pinned/active markers): during a revealed drag the section header renders as the boundary anatomy — label + divider line, accent while this section is the hovered drop target |
| `toast_stack` item | `text` | string | yes | notice text |
| `toast_stack` item | `style` | toast style | no | `error`/`success`, like the `toast` directive |
| `toast_stack` item | `action` | action | no | inline action (the 5 s undo pattern) |
| `toast_stack` item | `duration` | num | 5000 | visible window (ms) |
| `diff_view` hunk | `header` | string | yes | hunk header line (the `@@ … @@` marker) |
| `diff_view` hunk | `lines` | line array | yes | `[{kind: add/del/ctx/meta, oldNo, newNo, text}]`; `kind` colors the line, `oldNo`/`newNo` feed the line-number gutters |

## 3. Action protocol

An `action` object appears on `button.action`, `dropdown.action`,
`form.submit`, `list_row.action`, `nav` item `action`, `onTap`, `onLongPress`
and every other action-bearing prop:

```json
{"path": "/ui/action/send", "method": "POST", "name": "send",
 "payload": {"sessionId": "abc"}, "include": ["prompt"]}
```

- `path` — required, non-empty; actions without it are ignored.
- `method` — informational (`POST`); the client posts JSON to `path`.
- `name` — the action name, matched against `POST /ui/action/{name}`.
- `payload` — static fields, optional.
- `include` — input ids whose current local values are merged in.

Client-side dispatch (`ActionDispatcher`), in order:

1. **Validate the included inputs first** — `required`, `min`/`max`,
   `pattern` on `input` nodes (`min`/`max` compare as numbers when the value
   parses as one, else as lengths). A failing field shows its `errorText`
   inline (default `Invalid value`) and **nothing is sent** — zero round-trips.
2. **Merge the payload** — static `payload` plus the included ids' current
   values; include values win on collisions. Typing per field kind: `input` →
   string, `checkbox`/`switch` → bool, `slider` → double, `dropdown` → the
   item's `value` (omitted entirely when nothing is selected), anything else
   passes through.
3. **Run `confirm` first when present** — the confirmation dialog must be
   accepted before anything is sent; a declined confirm dispatches nothing.
4. **Post** `{"action": "<name>", "payload": {…merged}}` to `path`.
5. **Run the response's `client` directives** (section 4).

Server side (`POST /ui/action/{name}`; the body name is informational, the
path capture is authoritative):

- `200` → `{"client": [ …directives ]}` — the directive list the handler
  returned, with the directives this client cannot honour dropped first.
- `404` → `{"error": "unknown_action", "message": "no action named <name>"}`.
- `400` → `{"error": "invalid_request", …}` when the body is not a JSON
  object (a blank body dispatches with an empty payload).

One lifecycle action deserves a note: `undo` (`POST /ui/action/undo`) reverts
the most recent lifecycle action inside its 5-second server-side window; the
server answers with a `toast` + `refresh` pair, or a `nothing-to-undo` toast
when the window has closed.

**Inline directive composite.** An action prop may also be the composite
`{"client": [ …directives ]}` (a directive list in the section 4 wire form):
the client runs it entirely locally, in order, with no server round-trip.
This is the decorative-control composition of docs/sdui.md §2.1 `demo` —
`[setState, toast]`, `[dismissDialog, toast]` and friends. The server
tailors the embedded list exactly like a response directive list (dropping
what the requesting client cannot honour).

## 4. Client directives

Seventeen directives (`Directives` on the server, the `directives` module of
`app.js` on the client). Wire form is the `op` discriminator plus the listed
fields. They appear in action responses, in `{client: […]}` stream frames and
inline in node props (a button action may be one directive).

Exactly **three** ops changed shape at level 4 — `patch`, `setScreen` and
`dialog` carry an `html` fragment where they used to carry merged props or a
serialized tree. The other fourteen —
`navigate back replace refresh reloadBootstrap setToken clearToken
setServerUrl openProfiles toast dismissDialog setState openUrl undo` — are
byte-identical to level 3, including the capability drops of
`Directives.filter`. All seventeen **names** are unchanged, and `setState`
stays the state channel for `when` and `${…}`.

| Directive | Args | Effect |
|-----------|------|--------|
| `navigate` | `screen` | push a screen onto the navigation stack |
| `back` | — | pop the navigation stack |
| `replace` | `screen` | replace the current screen |
| `refresh` | — | re-fetch the current screen (forces network) |
| `reloadBootstrap` | — | drop the client caches and re-run bootstrap |
| `setToken` | `value` | store the bearer token for this origin (`""` clears) |
| `clearToken` | — | drop the stored bearer token |
| `setServerUrl` | `value` | rewrite the active profile URL and reboot against it |
| `openProfiles` | — | open the client-owned server profile surface |
| `toast` | `text`, `style?`, `action?`, `duration?` | show a transient message (`style: "error"` for failures); with an `action` the toast is the T98 undo notice — it renders through the `toast_stack` undo-notice card look (label + `Undo` + close) for `duration` ms (default 5000, the upstream 5 s undo window) and dispatches the action on the `Undo` tap |
| `dialog` | `html`, `kind?` | open a dialog rendering the given HTML fragment (`kind: "sheet"` opens a bottom sheet) |
| `dismissDialog` | — | close the open dialog |
| `setState` | `id`, `value` | set one local `UiState` field (feeds `when` / `${…}`) |
| `patch` | `id`, `html` | replace the inner HTML of the rendered element with that id, in place (section 9.5) |
| `setScreen` | `id`, `html` | replace the HTML of a known screen id |
| `openUrl` | `value` | open a URL in the client's browser surface |
| `undo` | — | revert the most recent lifecycle action inside its 5-second window; with no open window it is a no-op toast |

The three level-4 shapes, verbatim:

```json
{"op": "patch",     "id": "msg-7",   "html": "<p>accumulated markdown…</p>"}
{"op": "setScreen", "id": "sessions","html": "<div data-jhin-type=\"shell\" …>…</div>"}
{"op": "dialog",    "html": "<div data-jhin-type=\"sheet\" …>…</div>", "kind": "sheet"}
```

**Capability drops** (`X-Jhin-Client` capabilities, section 6): `openUrl` is
dropped without `open_url`; `setToken` and `clearToken` without
`secure_storage`; `setServerUrl` without `multi_profile`. The same rule strips
inline directives from node props at the source (the prop is removed rather
than emitted and ignored).

**One lifecycle flow deserves a note:** `sendAndNew` (the `Ctrl/Cmd+Alt+Enter`
composer command) is a **client-side composition** of three steps — dispatch
the `send` action, `POST /ui/action/create-session`, then `navigate` to the
new chat. The create-session response carries the fresh session id for the
navigation (`client` → `navigate` → `screen`: `chat:<id>`), and the draft's
`workdir` / `model` ride along in the create-session payload so the new
session keeps them. When creation answers `4xx`/`5xx` (or no `navigate`), the
client keeps the draft intact and surfaces a `toast` — user text is never
lost.

**Three action names are client-owned for keybindings** (T70):
`keybind-save`, `keybind-reset` and `keybind-restore` additionally persist
the user keymap client-side (enveloped store key `keybindings`, see
[updates.md](updates.md)) as a dispatch side effect, after validation and the
`include` merge and before the post. `keybind-save` carries the command in
the payload and the captured chord under the `include`d `keyCapture` id
(section 2.6); `keybind-reset` reverts one command and `keybind-restore`
clears every override. The server handlers only answer feedback directives
(`dismissDialog`, `toast`, `refresh`) — the chords the rows render arrive per
request in the `X-Jhin-Keybindings` header (section 8). The `keybind-edit`
action opens the rebind `sheet` (a `dialog` directive with `kind: "sheet"`
around the `keyCapture` field, section 4).

### 4.1 Keymap `when` contexts

A keymap rule's `when` is a boolean expression over the client's command
contexts (section 1). The grammar is the section 7 subset restricted to
booleans: bare context names, the literals `true` / `false`, `!`, `&&`,
`||` and parentheses. Unknown names evaluate to `false`; any parse failure
degrades the whole expression to `false` and never throws. **The last
matching rule wins** — the client walks the effective keymap from the end
and returns the first rule whose chord matches and whose `when` holds
(upstream `resolveShortcutCommand`, `apps/web/src/keybindings.ts:237-252`,
commit `37de6cb`).

| Context | Meaning |
|---------|---------|
| `terminalFocus` | the embedded terminal owns the keyboard |
| `terminalOpen` | the terminal drawer is open |
| `previewFocus` | the preview surface owns the keyboard |
| `previewOpen` | the preview surface is open |
| `modelPickerOpen` | the model picker is open |
| `usagePageOpen` | the usage page is open |
| `composerFocus` | the composer field owns the keyboard |
| `composerDraft` | the composer holds a non-empty draft |
| `turnRunning` | a run is live for the current thread |
| `editableFocus` | a text field, textarea or rich-text editor owns the keyboard |
| `isWeb` | the client runs on the web target |
| `isDesktop` | the client runs on a desktop target — the exact complement of `isWeb` |
| `sidebarFocus` | the sidebar owns the keyboard |
| `paletteOpen` | the command palette is open |
| `modalOpen` | a modal dialog is open |

`isDesktop` is derived from `isWeb` (`isDesktop == !isWeb`), matching the
upstream `resolveContext` (`apps/web/src/keybindings.ts:148-159`). A
context-free rule (no `when`) is suspended while text is being entered
(`composerFocus` / `editableFocus`); a rule with a `when` follows its
expression exactly.

### 4.2 Decorative nodes and the `demo` marker

A decorative control is an interactive node with no real effect: its `action`
is the inline directive composite of section 3 (`{client: [setState, patch,
setScreen, dialog, toast]}`), resolved entirely client-side with no server
round-trip and no database write. Every such node MUST carry the universal
`demo: true` prop (section 2.1); the client then paints the shared
disabled-affordance marker — a small corner `preview` badge plus the tooltip
`Preview only — not available in this build` — so nothing decorative looks
silently real. Real screens must never carry `demo` on a real action. The
server-side `DemoMarkerSweepTest` enforces the marking
across every decorative route (plan section 14.10).

## 5. Streams and frames

`stream_view.topic` is the SSE endpoint path to open (for `jhin.ui`,
`/ui/stream/session/{id}`, named by `streamEndpoint`; the overview topic is
`/ui/stream/sessions-overview`). The connection is reconnecting with
exponential backoff and replays from `Last-Event-ID`; every SSE event whose
data decodes to a JSON object is one **frame**. Five frame shapes, exactly
one per event:

```json
{ "node":    { "id": "msg-7", "html": "<div data-jhin-id=\"msg-7\" …>…</div>" } }
{ "patch":   { "id": "msg-7", "html": "<p>accumulated markdown…</p>" } }
{ "replace": { "id": "row-3", "html": "<div data-jhin-id=\"row-3\" …>…</div>" } }
{ "remove":  "msg-7" }
{ "client":  [ { "op": "toast", "text": "…" } ] }
```

| Frame | Effect |
|-------|--------|
| `node` | append the fragment to the stream view — or replace the whole container when the view carries `mode: replace`; a re-delivered `id` replaces that item in place. Identical semantics to level 3, with an `html` fragment instead of a tree |
| `patch` | **innerHTML swap** of `#<id>`: the element, its id and its attributes survive, only its content is replaced |
| `replace` | **outerHTML swap**: the element itself is replaced — the fallback for a change that is not expressible as inner content |
| `remove` | drop the item; the id stays tombstoned — a replay never resurrects it |
| `client` | run the directive list — e.g. `toast`, `dialog`, `navigate`, `refresh`, `undo` |

A `patch` or `replace` whose target id is absent falls back to the nearest
ancestor `[data-jhin-id]`; with no such ancestor it is dropped with a
`console.warn` (level 3's "no item → surrounding screen" rule). Focus and
selection are restored around every swap per section 9.5.

`itemLimit` drops the oldest items; dropped or removed ids are never
resurrected. With `autoScroll` the view anchors like the upstream messages
timeline (T100): a `node`, `replace` or `remove` frame (and a whole
`mode: replace`) jumps to the bottom while the view follows the end — the
user scrolling away beyond the 24 px `CHAT_TIMELINE_ANCHOR_OFFSET` tolerance
(`timelineScrollAnchoring.ts:39`, upstream commit 37de6cb) switches to
free-scrolling until the end is reached again — while a `patch` frame
**never scrolls**: it updates the rendered item in place and the position is
preserved. The list reserves the anchor offset as its end inset so the
newest row clears the composer seam. Fragments without an `id` always append.

**Session event payloads** (`jhin.sessions` event log, translated into frames
by `jhin.ui`'s `EventFrames`): each stored event carries a gap-free
per-session `seq` (the SSE de-duplication key) and one of these wire types and
payloads:

| Event type | Payload |
|------------|---------|
| `user_message` | `{"text": …}` |
| `message_start` | `{"role": "assistant"}` |
| `text_delta` | `{"text": …}` (one fragment; the full message accumulates) |
| `message_end` | `{"text": …}` (the complete message) |
| `tool_use` | `{"id": …, "name": …, "arguments": …}` — `arguments` is raw JSON text |
| `tool_result` | `{"id": …, "name": …, "content": …, "error": bool, "structured": …}` — `structured` present only when the tool produced a structured payload: a JSON object whose `type` names one of the 16 event kinds (the table below) renders that event card instead of the plain content |
| `run_start` | `{"runId": …}` |
| `run_end` | `{"runId": …}` |
| `error` | `{"message": …}` |
| `session_updated` | the updated session record — translated into a `patch` frame so sidebar rows update live |

**Event cards (T102).** Every timeline event row carries the event item type
as its `rowKey` subtype (`event:<kind>`) and dispatches through the event
builder into one of the 16 event kinds — each a recognisable card composed
from the section 2.5 primitives:

| Kind | Card |
|------|------|
| `diff` | the `diff_view` of the T93 primitive (decorative, `demo: true`) |
| `file-write` | the changed-files card: the count header with the total `+a`/`-d` stats, one row per path with its line stats and the A/M/D badge |
| `shell` | the standard tool card with the command as the summary line and the output as a `code_block` |
| `message` | inline text (no card chrome) |
| `tool-call` / `tool-result` | the standard tool card (below) |
| `approval-request` | the question card: the warning-tinted title, the mono detail, one option `chip` per option — the chips dispatch inline `setState` and carry `demo: true` |
| `limit-notice` | the warning `banner` "Usage limit reached" with the reset time and the decorative `Resume` / `Resume at reset` buttons (`demo: true`) |
| `error` | the danger-tone event card |
| `system-notice` | the muted-tone notice |
| `queued-message` | the pending card with the 3 px warning stripe painted over the left edge (a `stack` + `positioned` box) |
| `subagent` | the right-aligned subagent bar (the row carries `align: centerRight` — self-end) |
| `citation` | the inline citation pill (the filled badge on the `info` token) |
| `skill-invocation` | the inline skill pill (the filled badge on the `primary` token) |
| `work-log-entry` | the work log row: icon + label + trailing timestamp |
| `question` | the question card with one check-marked row per answer |
| anything else | the `unknown` placeholder card (never a throw) |

The **standard tool card** anatomy: the header (tool icon + name + status
chip + chevron), the collapsible argument summary line (mono, one line),
the output region (`markdown` / `code_block` / `diff_view`) and the footer
(timestamp + copy button). The status chip carries one of the five states —
`pending` → "Pending" on `warning`, `running` → "Running" on `info`,
`success` → "Done" on `success`, `error` → "Error" on `error`,
`cancelled` → "Cancelled" on `muted-foreground` (the `completed`/`failed`/
`stopped` synonyms of the upstream lifecycle statuses resolve to the same
chips). An output-less card renders the muted italic "No output." empty
state, never a blank card.

**Card expansion.** The expansion state is keyed by the row id: the header
chevron patches the body region (`ev-<seq>-body`) `visible: true` and the
footer's collapse affordance patches it back to `false` — both pure
client-side directives with no server round-trip. (The `when` degradation
rule — an unset field keeps the node visible, section 7 — cannot express a
collapsed-by-default region, so the patch/`visible` pair carries the
reveal.)

The `session_updated` patch targets the sidebar row node `session-row:<id>`:
the event payload's fields map onto the row props below (absent fields become
`null`, so cleared lifecycle state resets the row), the server re-renders the
row and the frame carries that html. A sidebar row node carries the same prop
names, so every update lands on matching keys:

| Row | Prop | Meaning |
|-----|------|---------|
| `session-row` | `title` | the thread title |
| `session-row` | `workdir` | the working directory |
| `session-row` | `status` | the free-form session status |
| `session-row` | `pinned` | the pin flag |
| `session-row` | `pinnedOrder` | the pinned position, or `null` |
| `session-row` | `settledAt` | the settle time, or `null` |
| `session-row` | `snoozedUntil` | the sleep-until time, or `null` |
| `session-row` | `archivedAt` | the archive time, or `null` |
| `session-row` | `settledReason` | the settle reason, or `null` |
| `session-row` | `sortOrder` | the manual position, or `null` |

## 6. Client capabilities and the 426 upgrade gate

The `X-Jhin-Client` header grammar is unchanged:
`api=<int>; version=<semver>; schema=<int>; caps=<comma-list>` (keys in any
order, unknown keys ignored):

- `api` — the wire contract level the client can parse. The web client sends
  `api=4`; an absent header behaves as `api=1`.
- `version` — the client's own semver.
- `schema` — the client's persisted-data schema version (`5` at level 4; an
  absent value behaves as `1`).
- `caps` — capability names, comma-separated. Known names: `sse`,
  `tls_pinning`, `secure_storage`, `open_url`, `multi_profile`; the set only
  grows.

**The 426 upgrade rule.** There is no negotiation of the wire format and no
downgrade chain: a request whose `X-Jhin-Client` declares `api < 4`, or which
carries no `X-Jhin-Client` header at all, is answered

```
HTTP/1.1 426 Upgrade Required
Content-Type: application/json

{"error":"contract_upgrade","message":"This server speaks the HTML UI contract (api=4). Upgrade your client.","minApi":4}
```

The body is JSON so an old client parses it and renders its own BootError
surface instead of garbage. The gate covers the UI-bearing routes —
`GET /_jhin/bootstrap`, `GET /ui/screen/{id}`, `POST /ui/action/{name}` and
the `GET /ui/stream/…` topics; the kernel's own `GET /_jhin/health` and the
bare-kernel bootstrap fallback are exempt, so a server can always be probed.
**There is no level-3 compatibility path and no `caps=html` negotiation
gate**: the level-3 → level-2 → level-1 downgrade tables of the previous
contract are deleted, not deprecated. [Appendix A](#appendix-a-contract-level-1)
records the level-1 shape as history only; no server emits it at level 4.

**Capabilities still tailor directives, never markup.** `Directives.filter`
drops at the source what the requesting client cannot honour (an inline
directive prop is removed rather than emitted and ignored): `openUrl`
without `open_url`; `setToken` and `clearToken` without `secure_storage`;
`setServerUrl` without `multi_profile` — and `openProfiles` with it, since
the client-owned profile surface does not exist in the web runtime. Without
`sse` a `stream_view` renders a server-side snapshot of the stream tail as a
plain list (the universal props survive the replacement, so patches
addressed at the id still land).

The web client's capability matrix:

| Capability | Advertised | Why |
|------------|-----------|-----|
| `sse` | yes | `EventSource`, with a fetch-stream fallback |
| `open_url` | yes | `window.open` |
| `secure_storage` | yes | `localStorage["jhin.token"]` — the single-user self-hosted trade-off, documented in [web-client.md](web-client.md) |
| `tls_pinning` | no | the browser owns certificate validation |
| `multi_profile` | no | the origin *is* the server |

So the web client sends
`X-Jhin-Client: api=4; version=<app version>; schema=5; caps=sse,open_url,secure_storage`.

**The schema gate is independent of the upgrade gate.** A client that speaks
`api=4` but whose stored schema is below `contract.minSchema` still receives
a normal payload, with `entry` naming the `version_gate` surface, so a stale
store shows the "update required" chrome instead of product screens and
never crashes.

## 7. Expression subset

Two client-side expression surfaces over the local `UiState` (fields seeded
from `input`/`checkbox`/`switch`/`slider`/`dropdown` values and written by
`setState`): the `when` prop and `${…}` interpolation in string props.

Grammar: **field references** (bare identifiers), `!`, `==`, `!=`, `>`, `>=`,
`<`, `<=`, `&&`, `||`, parentheses, and string/number/bool literals. Nothing
else — no arithmetic, no functions, no method calls. Comparisons require both
sides to be numbers or both strings; `&&`/`||` require bools.

**Silent degradation is mandatory** — unknown constructs must never break an
older client:

- `when` — any parse or evaluation failure keeps the node **visible** (only an
  explicit `false` hides).
- `${…}` — a fragment whose expression fails is left in the output **literal**
  (the `${…}` text is shown); the rest of the template still interpolates.

## 8. Caching and payload versioning

The web runtime persists per origin (`localStorage`, see
[updates.md](updates.md)):

- `jhin.bootstrap` — the last successful bootstrap payload. Used to paint
  immediately when the server is unreachable; the server's `fallbacks` HTML
  travels with it and serves the offline and error surfaces.
- `jhin.screens` — screen id → HTML string, an LRU bounded at **50** entries.
  A cached screen renders immediately and **revalidates in the background**
  (stale-while-revalidate); inline screens (those travelling with the
  bootstrap) are never fetched, only `refresh` re-fetches them.
- `jhin.token` — the bearer token (the `secure_storage` capability).
- `jhin.keybindings` — the user keymap overrides.

`refresh` and `reloadBootstrap` force network. `reloadBootstrap` drops the
screen cache, the `setScreen` overrides and the cached bootstrap first, then
re-runs `GET /_jhin/bootstrap` and persists the fresh payload. The runtime
assets themselves revalidate by `ETag` against `GET /ui/assets/{name}`.

**Payload versioning.** Cached payloads carry the `api` and the contract
`schema` they were produced at. On an app, `api` or `schema` change the
client drops the screen cache and revalidates the bootstrap — a level-3 tree
cached by an older build must never be replayed into the level-4 DOM runtime,
and a payload cached under schema 4 must never seed a schema-5 store. This is
the cache half of the data-upgrade system; the persisted-state half is
specified in [updates.md](updates.md).

**Request enrichment: `X-Jhin-Keybindings`.** Every JSON request (screen
fetch and action post) carries the caller's current user keymap overrides so
the server can render the chords the client actually uses: the Settings →
Keyboard rows show the effective chord per command (the override wins per
command; commands without one keep their server default) and the `keybind-edit`
sheet prefills the capture field with the current chord. The header value is
the store shape `{"rules": [{"command": …, "keys": …}]}`; an absent or
malformed header means no overrides and the server renders its defaults. The
client sends it from the live store, so a `refresh` after a rebind renders the
fresh chords without a restart.

## 9. HTML rendering rules

`HtmlRenderer.render(UiNode) → String` and
`HtmlRenderer.renderFragment(UiNode) → String` (no `<html>` wrapper) are pure
functions: no per-request server state, no session affinity. Props nested
inside props (`fields`, `items`, `rows`, `spans`, `hunks`, `series`, …)
render through the same recursive pipeline, mirroring `UiNode.toJson()`'s
`wireValue()`. `UniversalProps` applies the universal surface in the
section 2.3 order; the per-family renderers own the element choice below.

### 9.1 Semantic element mapping

**Semantic HTML first** — primitives map to real elements, so the
accessibility tree comes free and an agent can read the UI structurally:

| Primitive | Element | Primitive | Element |
|---|---|---|---|
| `text` | `<span>`, or `<p>` when `style` is block-ish (h1–h3/body) | `button` / `icon_button` | `<button type="button">` |
| `markdown` | server-rendered `<p>`/`<h1>`–`<h3>`/`<ul>`/`<pre>`/`<table>` … | `input` / `textarea` | `<input>` / `<textarea>` |
| `code_block` | `<pre><code class="language-x">` | `checkbox` | `<input type="checkbox">` + `<label>` |
| `list_row` | `<div role="listitem">`, or `<button>` when it carries an action | `switch` (wire type `switch`) | `<input type="checkbox" role="switch">` |
| `nav` | `<nav>` + `<button aria-current>` items | `slider` | `<input type="range">` |
| `tabs` | `<div role="tablist">` + `role="tab"` children | `dropdown` | `<select>` + `<option>` |
| `table` | `<table>` / `<thead>` / `<tbody>` | `progress` | `<progress>`, or `<div role="progressbar">` |
| `tree` | `<ul role="tree">` + `role="treeitem"` | `badge` / `chip` | `<span class="jhin-badge">` (+ `role="status"` when colored) |
| `icon` | `<svg data-jhin-icon="name">` (the inline-SVG registry, section 9.6) | `divider` | `<hr>` |
| `card` / `sheet` / `dialog` / `banner` / `drawer` | `<section>` / `<dialog>` / `<aside>` | `avatar` | `<span class="jhin-avatar">` / `<img>` |
| `stream_view` | `<div role="log" aria-live="polite">` | `image` | `<img>` |
| `shell` / `container` / `row` / `column` / `flex` / `box` / `stack` / `wrap` / `grid` / `scroll` / `list` | `<div>` with the `display: flex` / `display: grid` classes | `kbd` | `<kbd>` |
| `diff_view` | `<div class="jhin-diff">` with `<ins>` / `<del>` lines | everything else | `<div>` |

### 9.2 Attribute protocol (the agent-visible contract)

Every rendered node carries:

| Attribute | When | Value |
|-----------|------|-------|
| `data-jhin-type` | always | the primitive name, e.g. `data-jhin-type="button"` |
| `data-jhin-id` | the node has an `id` prop | the server-authored id |
| `data-jhin-when` | the node has a `when` prop | the raw expression source |
| `data-jhin-template` | a string prop carries a `${…}` template | the raw template |
| `data-jhin-action` | the node carries an action | the action JSON, in a **single-quoted** attribute with the JSON escaped |
| `data-jhin-confirm` | the action carries a `confirm` | the confirmation message |
| `data-jhin-icon` | on the `<svg>` of an `icon` | the icon name |

The HTML `id` attribute is set **only** on nodes that opt in through the `id`
prop, so server ids never collide with shell ids — the runtime's own
elements use the `jhin-` prefix (`#jhin-root`, `#jhin-toasts`, …). Interactive
nodes additionally get `aria-label` from `semanticsLabel`, `title` from
`tooltip` and `aria-disabled` from `enabled: false`.

Because the contract is attribute-shaped, `document.querySelector(
'[data-jhin-type="button"]')` works, and a visible box maps straight back to
the Java call-site that produced it: grep the renderers
(`plugins/ui-kit/src/main/java/com/astroreen/jhin/plugin/uikit/html/renderers/`)
for the type and the screen builders
(`plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/screens/`)
for the id.

### 9.3 Escaping policy

`HtmlEsc` is the **only** escaping authority:

- Every text prop — `text`, `label`, `title`, `subtitle`, `placeholder`,
  `message`, code bodies, the markdown source before parsing, and every prop
  interpolated into `style`, `class` or any attribute — is escaped by
  `HtmlEsc`: `&`, `<`, `>`, `"` and `'` become entities.
- Attribute values are **always** double-quoted and escaped; the one
  single-quoted attribute (`data-jhin-action`) carries JSON whose `'` is
  escaped by the same authority.
- `commonmark` runs with **raw HTML blocks and inline HTML disabled**, so LLM
  output, file contents and tool output can never inject markup through
  `markdown`.
- The single unescaped path is `Ui.raw(String html)` → a `raw` node whose
  renderer emits the string verbatim. It is a documented escape hatch for
  **trusted server-authored chrome only**; `RawEscapeSweepTest` fails when a
  product screen under `plugins/ui-default/.../screens/` uses it. See
  [web-client.md](web-client.md).

### 9.4 Token → CSS

`TokenCss.root(theme, tokens, density) → String` emits two `:root` layers,
exactly mirroring `JhinTokenSurface`:

1. **palette layer** — `--accent`, `--background`, `--card`, … generated
   server-side by `PaletteGen`/`Oklch` from `{appearance, canvas, accent}`
   plus the `theme.colors` overrides, with the `--contrast-*` indirection
   variables carrying the user contrast boost;
2. **alias layer** — `--color-accent: var(--accent)`,
   `--radius-base: 0.625rem`, `--text-sm-size: 0.875rem`, `--font-sans: …`,
   `--motion-ease-drawer: cubic-bezier(…)`,
   `--space-workspace-gutter-base` / `--space-workspace-gutter-sm`, and the
   `{light, dark}` families (`glass.blur`, `shadow.composer`) emitted under
   `@media (prefers-color-scheme: light)` / `(prefers-color-scheme: dark)`
   plus a `[data-appearance]` override attribute on `<html>` so an explicit
   theme choice beats the OS preference.

A `$family.key` wire reference becomes `var(--<family>-<key>)` (dots become
hyphens). Unknown keys are already rejected at build time by `UiTokens`.

**Density** is an attribute, not a recomputation: `[data-density="compact"]`,
`[data-density="comfortable"]` and `[data-density="spacious"]` on `<html>`
scale the spacing family through `calc()` at 0.75, 1.0 and 1.25. The client
performs no token math: `parseCssLength` and `parseCssDuration` do not exist
in the runtime.

### 9.5 Patch application and focus

Patches are surgical — a fragment swap, never a screen reload and never a
prop merge:

- **`patch` (innerHTML).** If `document.activeElement` lives inside the
  target, record its `data-jhin-id` (or a stable selector) and its
  `selectionStart`/`selectionEnd`, swap the content, then restore focus and
  the selection when an element with the same `data-jhin-id` exists in the
  new content.
- **`replace` (outerHTML).** The same rule, applied one level up.
- **Missing target.** A patch whose target id is absent targets the nearest
  ancestor `[data-jhin-id]`; with no such ancestor it is dropped with a
  `console.warn`.
- **Scrolling.** `node`, `replace` and `remove` honour the T100 anchoring;
  `patch` never scrolls (section 5).

This is what keeps `text_delta` at token frequency cheap: the server
re-renders one markdown block and the runtime swaps that block's content,
leaving the composer's focus and selection intact.

### 9.6 Icons

Icons are a **generated inline-SVG subset**:
`plugins/ui-kit/src/main/resources/uikit/icons/<name>.svg`, one file per icon
name actually referenced by `Ui.icon(...).icon("name")` across the
repository. The `IconSweep` test enumerates the usages and fails when a
referenced name has no SVG file. A missing name renders an empty `<svg>` and
logs to the console — never a crash (section 2.4). Authoring a new icon is
dropping an SVG file into that directory; no client release is involved.

## 10. What stays unchanged

Level 4 is a serialization change. These surfaces are **identical** to level
3 and must not be rewritten:

- the action protocol of section 3, including the client-side dispatch order
  and the include-merge typing rules;
- the seventeen directive **names** and every non-HTML payload (section 4);
- the capability header grammar (`X-Jhin-Client`, section 6);
- the expression grammar and its degradation rules (section 7);
- the keymap semantics and the `when` contexts of section 4.1, including
  last-match-wins and the `mod` platform mapping;
- the theme and token **vocabulary** (the eleven `UiTokens` families, the
  `theme` seed block, `density`);
- the stream replay, de-duplication and preamble logic, `Last-Event-ID`, and
  the T100 auto-scroll anchoring;
- the `X-Jhin-Keybindings` request-enrichment header (section 8);
- the `session_updated` → sidebar-row prop mapping (section 5);
- the sixteen event-card kinds and the standard tool-card anatomy
  (section 5);
- the `Ui` fluent builder API for plugins — only serialization changed, so
  every existing plugin screen compiles untouched (the one additive API is
  `Ui.raw`, section 9.3).

## Appendix A. Contract level 1

**History only.** Level 1 is not a supported wire at level 4: a client that
declares it receives the `426` of section 6. The shape is recorded here
because the kernel's bare-server bootstrap fallback still reports `api: 1`,
and because the store-migration chain in [updates.md](updates.md) refers to
it.


An `api=1` client (or a server negotiating down to level 1) still receives
and emits this shape:

```json
{
  "api": 1,
  "empty": false,
  "title": "Jhin",
  "theme": {"seedColor": "#7E57C2", "mode": "system"},
  "entry": "sessions",
  "screens": [{"id": "sessions", "node": {"type": "screen", "props": {}, "children": []}}],
  "screenEndpoint": "/ui/screen/{id}",
  "fallbacks": {"offline": {"type": "card", "props": {}, "children": []},
                "error": {"type": "card", "props": {}, "children": []}}
}
```

Level-1 specifics:

- `theme` carries only `seedColor` (`#RRGGBB` seed) and `mode` (`system` in
  this build); no `appearance`/`canvas`/`accent`/`colors`.
- No `contract`, `tokens`, `density` or `keymap` fields.
- The primitive catalog is the fixed 25: `screen`, `nav`, `container`, `card`,
  `text`, `markdown`, `button`, `input`, `dropdown`, `checkbox`, `switch`,
  `slider`, `form`, `list`, `table`, `stream_view`, `divider`, `spacer`,
  `progress`, `image`, `figure`, `chart_line`, `chart_bar`, `chart_pie`,
  `drawer`.
- Universal props are limited to `id`, `visible`, `padding`, `flex` and
  `when`; no token references, no decoration, no interaction or semantics
  groups.
- The `X-Jhin-Client` header is `api=<int>; version=<semver>; caps=<list>`
  (no `schema` field).
- Directives are the sixteen of section 4 minus `undo`.
- The header format is `api=1; version=x.y.z; caps=a,b,c`.

