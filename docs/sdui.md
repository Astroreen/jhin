# Jhin SDUI contract (level 3)

The Flutter client is a server-driven-UI renderer: the server authors screens
as JSON trees over a primitive catalog and the client renders them. The client
hardcodes exactly one screen — the server-profile surface (add-server and
profile switching) — and one endpoint, the bootstrap fetch
(`GET /_jhin/bootstrap`); everything else comes from the server. An unknown
primitive renders a placeholder card and the client never crashes on server
content.

This document is the **normative wire contract, level 3** (`api: 3`). It
defines what a level-3 client parses and what a level-3 server emits; the
shape an `api=1` client still receives is summarized in
[Appendix A](#appendix-a-contract-level-1), and section 6 defines the
level-3 → level-2 → level-1 downgrade chains for older clients. Server
side: `plugins/ui-kit/` (the `Ui` builder over the catalog) and
`plugins/ui-default/` (bootstrap, screens, actions, streams). Client side:
`frontend/lib/sdui/`. See
[architecture.md](architecture.md) for the runtime and
[plugin-dev.md](plugin-dev.md) for writing plugins.

**Conformance format.** Every prop key in this document is machine-parseable:
prop keys always appear backticked, one key per table row, in the second
column of a table whose header row contains `Prop`. The ui-kit builder
conformance test asserts that every key the builders can emit is documented
here, so the doc and the code cannot drift apart.

## 1. Bootstrap payload

`GET /_jhin/bootstrap` returns the whole client start-up payload. The client
advertises itself in every request with the `X-Jhin-Client` header
(section 6); the server replies at `min(client api, server api)` and never
emits fields the negotiated level does not define. Two producers exist:

**Kernel fallback** (a bare kernel without a UI plugin; `KernelRoutes`) —
unchanged from level 1:

```json
{
  "api": 1,
  "empty": true,
  "kernel": "0.2.0",
  "plugins": [],
  "message": "This server has no UI plugin installed."
}
```

**`jhin.ui` payload, contract level 3** (a plugin route on the same path
supersedes the fallback silently; `BootstrapRoute`):

```json
{
  "api": 3,
  "empty": false,
  "title": "Jhin",
  "contract": { "api": 3, "minApi": 2, "schema": 4, "minSchema": 3 },
  "theme": {
    "appearance": "system",
    "canvas": "#16161e",
    "accent": "#7e57c2",
    "colors": { "error": "#f7768e", "success": "#9ece6a", "warning": "#e0af68", "info": "#7aa2f7" },
    "mode": "system"
  },
  "tokens": {
    "spacing": { "xs": 4, "sm": 8, "md": 12, "lg": 16, "xl": 24, "xxl": 32 },
    "radius": { "sm": 6, "md": 10, "lg": 14, "full": 9999 },
    "typography": {
      "h1":   { "size": 28, "height": 1.25, "weight": 700 },
      "h2":   { "size": 22, "height": 1.30, "weight": 700 },
      "h3":   { "size": 18, "height": 1.35, "weight": 600 },
      "body": { "size": 14, "height": 1.50, "weight": 400 },
      "small":{ "size": 12, "height": 1.45, "weight": 400 },
      "mono": { "size": 13, "height": 1.55, "weight": 400, "font": "monospace" }
    },
    "elevation": { "none": 0, "sm": 1, "md": 4, "lg": 8 },
    "motion": { "instant": 0, "fast": 120, "normal": 200, "slow": 320, "panel": 0 }
  },
  "density": "comfortable",
  "keymap": [ { "key": "mod+enter", "command": "composer.send", "when": "composerFocus" } ],
  "entry": "sessions",
  "screens": [ { "id": "sessions", "node": { "type": "shell", "props": {}, "children": [] } } ],
  "screenEndpoint": "/ui/screen/{id}",
  "fallbacks": { "offline": {}, "error": {} }
}
```

Top-level fields:

| Field | Type | Description |
|-------|------|-------------|
| `api` | int | contract level the payload was produced at (`3`) |
| `empty` | bool | `true` tells the client to render its built-in empty state ("no UI plugin installed") instead of a screen stack |
| `title` | string | product chrome title |
| `contract` | object | version negotiation block, see below |
| `theme` | object | theme seed block, see below |
| `tokens` | object | design-token overrides, see below |
| `density` | string | control density: `compact`, `comfortable` or `spacious`; scales padding and height of controls |
| `keymap` | array | default key bindings, `[{key, command, when?}]`, see below |
| `entry` | string | the screen id pushed first |
| `screens` | array | inline screens `[{id, node}]`, in registration order; cached, never lazily fetched, only `refresh` re-fetches them |
| `screenEndpoint` | string | path template for on-demand screens; the client substitutes `{id}` (URL-encoded) and expects `{node: …}` or a bare node |
| `fallbacks` | object | server-authored offline and error art (`offline`, `error`), cached by the client on first success |

`contract` keys:

| Key | Meaning |
|-----|---------|
| `api` | the server's wire contract level (`3`) |
| `minApi` | the lowest wire level the server still speaks |
| `schema` | the client persisted-data schema version the server was built for (`4`, see [updates.md](updates.md)) |
| `minSchema` | the lowest persisted-data schema the server accepts; a client whose on-disk schema is lower MUST refuse to render product screens and show the built-in `version_gate` "update required" surface |

`theme` keys:

| Key | Type | Description |
|-----|------|-------------|
| `appearance` | `system`/`light`/`dark` | theme mode |
| `canvas` | `#RRGGBB` or `#AARRGGBB` | background seed color |
| `accent` | `#RRGGBB` or `#AARRGGBB` | accent seed color |
| `colors` | object | optional override map keyed by token names (`error`, `success`, `warning`, `info`, `surface`, `outline`, `onCanvas`, `onAccent`, `accentHover`, `accentMuted`, …); overrides win over generation |
| `mode` | `system`/`light`/`dark` | legacy level-1 spelling of the same idea; MUST equal `appearance` |

From `{appearance, canvas, accent}` the client **generates** the full material
palette (T3-style short theme format): `ColorScheme.fromSeed(seed: accent)`
with the surface/background family derived from `canvas` and on-colors from
luminance. `colors` overrides are applied last, by token name.

`tokens` overrides the client's built-in defaults key-by-key; any absent key
keeps the built-in. All numbers are logical px; `typography.*.weight` is
100–900.

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
| `ctrl+alt+enter` | `composer.sendAndNew` | `composerFocus` |
| `shift+enter` | `composer.newline` | `composerFocus` |
| `mod+up` | `composer.recallPrev` | `composerFocus` |
| `mod+down` | `composer.recallNext` | `composerFocus` |
| `ctrl+k` | `palette.open` | — |
| `ctrl+z` | `thread.undo` | — |
| `alt+left` | `nav.back` | — |
| `alt+right` | `nav.forward` | — |
| `mod+n` | `thread.new` | — |

The `theme`/`density`/`tokens.motion.panel` seed values are not fixed
constants: the `jhin.ui` plugin persists them server-side (its `settings.json`
over the `jhin.ui` config section, keys `appearance`, `canvas`, `accent`,
`density`, `panelMotionMs`) and the settings screen's `save-appearance` action
writes them, so the next bootstrap carries the saved values. The same store
holds the thread-behavior proxy keys `autoSettleDefault` and `inactivityDays`
(`save-thread-behavior`); they are `jhin.ui`-owned preferences — the
auto-settle sweep threshold itself stays the `jhin.sessions.inactivityMs`
operator config.

Node shape everywhere (section 2):

```json
{"type": "text", "props": {"text": "Hello", "style": "h2"}, "children": []}
```

`children` is optional; a string child is a text shorthand.

## 2. Node model

A node is `{"type": "<primitive>", "props": {…}, "children": […]}`. Every node
accepts the universal prop surface below, implemented once in the client
registry before the primitive builder runs, plus the per-primitive props of
section 2.6.

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

The level-3 universal surface (contract level 3, section 2.5). A level-2
client never receives `glass` or `statusPulse` — the server strips them at
the source (section 6) — while `demo` and the `safeArea` group are inert
markers a level-2 client ignores:

| Group | Prop | Type | Default | Meaning |
|-------|------|------|---------|---------|
| Level 3 | `glass` | bool | `false` | render the node's surface with the glass treatment: a backdrop blur at the token blur radius, a tinted fill at the token opacity and the token saturation (`tokens.glass`). Only the five glass-capable surfaces honour it — `card`, `sheet`, `dialog`, `menu`, `banner` — other nodes ignore it. Without backdrop support (or below level 3, where it is stripped) the surface degrades to a solid fill at the tint colour |
| Level 3 | `demo` | bool | `false` | the node is decorative: interactive but non-functional — it dispatches inline directives only (`setState`/`patch`/`dialog`/`toast`, never a server-side write) and the client renders the shared disabled-affordance marker for it. Every interactive node without a real effect MUST carry it |
| Level 3 | `statusPulse` | `pulse`/`ping`/`skeleton`/`none` | `none` | duty-cycled attention indicator on indicator-bearing nodes (`progress`): `pulse` runs the 2 s status pulse, `ping` the 2 s ping ring, `skeleton` the 2.4 s shimmer (the `tokens.motion` duty cycles). Other nodes ignore it; the OS reduced-motion preference collapses every mode to a static render |
| Safe area | `safeArea` | bool or object | — | extends the node's padding by the platform safe-area insets (`MediaQuery.padding`): `true` covers all four edges, or `{top, bottom, left, right}` bools select per-edge. Edges the platform reports as zero add nothing |

### 2.2 Token references

Any string prop whose value starts with `$` is a client-side token lookup:
`$spacing.md`, `$color.accent`, `$radius.lg`, `$motion.fast`, `$size.sidebar`,
`$font.mono`. Resolution happens **client-side only** — the server never
expands `$tokens`, which keeps tokens themeable per client. Token namespaces
mirror the bootstrap `tokens` block plus `color` (theme palette), `size`
(layout constants such as `$size.sidebar`) and `font`. An unknown or failed
lookup degrades silently: the literal string is used and the node still
renders, exactly like the `when`/`${…}` degrade rule (section 7).

### 2.3 Fixed wrapping order

The universal surface wraps the primitive in a deterministic order (tested):

1. build the primitive;
2. apply the text style (text-bearing nodes);
3. `DecoratedBox` (`color`/`gradient`/`border`/`borderRadius`/`shadow`);
4. `Padding` (`padding`);
5. `ConstrainedBox` (`minWidth`/`maxWidth`/`minHeight`/`maxHeight`/`width`/`height`);
6. `AspectRatio` (`aspectRatio`);
7. `Opacity` (`opacity`);
8. `Transform` (`transform`);
9. `ClipRRect`/`ClipOval`/`ClipRect` (`clip`);
10. `Align` (`align`);
11. `Tooltip` (`tooltip`);
12. gesture wrapper — `InkWell` when `action`/`onTap` on a Material surface,
    `GestureDetector` otherwise (`onLongPress`, `confirm`, `enabled`, `cursor`);
13. `Semantics` (`semanticsLabel`/`semanticsHint`/`semanticsValue`/`excludeSemantics`);
14. `Flexible`/`Expanded` (`flex`/`fit`);
15. `Padding` (`margin`).

The interaction cluster (steps 11–13) carries two fixed extra wrappers: `MouseRegion` (`cursor`) is the outermost wrapper of the cluster and `Focus` (`focusable`) sits between the gesture wrapper and `Semantics`; the gesture wrapper is skipped for primitives that already own their interaction (`button`, `icon_button`, `dropdown`), so no node ever carries two dispatch handlers.

### 2.4 Degradation rules

- An unknown `type` renders a muted `Unsupported UI element: <type>` card.
- A malformed prop degrades that node only, never the screen.
- An unknown token reference degrades to the literal string.
- An unknown enum literal degrades to the prop's default.
- An unknown icon name renders an empty icon and logs — never a crash.
- The client never crashes on server content.

### 2.5 Primitive catalog

Contract level 2 grew the catalog from 25 to 58 primitives; contract level 3
grows it to 68. `container` stays as the legacy name; `box` is its superset.

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
Every primitive accepts the full universal surface of section 2.1 in addition
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
| `shell` | `breakpoint` | num | 900 | width below which the sidebar becomes a drawer |
| `shell` | `sidebarWidth` | num or token | 280 | expanded sidebar width |
| `shell` | `sidebarCollapsedWidth` | num | 56 | collapsed sidebar width |
| `shell` | `collapsible` | bool | `false` | the sidebar can collapse |
| `shell` | `collapsed` | bool | `false` | current collapsed state; patchable via the node `id` |
| `container` | `children` | node array | — | child nodes |
| `container` | `direction` | `row`/`column` | `column` | layout direction |
| `container` | `gap` | num | 0 | space between children |
| `container` | `align` | alignment | — | child alignment |
| `container` | `scroll` | bool | `false` | scrollable container |
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
| `list_row` | `leading` | node | — | leading widget |
| `list_row` | `title` | node or string | — | title |
| `list_row` | `subtitle` | node or string | — | subtitle |
| `list_row` | `trailing` | node | — | trailing widget |
| `list_row` | `badge` | node | — | badge widget |
| `list_row` | `action` | action | — | tap action |
| `list_row` | `selected` | bool | `false` | selected tint |
| `list_row` | `onLongPress` | action | — | long-press action |
| `list_row` | `dragHandle` | bool | `false` | visual drag affordance (reorder itself goes through actions) |
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

Level-3 degradation targets (applied by the server for a level-2 client,
section 6): `split` degrades to a `column` — the two panes stack in order,
the divider, the clamps and the persistence are lost.

Text primitives:

| Primitive | Prop | Type | Default | Description |
|-----------|------|------|---------|-------------|
| `text` | `text` | string | — | content (required) |
| `text` | `style` | `h1`/`h2`/`h3`/`body`/`small`/`caption`/`mono` | `body` | typography token |
| `text` | `bold` | bool | `false` | bold |
| `text` | `italic` | bool | `false` | italic |
| `text` | `color` | color | — | text color |
| `text` | `strutStyle` | object | — | `{size?, height?, leading?}` |
| `text` | `textWidthBasis` | `parent`/`longestLine`/`character` | `parent` | width basis (`character` has no Flutter counterpart and degrades to `parent`) |
| `text` | `locale` | string | — | BCP-47 tag |
| `text` | `selectionColor` | color | — | selection color |
| `rich_text` | `spans` | span array | — | inline spans, see the span table below |
| `markdown` | `text` | string | — | markdown source (required) |
| `markdown` | `codeBlockStyle` | string | — | code-fence style name |
| `markdown` | `syntax` | bool | `false` | syntax highlighting in fences |
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
| paragraph with inline markup | `rich_text` (spans: link → `action: {op: openUrl, value: href}`, `strong` → `fontWeight: 700`, `em` → `fontStyle: italic`, inline code → `fontFamily: $font.mono`) |
| heading `#`…`###` | `text` (`style: h1`…`h3`) |
| heading `####`…`######` | `text` (`style: h3`) |
| fenced / indented code | `code_block` (`code`, `language` from the info string) |
| bullet / ordered list | `list` (`items`; ordered items carry their `1.` prefix; nested lists nest inside a `container` item) |
| blockquote | `card` (`children` = the mapped inner blocks) |
| table | `table` (`columns`, `rows`) |
| thematic break | `divider` |
| image | `image` (`src`, `semanticsLabel` from the alt text; splits out of its paragraph) |

Markdown degrades (§2.4 — the client never crashes on server content):

- an unbalanced (unclosed) fenced code block degrades the whole `markdown`
  node to a single plain `text` carrying the raw source;
- unsupported or malformed blocks — HTML blocks, footnote definitions and
  references, definition lists, unknown elements — degrade to plain `text`
  (their text content; an HTML block keeps its raw source);
- unknown inline elements flatten to their plain text;
- `syntax: true` is accepted but syntax highlighting is not implemented in
  this MVP — fences render as a plain `code_block`;
- `codeBlockStyle` is accepted; the contract defines no literal set yet, so
  every value renders the default `code_block` look.

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
| `kbd` | `chord` | string | — | the chord to render as key pills (required); modifiers join with `+` and `mod` resolves per platform (Cmd on macOS, Ctrl elsewhere); unknown chord tokens render literally and log, never throw |
| `scroll_fade` | `child` | node | — | the scrollable the fade wraps (required) |
| `scroll_fade` | `edge` | `top`/`bottom`/`start`/`end` | `top` | scrolled edge the gradient paints at |
| `scroll_fade` | `height` | num or token | 24 | fade extent (px) |
| `scroll_fade` | `mode` | `topbar`/`virtualized` | `topbar` | fade recipe (`topbar` for chrome bars, `virtualized` for lazy lists) |

Level-3 degradation targets: `kbd` degrades to a `text` carrying the chord
string (mono style); `scroll_fade` degrades to a `scroll` wrapping the same
child — the fade gradient is dropped.

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

Level-3 degradation targets: `hover_card` degrades to its `trigger` node with
the universal props (including `tooltip`) merged onto it — the card content is
dropped; `toast_stack` degrades to a `column` of plain `text` nodes, one per
item — the `toast` directive remains the level-2 channel for transient
notices.

Data primitives:

| Primitive | Prop | Type | Default | Description |
|-----------|------|------|---------|-------------|
| `stream_view` | `id` | string | — | stream id (required) |
| `stream_view` | `topic` | string | — | SSE endpoint path (required) |
| `stream_view` | `mode` | `append`/`replace` | `append` | frame application mode |
| `stream_view` | `itemLimit` | int | — | oldest items are dropped |
| `stream_view` | `autoScroll` | bool | `false` | follow new items |
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

Level-3 degradation target: `diff_view` degrades to a `code_block` carrying
the file name and the hunk headers as the code text.

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
| `tabs` item | `label` | string | yes | visible label |
| `tabs` item | `icon` | icon name | no | icon |
| `tabs` item | `badge` | node | no | badge widget |
| `tabs` item | `panel` | node | no | tab panel node |
| `table` column | `label` | string | yes | header label |
| `table` column | `width` | num | no | column width |
| `table` column | `sortable` | bool | no | sortable header |
| `table` column | `align` | text align | no | cell alignment |
| `tree` item | `label` | string | yes | visible label |
| `tree` item | `icon` | icon name | no | icon |
| `tree` item | `expanded` | bool | no | initial expansion |
| `tree` item | `action` | action | no | select action |
| `tree` item | `items` | item array | no | nested children |
| `rich_text` span | `text` | string | yes | span text |
| `rich_text` span | `style` | text style | no | span style |
| `rich_text` span | `action` | action | no | tappable span; an unknown action drops the action and keeps the text |
| `rich_text` span | `tooltip` | string | no | span tooltip |
| `list` section | `label` | string | yes | section label (empty sections still show it) |
| `list` section | `id` | string | no | section id |
| `list` section | `collapsible` | bool | no | can collapse |
| `list` section | `collapsed` | bool | no | initial collapsed state |
| `list` section | `items` | node array | yes | section entries |
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

## 4. Client directives

Seventeen directives (`Directives` on the server, `DirectiveExecutor` on the
client). Wire form is the `op` discriminator plus the listed fields. They
appear in action responses, in `{client: […]}` stream frames and inline in
node props (a button action may be one directive).

| Directive | Args | Effect |
|-----------|------|--------|
| `navigate` | `screen` | push a screen onto the navigation stack |
| `back` | — | pop the navigation stack |
| `replace` | `screen` | replace the current screen |
| `refresh` | — | re-fetch the current screen (forces network) |
| `reloadBootstrap` | — | drop the client caches and re-run bootstrap |
| `setToken` | `value` | store the bearer token for this profile (`""` clears) |
| `clearToken` | — | drop the stored bearer token |
| `setServerUrl` | `value` | rewrite the active profile URL and reboot against it |
| `openProfiles` | — | open the client-owned server profile surface |
| `toast` | `text`, `style?` | show a transient message (`style: "error"` for failures) |
| `dialog` | `node` | open a dialog rendering the given node (`kind: "sheet"` opens a bottom sheet) |
| `dismissDialog` | — | close the open dialog |
| `setState` | `id`, `value` | set one local `UiState` field (feeds `when` / `${…}`) |
| `patch` | `id`, `props` | merge props into one rendered node in place |
| `setScreen` | `id`, `node` | replace the node of a known screen id |
| `openUrl` | `value` | open a URL in the client's browser surface |
| `undo` | — | revert the most recent lifecycle action inside its 5-second window; with no open window it is a no-op toast |

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

## 5. Streams and frames

`stream_view.topic` is the SSE endpoint path to open (for `jhin.ui`,
`/ui/stream/session/{id}`). The connection is reconnecting with exponential
backoff and replays from `Last-Event-ID`; every SSE event whose data decodes
to a JSON object is one **frame**. Four frame shapes, exactly one per event:

| Frame | Shape | Effect |
|-------|-------|--------|
| node | `{"node": {…node}}` | append (or replace everything with `mode: replace`); a re-delivered `id` replaces the item in place |
| patch | `{"patch": {"id": "…", "props": {…}}}` | merge `props` into the stream item with that `id`; with no such item the patch targets the surrounding screen |
| remove | `{"remove": "<id>"}` | drop the item; the id stays tombstoned — a replay never resurrects it |
| client | `{"client": [ …directives ]}` | run the directive list — e.g. `toast`, `dialog`, `navigate`, `refresh`, `undo` |

`itemLimit` drops the oldest items; dropped or removed ids are never
resurrected. Nodes without an `id` always append.

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
| `tool_result` | `{"id": …, "name": …, "content": …, "error": bool, "structured": …}` — `structured` present only when the tool produced a structured payload (a UI card renders it instead of the plain content) |
| `run_start` | `{"runId": …}` |
| `run_end` | `{"runId": …}` |
| `error` | `{"message": …}` |
| `session_updated` | the updated session record — translated into a `patch` frame so sidebar rows update live |

The `session_updated` patch targets the sidebar row node `session-row:<id>`
and carries the row props below (absent fields become `null`, so cleared
lifecycle state resets the row). A sidebar row node carries the same prop
names, so every patch lands on matching keys:

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

## 6. Client capabilities and schema negotiation

The `X-Jhin-Client` header is
`api=<int>; version=<semver>; schema=<int>; caps=<comma-list>` (keys in any
order, unknown keys ignored, all fields optional):

- `api` — the wire contract level the client can parse (this repository's
  client speaks `api=3`; an absent header behaves as `api=1`).
- `version` — the client's own semver.
- `schema` — the client's persisted-data schema version (starts at 4, the
  store chain v1→v4; an absent value behaves as `1`).
