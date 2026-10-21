# Preview plan

Status: **in progress** (workstream W12 of `t3-roadmap.md`). This file
records how Jhin ports T3 Code's browser preview, its devices and its
rendered HTML pages: a browser on the node that the user and the agent drive
together, simulators and emulators shown beside the chat, and self-contained
HTML pages an agent checks and then renders into the thread.

## Goal

An agent working in a thread opens a page of the dev server it just started,
looks at it (an accessibility tree with refs, a screenshot), clicks, types and
records what it did, while the user watches the same tab in the right panel
and takes control whenever they want. The agent shows a chart or a mockup as
a page inside its reply. Everything is a plugin on the public API and every
operation is a command, so an agent reaches it through MCP under T3's tool
names (`preview_click`, `html_render`, `device_open`, …), a script through the
CLI, and the web client through RPC.

## Decisions

### Reference

- **D390. T3 Code nightly `eb7b35ac` (D53) is the reference**, its server
  browser runtime (the one a web client uses; the Electron webview is W18's):
  `apps/server/src/preview/` (`ServerBrowser.ts`, `ServerBrowserPage.ts`,
  `ServerBrowserStream.ts`, `ServerBrowserContexts.ts`, `SessionControl.ts`,
  `Manager.ts`), `apps/server/src/mcp/toolkits/{preview,previewControls,html,device}`,
  `apps/server/src/mcp/PreviewAutomationBroker.ts`,
  `apps/server/src/htmlRender/`, `apps/server/src/device/`,
  `packages/contracts/src/{preview,previewAutomation,device}.ts`,
  `packages/shared/src/{preview,previewViewport,htmlRender}.ts`, and in
  `apps/web` `components/preview/*`, `browser/ServerBrowserSurface.tsx`,
  `browser/BrowserDeviceToolbar.tsx`, `components/chat/HtmlRender*.tsx`,
  `components/device/*` and `packages/client-runtime/src/preview/serverBrowserStream.ts`.
  Derived files name their origin and are covered by
  `THIRD_PARTY_NOTICES.md`. T3's Effect services, its desktop runtime, its
  annotation tool and its hosted pairing scopes are not ported.

### Contracts and plugins

- **D391. Three server plugins, one contract package.** `@jhin/preview-api`
  holds the Zod schemas, event types and error codes of three capabilities:
  `preview.browser@1` (provided by `jhin.preview`, `plugins/preview`),
  `preview.html@1` (`jhin.html-render`, `plugins/html-render`) and
  `device.hosts@1` (`jhin.devices`, `plugins/devices`). None requires another
  or the threads plugin: a thread is an id they group their state by, as the
  terminal's is (D140), and a deleted thread is learnt from the node's
  `threads` index when the node has an event log. The web client's builtins
  are `jhin.preview-panel` (the right panel with its browser tabs and the
  header toggle), `jhin.html-render-view` (pages in the timeline) and
  `jhin.device-panel` (devices in the right panel).

- **D392. Command names give T3's MCP tool names.** MCP turns `.` into `_`
  (PR 7), so the agent's commands are `preview.status`, `preview.open`,
  `preview.navigate`, `preview.resize`, `preview.set.appearance`,
  `preview.snapshot`, `preview.click`, `preview.type`, `preview.hover`,
  `preview.select`, `preview.drag`, `preview.upload`, `preview.press`,
  `preview.scroll`, `preview.evaluate`, `preview.wait.for`,
  `preview.recording.start`, `preview.recording.stop`, `preview.dialog`,
  `preview.list` and `preview.close` (T3's `t3_preview_list` and
  `t3_preview_close`), `html.preview`, `html.render`, `device.list`,
  `device.open`, `device.screenshot` and `device.close`. Inputs are T3's tool
  parameters with their descriptions, plus `threadId` (T3 takes the thread
  from the MCP credential; a Jhin command has no thread scope) and, for the
  browser, an optional `session` (below); outputs are T3's results without the
  `toolIcon` presentation field. Wording that names a T3 tool names the Jhin
  one (`preview_close` for `t3_preview_close`). Errors are `PreviewError`s
  with a code per T3 error tag (`PREVIEW_TAB_NOT_FOUND`, `PREVIEW_CONTROL`
  with the reason in `details.reason`, `PREVIEW_TIMEOUT`,
  `PREVIEW_INVALID_SELECTOR` with `details.staleRef`, `PREVIEW_NOT_EDITABLE`,
  `PREVIEW_RESULT_TOO_LARGE`, `PREVIEW_EXECUTION`, `PREVIEW_INVALID_URL`,
  `PREVIEW_UNAVAILABLE`, `PREVIEW_RECORDING`) and T3's messages, which the
  agent reads.

- **D393. Permissions.** Reading a tab (`preview.status`, `preview.list`,
  `preview.snapshot`, `preview.wait.for`) and subscribing to its streams takes
  `preview.read`; everything else, `preview.evaluate` and `preview.upload`
  included (they run code in the page and read the node's files), takes
  `preview.write`. The panel's commands (`preview.tab.*`, D402) act as a
  human viewer that may take a tab from any agent, so they take
  `preview.control`, which a token given to an agent should not hold.
  `html.preview` takes `preview.write` (it reads image files
  of the node, as T3 only lets its own agents do), `html.render` takes
  `threads.write`; the device commands take `devices.read` (`device.list`,
  `device.screenshot`) and `devices.write`.

### The browser on the node

- **D394. One headless Chromium per node, through `playwright-core`**, as
  T3's server browser: launched on the first tab with T3's arguments
  (`--disable-gpu`, `--force-device-scale-factor=2`,
  `--disable-blink-features=AutomationControlled`, without
  `--enable-automation`), presented as Chrome (T3's `presentAsChrome`: the
  user agent and its client hints without `HeadlessChrome`), and closed when
  its last tab closes (T3 keeps it; nothing else needs it running). T3
  downloads a pinned `chrome-headless-shell`; Jhin uses the Chromium
  Playwright installs (`npx playwright install chromium`), or
  `jhin.preview.executablePath` when set. Without one every command fails
  with `PREVIEW_UNAVAILABLE` and says how to install it. Human tabs share one
  browser context; a tab an agent opens gets its own throwaway context (T3's
  isolation rule for agent tabs without a profile). A crashed or closed page
  drops its tab; a disconnected browser starts again on the next tab.

- **D395. Tabs.** A tab belongs to a thread; its id is
  `tab_<sequence in base 36>_<run>`, where the run is new whenever the plugin
  starts, so a client never binds to another tab after a restart. Limits are
  T3's: 8 tabs per agent session and 32 per node, checked when a tab is
  created after the agent's idle tabs are swept (an agent tab without viewers
  unused for 30 minutes is closed, checked every minute). A popup becomes a
  tab of the same thread with `openerTabId`, owned by the opener's agent; it
  is closed instead when its opener's agent is at its limit. A deleted thread
  closes its tabs. A tab is `visible` while a client watches its frames
  (D399).

- **D396. Agent sessions and the current tab.** T3 tells agents apart by
  their MCP credential. A Jhin command knows its caller only, so an agent
  session is the caller's id, the thread and the optional `session` input (an
  agent that runs several subagents in one thread passes one per subagent,
  as T3 asks parallel subagents to pass their tab ids). The session's
  current tab is the last tab a command of that session returned; a command
  without `tabId` targets it, else the newest tab the session owns, else the
  thread's tab a client watches, else its most recently used tab. With more
  than one owned tab and no `tabId`, acting fails with `tabRequired`. An
  invocation without a caller is trusted in-process code (D17): every such
  invocation in a thread is one session, `local`, unless it names a
  `session`.

