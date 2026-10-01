# Jhin SDUI contract

The Flutter client is a server-driven-UI renderer: the server authors screens
as JSON trees over a fixed catalog of 25 primitives and the client renders
them. The client hardcodes exactly one screen — the server-profile surface
(add-server and profile switching) — and one endpoint, the bootstrap fetch
(`GET /_jhin/bootstrap`); everything else comes from the server. An unknown
primitive renders a placeholder card and the client never crashes on server
content.

This document is the wire contract. Server side: `plugins/ui-kit/` (the `Ui`
builder over the catalog) and `plugins/ui-default/` (bootstrap, screens,
actions, streams). Client side: `frontend/lib/sdui/`. See
[architecture.md](architecture.md) for the runtime and
[plugin-dev.md](plugin-dev.md) for writing plugins.

## 1. Bootstrap contract

`GET /_jhin/bootstrap` returns the whole client start-up payload. Two producers
exist:

**Kernel fallback** (a bare kernel without a UI plugin; `KernelRoutes`):

```json
{
  "api": 1,
  "empty": true,
  "kernel": "0.2.0",
  "plugins": [],
  "message": "This server has no UI plugin installed."
}
```

**`jhin.ui` payload** (a plugin route on the same path supersedes the fallback
silently; `BootstrapRoute`):

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