- `caps` — capability names, comma-separated. Known names: `sse`,
  `tls_pinning`, `secure_storage`, `open_url`, `multi_profile`; the set only
  grows.

The server replies at `min(client api, server api)` and never emits fields the
negotiated level does not define. It must treat an absent capability as
unsupported and degrade at the source (`CapabilityTailor`). The negotiation
is independent of the schema gate: a client whose `schema` is below
`contract.minSchema` still receives a normal (tailored) payload whose `entry`
names the client-owned `version_gate` surface, so a stale client shows the
"update required" chrome instead of product screens and never crashes.

**Level-3 → level-2 downgrade table** (applied when the negotiated api is 2 —
the level-3 primitives and universal props are exactly the ones a level-2
client cannot parse):

| Level-3 primitive or prop | Degrades to |
|---------------------------|-------------|
| `split` | `column` (the two panes stack in order; divider, clamps and persistence are lost) |
| `hover_card` | replaced by its `trigger` node with the universal props (including `tooltip`) merged onto it; the card content is dropped |
| `toast_stack` | a `column` of plain `text` nodes, one per item; the `toast` directive remains the level-2 channel for the same transient notices |
| `kbd` | `text` carrying the chord string (mono style) |
| `scroll_fade` | `scroll` wrapping the same child (the fade gradient is dropped) |
| `diff_view` | `code_block` carrying the file name and the hunk headers as the code text |
| universal `glass` | stripped — surfaces render solid |
| universal `statusPulse` | stripped — indicators render static |
| universal `demo` | kept — an inert marker for a level-2 client |
| `safeArea` group | kept — an inert marker for a level-2 client |