- **D397. Control, as T3's `SessionControl`.** A tab's owner is `agent` (it
  has an agent session), `human` (a viewer holds control) or `unclaimed`.
  Agent actions on a tab run one at a time in a queue; a session may act on
  its own tabs and on unclaimed ones, never while a human holds control
  (`humanControl`) and never on another session's tab (`agentMismatch`; it
  may still read it). A human takes control at any time, from an agent too:
  the generation grows, queued agent actions fail with `interrupted` and
  element refs are revoked. `preview.status`, `preview.snapshot` and
  `preview.wait.for` are reads: they run at once beside a human's input. A
  pending dialog blocks every other action (`dialogPending`) until
  `preview.dialog` answers it. Viewers are named by an id the client picks;
  a viewer that stops watching (its frame subscription ends, as T3's socket
  closes) releases control, and the held keys and buttons are released. A
  viewer id is advisory: it tells the panels of one owner apart (D22), not
  callers, so any holder of `preview.write` may name any viewer. Binding a
  viewer to its caller or its subscription is deferred.

- **D398. Operations do what T3's do**, with its defaults (15 s per action,
  at most 60 s) and limits: navigation by URL (T3's normalisation: schemeless
  loopback hosts are `http`, other hosts `https`, only http(s)) or by an
  `environment-port` target (`http://localhost:<port><path>` on the node),
  waiting for `load`, `domContentLoaded` or nothing (a navigation that is not
  waited for still holds back the next action); a snapshot is Playwright's
  `ariaSnapshot({ mode: "ai" })` with refs rewritten to
  `t3-<generation>-<ref>`, which navigation, a dialog, a new snapshot or a
  change of control revoke, the page's visible text, both cut at 20 000
  characters, the values of password fields masked as `••••••••` in both, the
  last 200 console and network entries and 50 actions, and a PNG of the
  viewport at most 1280 pixels wide (`save` writes it under the plugin's data
  folder and returns only `url` and `screenshotPath`; `includeImage` false
  leaves the image out, as T3's tool does); a click returns as soon as a
  dialog opens; typing inserts text into an enabled text field only;
  `preview.select` picks options of a native `<select>` by value or label;
  `preview.upload` answers the open file chooser or sets a file input's files
  from absolute paths; `preview.evaluate` runs through CDP and stops the
  script at its deadline, its result at most 64 000 bytes; `preview.wait.for`
  checks every 100 ms until every condition holds. The agent's pointer is
  published to viewers before a click, hover or drag (T3's agent cursor).

- **D399. Recording, as T3's.** `preview.recording.start` feeds the tab's
  screencast into a scratch page of the same browser, which paints each frame
  and the agent's cursor onto a canvas and encodes it with `MediaRecorder`
  (MP4 when Chromium can, else WebM); `preview.recording.stop` writes the
  video under the plugin's data folder and returns its path, at most 50 MiB.

- **D400. Viewport and appearance.** A tab's viewport is `fill` (the size of
  the panel that watches it, 1280 × 800 while nobody does), `freeform` or a
  `preset` from T3's list of Chrome DevTools devices, with its orientation;
  sizes are 240–3840 pixels and at most 3840 × 2160. `preview.resize` sets it
  for the agent; appearance emulates `prefers-color-scheme` (`system` clears
  it). The panel's device toolbar, zoom, hard reload and "Clear cookies" /
  "Clear cache" go through `preview.tab.adjust`, which needs no control, as
  T3's `adjust`.

### Streams and the panel's commands

- **D401. Two live streams per thread** (`rpc.streams@1`, D141), both under
  `preview.read`. `preview/<threadId>` holds one event, `preview.tabs`, the
  thread's tabs after every change (url, title, navigation status with T3's
  `Idle` / `Loading` / `Success` / `LoadFailed`, back and forward, viewport
  setting and measured size, appearance, zoom, owner, the controlling viewer,
  the generation, a pending dialog or file chooser, downloads, recording,
  opener). `preview/<threadId>/<tabId>` carries the picture: `preview.frame`
  (a JPEG of the viewport, base64, with its CSS size; only the newest is
  kept, so a new viewer sees the page at once) and `preview.pointer` (the
  agent's cursor). The tab's screencast runs only while a client subscribes
  to that stream, at most at the size the viewers asked for, and each frame
  is acknowledged to Chromium no sooner than 100 ms after it came (T3's
  pacing). JSON-RPC carries what T3 sends as binary WebSocket frames; a
  binary channel is deferred.

- **D402. The panel's commands** are T3's preview RPC and its stream socket's
  messages, under `preview.write`: `preview.tab.open {threadId, url?}` (a
  human tab, unclaimed), `preview.tab.close`, `preview.tab.adjust`,
  `preview.tab.control {viewer, take}`, `preview.tab.navigate {viewer, url |
  delta | reload}`, `preview.tab.dialog {viewer, accept, promptText?}` and
  `preview.tab.input {viewer, events}`, where an event is T3's `mouse`,
  `wheel`, `key` (with T3's copy, cut, select-all, undo and redo commands),
  `text` or `resize` message, in page CSS pixels with T3's modifier bits.
  Input, navigation and dialogs need the viewer to hold control
  (`PREVIEW_CONTROL` otherwise); a `resize` (the panel's size, which a `fill`
  tab follows) does not, so a panel that only watches still frames the page
  at its own size.

### Web client

- **D403. The right panel, as T3's.** `jhin.preview-panel` contributes the
  `app.panel` `jhin.preview.panel` (the route's `panel` is `browser`), the
  chat header's `jhin.preview.toggle` (lucide `PanelRight`, "Toggle right
  panel") and the commands `preview.toggle` (⌘/Ctrl+Shift+J), `preview.refresh`
  (⌘/Ctrl+R) and `preview.focus.url` (⌘/Ctrl+L), the last two only while the
  panel has focus (the context key `previewFocus`, D61). The panel has T3's tab strip (the page's
  title, else its host, else "Browser"; "Close {title}"; "Add panel surface"),
  its chrome row (Back, Forward, Refresh, "Search or enter URL" with T3's
  address bar rules and DuckDuckGo for anything else, "Open in system
  browser", the more menu with "Hard reload", "Show device toolbar",
  "Appearance", "Zoom", "Clear cookies" and "Clear cache"), the device
  toolbar ("Responsive" and the presets, width × height, "Rotate viewport",
  "Close device toolbar"), the control strip ("Watching", "Agent has
  control", "You have control", "Another viewer has control", "Take control"
  / "Release control"), the empty state ("No preview yet", recently used
  pages) and "This site can’t be reached" with T3's error messages. Frames are
  drawn on a canvas; mouse, wheel and keys go to the page through a hidden
  textarea ("Browser page", Shift+Escape leaves it) while the user holds
  control. A tab an agent opens with `open` shows in the panel of that
  thread.

- **D404. Agent tool calls of the browser** keep the work log's generic tool
  rows; T3's "Used browser N times" summary and its browser icon come with the
  work-log presentation of MCP tools (deferred, W9 attaches the node's MCP
  server to Claude Code).

### Rendered HTML

- **D405. `html.preview`, as T3's `html_preview`**: the page (at most 512 000
  characters) gets T3's bootstrap (charset and viewport, the theme variables
  and base stylesheet, the size and link script), local images written as
  absolute paths are inlined (each at most 10 MiB, the page at most 25 MiB,
  files that are not images count as missing), and a fresh page of the
  plugin's headless Chromium loads it at `width` (240–1600, 728 by default)
  in the `dark` or `light` theme with T3's measuring fonts, served from
  `http://jhin-page.localhost/page.html`. Every other request of the page,
  loopback ones and WebSockets included, goes through T3's SOCKS5 proxy on
  loopback, which connects only to addresses it checked as public (T3's list
  of loopback, private, link-local, multicast, IPv4-mapped, NAT64 and 6to4
  ranges and the node's own addresses), so a name that resolves elsewhere
  later (DNS rebinding) reaches nothing local; WebRTC is removed. Loading and
  settling (fonts, two frames) share one 20 s deadline. It returns T3's
  result: a PNG screenshot up to 4000 pixels tall, `contentHeight`,
  `capturedHeight`, at most 20 console messages (500 characters each) and,
  past them, one note saying how many more were omitted, and `missingImages`. The browser starts for a page
  and closes after the last one. As in T3, any image file of the node a page
  names by its absolute path is inlined (its bytes must be an image), and with
  `html.render` it travels with the thread: the commands are for the node's
  own agents (`preview.write`, `threads.write`).

- **D406. `html.render`, as T3's `html_render`**: the page, prepared as above
  (missing images fail it), is measured at T3's nine widths (its `heights`)
  (in the dark theme, as T3 measures; a page whose layout differs between
  themes may fit a light reader's frame less well) and appended to the
  thread's stream as `preview.html.rendered {renderId, turnId?,
  title, height, heights?, html}`; the thread must exist. It names the turn
  running when the command began (read from the thread's recent events), so
  it stays in that turn even if another starts while it is measured; without
  one, the timeline shows it in the latest turn. Measuring takes at most
  three rounds of 20 s. It returns T3's `htmlRender` reference and its message to the
  agent. The page lives in the thread's event log, so it travels with the
  thread through the mesh (D26) and needs no attachment store; for the same
  reason a stored page is at most 4 MiB with its images (T3 allows 25 MiB in
  its attachment store), since every client and mesh member replays it.

- **D407. Pages in the timeline.** The chat timeline gets a public slot,
  `chat.turn.item` (`ChatTurnItemProps`): events of other plugins in a
  thread's stream (any type outside `agent.*` and `threads.*`) become items of
  the turn they name with `turnId`, or of the latest turn, in order with the
  agent's output, and are never folded behind "Worked for …" (T3 never folds
  a rendered page). Each renders through the slot, whose contributions draw
  the types they know (D34: the UI renders event types through slots);
  unknown `agent.*` events stay ignored. An event before the thread's first
  turn is not shown. `jhin.html-render-view` contributes `jhin.html-render.frame`: T3's
  `HtmlRenderFrame`, a sandboxed iframe (`allow-scripts allow-forms`, never
  same-origin) loaded from `srcdoc`, themed from the client's own CSS
  variables and kept in step with light and dark, fitted to the page's
  height at the frame's width, with "Open full screen" (T3's dialog with its
  zoom) and links opened in a new browser tab.

### Devices

- **D408. Devices of the node, without T3's device hub.** T3 installs
  `expo-device-hub` and `agent-device` from npm at runtime and streams
  through the hub. `jhin.devices` reads the node's own tools instead: Android
  emulators through the SDK (`adb devices`, `emulator -list-avds`, booting an
  AVD with `emulator -avd`, `adb emu kill`, `adb exec-out screencap -p`, found
  as T3 finds the SDK), iOS simulators through `xcrun simctl` on macOS
  (`list devices --json`, `boot`, `shutdown`, `io screenshot`). Its commands
  are T3's tools with T3's wording and errors; `device.open` returns the
  device and, instead of `agent-device`, the `adb -s <serial>` or `xcrun
  simctl … <udid>` invocation pinned to it with a quick start. A thread's open
  devices are its sessions; the node's `devices` live stream holds the list
  and the sessions after every change, and a device's stream holds its
  newest screen, taken while a client watches it. `jhin.device-panel` shows
  T3's device list ("iOS Simulators", "Android Emulators", "Open" / "Start",
  "Refresh devices", its empty states) and an open device's screen in the
  right panel, with "Power off device".

### Proof

- **D409. Tests drive a real headless Chromium** (the one CI installs for
  Vitest browser mode): the browser plugin's tests serve pages from a local
  HTTP server and wait for page events, the stream's frames or command
  results, never for time. The device plugin's tests run against fake `adb`,
  `emulator` and `xcrun` scripts. The panel and the timeline frame are proven
  with Playwright e2e against `jhin serve --ui`, with role locators and
  screenshots in the pull requests.

## Deferred

- T3's desktop runtime (an Electron webview per tab, its DevTools, separate
  windows and picture-in-picture, annotation of elements, "Open in
  {environment}'s browser"): with the desktop app (W18).
- Browser profiles and persistent logins (T3's named profiles, `profileId`,
  "Clear profile"): every tab's cookies live as long as the browser.
- Downloading a pinned `chrome-headless-shell` on first use, and T3's host
  setup hints (sandbox and libraries, close code 4503).
- A binary channel for frames (T3's WebSocket with per-frame acks); frames
  travel as base64 JSON events.
- Discovered local servers in the empty state (T3's port scanner) and the
  configured preview URLs of project scripts.
- The floating mini player ("Float preview over chat").
- Touch input and the editable-at-point probe for soft keyboards; human
  uploads through the file chooser (the panel can only cancel it) and saving
  downloads to the client.
- T3's work-log presentation of preview tools ("Used browser N times").
- Reading password values in isolated worlds of out-of-process frames: Jhin
  reads them in each frame's own world.
- T3's outline of a rendered page's boxes for the loading skeleton.
- Rendered pages in an attachment store (W6's blobs) instead of the
  thread's event log, and with it T3's 25 MiB pages.
- A content security policy for rendered pages in the reader's client: as
  in T3, a page's scripts may load from any host (a CDN chart library) and so
  also reach the reader's own network; only the client's origin is shut out
  (`sandbox` without `allow-same-origin`).
- In a rendered page: T3's image viewer for a clicked image and passing the
  app's shortcuts through a focused frame.
- Viewer ids bound to their caller or their frame subscription (D397).
- Devices: T3's device hub and `agent-device`, video streams and input to a
  device, device hosts over SSH, the setup wizard, the device tools panel
  (appearance, text size, location, permissions, push) and DeviceActions.

## PR plan

Each PR lists the decisions it implements and the proof it was merged on.

### PR 1 — Plan, contracts and the browser on the node

Implements D390–D402 (the server side), D409 for the browser.

- This plan; `@jhin/preview-api` (`preview.browser@1`, viewport presets, URL
  normalisation); `jhin.preview` with T3's tools as commands, the panel's
  commands and the two live streams; the plugin in the distribution.
- **Done when:** tests against a real headless Chromium open a tab, act on
  snapshot refs, revoke them on navigation, hold actions behind a dialog,
  keep another session's hands off a tab, stream frames to a viewer and
  hand control to it and back, resize to a preset, report an unreachable
  page, record a video, save a screenshot, close a deleted thread's tabs and
  explain a missing browser; `pnpm pack:smoke` lists tabs from the packed
  plugin.

### PR 2 — The right panel

Implements D403, D404.

- `jhin.preview-panel` (`apps/web/src/plugins/preview/`): the `app.panel`
  contribution with T3's tab strip, chrome row, more menu, device toolbar,
  control strip, empty state, "This site can’t be reached" and dialogs; the
  canvas surface with mouse, wheel and key input; the header toggle;
  `preview.toggle`, `preview.refresh`, `preview.focus.url`; a tab an agent
  opens to show brings up its thread's panel. The node refreshes a tab's
  title after each action and each input of a viewer, since a page may
  retitle itself without navigating.
- **Done when:** Playwright against `jhin serve --ui` sees an agent's tab come
  up in the panel, the agent's click land, the user take control, click and
  type into the page and hand control back; and the user open a page from
  the address bar, size it as an iPhone 12 Pro and close the tab; a unit test
  sees a tab retitled by its page.

### PR 3 — Rendered HTML

Implements D405–D407.

- `@jhin/preview-api` gains `preview.html@1` (limits, measured widths, frame
  heights, the theme variables and guides, the page's bootstrap);
  `jhin.html-render` (`plugins/html-render`) with `html.preview` and
  `html.render`; the timeline's `chat.turn.item` slot; `jhin.html-render-view`
  with the frame and its full-screen dialog, loaded as a chunk of its own.
- **Done when:** unit tests inject the bootstrap, inline images and refuse
  files that are not images, preview a page (screenshot, height, console,
  missing images) without it reaching a service on the node, render one into
  a thread's stream with nine heights and refuse missing images and unknown
  threads; the timeline keeps a plugin's event in its turn; Playwright sees a
  rendered page in its turn, themed in light and dark, and opens it full
  screen.

### PR 4 — Devices

Implements D408.