- `api` — contract level (`1`).
- `empty` — `true` tells the client to render its empty state ("no UI plugin
  installed") instead of a screen stack.
- `title`, `theme` — product chrome (`seedColor` is a `#RRGGBB` seed, `mode`
  is `system` in this build).
- `entry` — the screen id pushed first. `jhin.ui` selects `connect` when a
  security plugin is loaded and the caller carries no principal, `sessions`
  otherwise.
- `screens` — inline screens `[{id, node}]`, in registration order. Inline
  screens are cached and never lazily fetched; only `refresh` re-fetches them
  from `screenEndpoint`.
- `screenEndpoint` — path template for on-demand screens; the client substitutes
  `{id}` (URL-encoded) and expects `{node: …}` or a bare node.
- `fallbacks` — server-authored offline and error art (`offline`, `error`),
  cached by the client on first success.

The whole payload is tailored to the `X-Jhin-Client` header before it is
written (section 6): stream views degrade to server-side list snapshots without
the `sse` capability and inline directives the client cannot honour are dropped
from node props. Node shape everywhere:

```json
{"type": "text", "props": {"text": "Hello", "style": "h2"}, "children": []}
```

`children` is optional; a string child is a text shorthand.

## 2. The 25 primitives

The fixed catalog (`UiRegistry.standard()`, mirrored by the `Ui` builders in
`plugins/ui-kit`). Every node additionally accepts the universal props
`id`, `visible`, `padding` (number or map), `flex` and `when` (local boolean
expression, section 7). Required props are listed first; `?` marks optional.

| Primitive | Props |
|-----------|-------|
| `screen` | `body`, `title?`, `appBar?`, `floatingAction?` |
| `nav` | `kind` (`tabs`/`drawer`/`bottom`), `items` (`[{label, icon?, screen}]`) |
| `container` | `children`, `direction?` (`row`/`column`), `gap?`, `align?`, `scroll?`, `padding?` |
| `card` | `children`, `title?` |
| `text` | `text`, `style?` (`h1`/`h2`/`h3`/`body`/`caption`/`mono`), `bold?`, `color?` |
| `markdown` | `text` |
| `button` | `label`, `style?` (`primary`/`secondary`/`danger`/`text`), `action?`, `icon?`, `confirm?` |
| `input` | `id`, `label?`, `value?`, `placeholder?`, `multiline?`, `obscure?`, `keyboard?`, `required?`, `min?`, `max?`, `pattern?`, `errorText?` |
| `dropdown` | `id`, `items` (`[{label, value}]`), `value?`, `action?` |
| `checkbox` | `id`, `label`, `value?` |
| `switch` | `id`, `label`, `value?` |
| `slider` | `id`, `min`, `max`, `label?`, `step?`, `value?` |
| `form` | `fields` (nodes), `submit` (`{label, action}`) |
| `list` | `items` (nodes or strings), `maxHeight?` |
| `table` | `columns` (`[{label, width?}]`), `rows` (arrays of cells) |
| `stream_view` | `id`, `topic`, `mode?` (`append`/`replace`), `itemLimit?`, `autoScroll?`, `empty?` |
| `divider` | — |
| `spacer` | `size?` |
| `progress` | `kind?` (`linear`/`circular`), `value?` (omitted = indeterminate) |
| `image` | `src` or `dataUri`, `width?`, `height?`, `fit?` |
| `figure` | `shape` (`rectangle`/`circle`/`triangle`), `color`, `width`, `height` |
| `chart_line` | `series` |
| `chart_bar` | `items` or `series` |
| `chart_pie` | `items` |
| `drawer` | `children`, `title?` |

Rendering rules: `visible:false` hides a node; `when` hides it when the
expression evaluates to `false`; string props are `${…}`-interpolated (section
7); `padding` wraps the node. An unknown `type` renders a muted
`Unsupported UI element: <type>` card; a malformed prop degrades that node only,
never the screen.

## 3. Action protocol

An `action` object on `button.action`, `dropdown.action` or `form.submit`:

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
3. **Post** `{"action": "<name>", "payload": {…merged}}` to `path`.
4. **Run the response's `client` directives** (section 4).

Server side (`POST /ui/action/{name}`; the body name is informational, the path
capture is authoritative):

- `200` → `{"client": [ …directives ]}` — the directive list the handler
  returned, with the directives this client cannot honour dropped first.
- `404` → `{"error": "unknown_action", "message": "no action named <name>"}`.
- `400` → `{"error": "invalid_request", …}` when the body is not a JSON
  object (a blank body dispatches with an empty payload).

## 4. Client directives

Sixteen directives (`Directives` on the server, `DirectiveExecutor` on the
client). Wire form is the `op` discriminator plus the listed fields. They
appear in action responses, in `{client: […]}` stream frames and inline in node
props (a button action may be one directive).

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
| `dialog` | `node` | open a dialog rendering the given node |
| `dismissDialog` | — | close the open dialog |
| `setState` | `id`, `value` | set one local `UiState` field (feeds `when` / `${…}`) |
| `patch` | `id`, `props` | merge props into one rendered node in place |
| `setScreen` | `id`, `node` | replace the node of a known screen id |
| `openUrl` | `value` | open a URL in the client's browser surface |

**Capability drops** (`X-Jhin-Client` capabilities, section 6): `openUrl` is
dropped without `open_url`; `setToken` and `clearToken` without
`secure_storage`; `setServerUrl` without `multi_profile`. The same rule strips
inline directives from node props at the source (the prop is removed rather
than emitted and ignored).

## 5. Streams and frames

`stream_view.topic` is the SSE endpoint path to open (for `jhin.ui`,
`/ui/stream/session/{id}`). The connection is reconnecting with exponential
backoff and replays from `Last-Event-ID`; every SSE event whose data decodes to
a JSON object is one **frame**. Four frame shapes, exactly one per event:

| Frame | Shape | Effect |
|-------|-------|--------|
| node | `{"node": {…node}}` | append (or replace everything with `mode: replace`); a re-delivered `id` replaces the item in place |
| patch | `{"patch": {"id": "…", "props": {…}}}` | merge `props` into the stream item with that `id`; with no such item the patch targets the surrounding screen |
| remove | `{"remove": "<id>"}` | drop the item; the id stays tombstoned — a replay never resurrects it |
| client | `{"client": [ …directives ]}` | run the directive list |

`itemLimit` drops the oldest items; dropped or removed ids are never
resurrected. Nodes without an `id` always append.

**Session event payloads** (`jhin.sessions` event log, translated into frames by
`jhin.ui`'s `EventFrames`): each stored event carries a gap-free per-session
`seq` (the SSE de-duplication key) and one of these wire types and payloads:

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

## 6. Client capabilities

The `X-Jhin-Client` header is `api=<int>; version=<semver>; caps=<comma-list>`
(keys in any order, unknown keys ignored). Known capability names at api 1:
`sse`, `tls_pinning`, `secure_storage`, `open_url`, `multi_profile`; the set
only grows. The server must treat an absent capability as unsupported and
degrade at the source (`CapabilityTailor`): without `sse` a `stream_view`
becomes a `list` carrying a server-side snapshot of the stream tail (universal
props survive the replacement so patches addressed at the id still land), and
unhonourable inline directives are removed from node props (section 4).

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

## 8. Caching

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