**Level-2 → level-1 primitive downgrade table** (applied when the negotiated
api is below 2; the level-3 table runs first, so a `split` arrives at this
table already rewritten to a `column`, which this table does not touch):

| Level-2 primitive | Degrades to |
|-------------------|-------------|
| `shell` | `container` |
| `row` | `container` (direction row) |
| `list_row` | `card` |
| `chip` | `text` |
| `badge` | `text` |
| `sheet` | `card` |
| `dialog` | `card` |
| `code_block` | `text` (mono style) |
| `tabs` | `nav` (kind tabs) |
| `skeleton` | `progress` |
| `avatar` | `figure` (shape circle) |
| `menu` | `list` |
| `tree` | `list` |
| `rich_text` | `text` |

Capability-based degrades: without `sse` a `stream_view` becomes a `list`
carrying a server-side snapshot of the stream tail (universal props survive
the replacement so patches addressed at the id still land); unhonourable
inline directives are removed from node props (section 4).

Level-1 clients additionally receive the level-1 shape: no `contract`,
`tokens`, `density` or `keymap`, and a `theme` reduced to `seedColor` + `mode`
(Appendix A). When the client's `schema` is below `contract.minSchema`, the
server includes a `version_gate` screen as the `entry` so a stale installed
client shows the "update required" surface instead of product screens.

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

Per server profile (`ServerProfile` in `frontend/lib/core/auth/app_storage.dart`,
persisted locally):

- `cachedBootstrap` — the last successful bootstrap payload. Used to render
  immediately when the server is unreachable; the server's `fallbacks` art
  (from the same payload) is cached alongside it for offline/error screens.
- `cachedScreens` — screen id → node JSON, an in-memory LRU bounded at **50**
  entries and persisted with the profile. A cached screen renders immediately
  and **revalidates in the background** (stale-while-revalidate); inline
  screens (those travelling with the bootstrap) are never fetched, only
  `refresh` re-fetches them.
- `fallbacks` — the cached offline/error nodes.

`refresh` and `reloadBootstrap` force network. `reloadBootstrap` drops the
screen cache, the `setScreen` overrides and the cached bootstrap first, then
re-runs `GET /_jhin/bootstrap` and persists the fresh payload.

**Payload versioning.** Cached payloads carry the `api` and the contract
`schema` they were produced at. On an `app`, `api` or `schema` change the
client drops `cachedScreens` and revalidates `cachedBootstrap` — a stale
screen built for api 1 must never be replayed into an api-3 renderer, and a
payload cached under schema 3 must never seed a schema-4 store. This is the
cache half of the data-upgrade system; the persisted-state half is specified
in [updates.md](updates.md).

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

## Appendix A. Contract level 1

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
