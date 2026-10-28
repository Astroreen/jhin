# Preview plan

Status: **implemented** (workstream W12 of `t3-roadmap.md`). This file
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
  newest screen, taken about twice a second while a client watches it
  (`devices.read` to subscribe). Tools are found as T3 finds them, or named in
  `jhin.devices` (`androidSdk`, `adb`, `emulator`, `xcrun`). A deleted
  thread's devices leave its panel and keep running. `jhin.device-panel`
  shows T3's device list ("iOS Simulators", "Android Emulators", "This node ·
  {version} · Running|Stopped", "Open" / "Start", "Refresh devices", "Starting
  {names}… This can take a minute.", its empty states and platform reasons)
  and an open device's screen ("Connecting video…"), with "Power off device"
  and "Close device panel". T3 shows a device as a surface of its right
  panel; here the Device panel is its own `app.panel` (`jhin.device.panel`,
  route `panel: devices`) with a chat header toggle ("Toggle device panel"),
  because Jhin's right panel holds browser tabs only; a device an agent opens
  for the thread brings the panel up (`jhin.device.reveal`). Since W34 T3's
  device hub gives live video and input (D1206–D1209); everything here stays
  as its fallback (D1207).

### Local servers (W25)

Workstream W25 of `t3-roadmap.md` continues this plan with decisions from
its range D941–D960 (the desktop app's take D941–D948 in `desktop.md`). The
reference stays T3 Code `eb7b35ac`: `apps/server/src/preview/PortScanner.ts`
and `apps/web/src/components/preview/PreviewEmptyState.tsx`.

- **D949. A terminal tells which processes it runs.** `terminal.sessions`
  1.3 adds the optional `processIds(threadId, terminalId)`: the shell and
  every process below it, from the process table the terminal plugin
  already reads for its indicator (`terminal.md`, D467); empty without a
  running process. It is how T3's terminal manager registers its processes
  with port discovery.

- **D950. The empty state lists T3's local servers.** The command
  `preview.servers.list` (node, `preview.read` and `terminals.read`, since
  it tells which threads' terminals run what) scans the machine's TCP
  listeners as T3's `PortScanner` does (its parsers ported in
  `plugins/preview/src/local-servers.ts`): `lsof`, else `/proc` on Linux
  (socket owners by a bounded fd walk that visits the terminals' processes
  first, and `lsof` is not tried again once
  missing), `netstat` and `tasklist` on Windows. It keeps a listener only
  when a terminal's process owns it, since sending HTTP to another app's
  binary listener can crash it, and only when it answers HTTP, else HTTPS,
  with a page or a redirect (probes cached for 15 s). The panel's empty
  state shows T3's "Local servers" section under "Recently used": the
  process name (or "Listening") and `host:port`, T3's hint "Select a live
  local server to open it in this browser tab.", and a click opens the
  server in the browser tab. It rescans every 3 s while it shows and the
  page is visible, T3's cadence, from the client, backing off up to a minute while the node does not
  answer; the node answers every panel that asks within 2 s
  from one scan. `lsof`'s exit code 1 after a warning still counts, as in
  T3.

### A script's preview (W42)

W42 of `t3-roadmap.md` (D1461–D1480) gives project scripts T3's preview URL
(`source-control.md` D1471–D1473). The reference is D53's
`ChatView.tsx` (`runProjectScript`'s `openUrlInPreview`) and
`PortScanner.ts` (`configuredUrls`).

- **D1480. A script's preview URL opens in the preview, and is a configured
  URL of the empty state.** A script run with `autoOpenPreview` and a
  `previewUrl` opens that URL in a new browser tab of the thread on screen,
  shown in the right panel (the client command `preview.open-url { url }`,
  through `preview.tab.open` and W40's tab strip), as T3's
  `openUrlInPreview`. And as T3's `configuredUrls`, `preview.servers.list`
  takes `configuredUrls` (additive, the open thread's project's scripts'
  `previewUrl`s, at most 50, http and https on this machine's loopback
  only, `0.0.0.0` read as `localhost`: a URL of another host would make the
  node a probe of its network for any caller that may list servers): each is probed as D950 probes a listener, and one that
  answers is listed under its configured URL, in place of a listener on
  the same port, the list sorted by port as T3 sorts it. A configured URL
  needs no terminal of its own: the user named it.

### The pinned browser (W25)

- **D951. T3's `chrome-headless-shell` on first use.** When no
  `jhin.preview.executablePath` is set and Playwright has no browser on the
  node, the first tab installs T3's pinned Chrome for Testing headless shell
  (`plugins/preview/src/headless-shell.ts`, T3's version and per-platform
  sizes and SHA-256 sums) into `<home>/tools/chrome-headless-shell/<platform>/<version>`,
  shared by the node's plugins. The download must match the pinned size and
  SHA-256; the zip (read with `yauzl`, as T3 does) is unpacked only from its
  one folder, with no `..`, links or encrypted entries, into a staging
  folder renamed into place, and older versions and stale stagings go. A
  request waits for the install up to 45 s, then gets T3's progress ("Jhin
  is installing its headless browser (N of M MB downloaded). Try again in a
  minute.") while the install goes on; a failed install starts again with
  the next request. A configured path or Playwright's own browser still
  wins, so nothing changes where one is there.

### Browser profiles (W25)

- **D952. A human's tab browses with a profile, as in T3.** `default` and
  user profiles keep cookies, logins and storage in a folder of their own
  under the plugin's data (`profiles/<digest of the id>`, so any id is a
  distinct, valid folder name on every system, whatever its case or characters), started with Playwright's `launchPersistentContext` for the
  profile's first tab and closed with the browser when the
  last tab closes (its folder stays); `incognito` is a
  context of the shared browser and keeps nothing past it. An agent's tab
  keeps a context of its own, and a popup its opener's profile.
  `preview.tab.open` takes an optional `profileId` (T3's id rules: 1–64
  characters, no control characters), `PreviewTab` carries it, and
  `preview.profile.clear` (T3's "Clear profile") closes the profile's
  context, and with it its tabs, and removes its folder; the next tab of the
  profile starts from nothing. Every profile starts through D951's browser
  choice.

- **D953. The web client manages profiles as T3 does.** This device keeps
  its profiles in the client section `jhin.preview.browser` (`profiles`:
  id and name, at most 24, names up to 48 characters; `defaultProfileId`),
  shown after T3's built-in Default and Incognito. Settings → Browser has
  T3's "Browser profiles" row: "Add profile" (a fresh "New profile" name), a
  rename field per user profile, a Default badge, and a menu per profile
  with "Set as default", "Clear cookies and cache" (`preview.profile.clear`
  on every connected node, as T3 clears every environment) and "Remove
  profile and data" (after a confirmation). In the right panel, "+" opens a
  tab in the default profile and T3's "Open browser in a profile" menu
  beside it in another; a tab of another profile than the default shows its
  name before the address, every human tab's menu says "Profile: <name>"
  (T3's More menu), and a profile this device no longer has shows as
  "Removed profile".

### The floating mini player (W34)

Workstream W34 of `t3-roadmap.md` continues this plan with decisions from
its range D1201–D1220 (D1201 is the desktop app's, in `desktop.md`). The
reference stays T3 Code `eb7b35ac`: `apps/web/src/previewMiniPlayerStore.ts`,
`components/preview/ThreadPreviewMiniPlayer.tsx`,
`components/preview/previewMiniPlayerLayout.ts`, the `pictureInPicture`
toggle of `components/preview/PreviewChromeRow.tsx` and `PreviewView.tsx`,
and `closePreviewPanel` and `shouldRenderPreviewMiniPlayer` in
`components/ChatView.tsx` and `ChatView.logic.ts`.

- **D1202. A browser tab floats over its thread's chat, as in T3.** The
  chrome row gets T3's "Float preview over chat" toggle (its icon, its
  pressed state and "Close floating preview", disabled on an unreachable
  page): the tab floats and the right panel closes. Closing the right panel
  with its toggle floats the tab it showed too, as T3's `closePreviewPanel`
  does: whenever the panel shows a tab, an unreachable one included (only
  the toggle in the chrome row is disabled for it), and with no way to only
  dismiss the panel, which T3 offers none of either. One tab floats per thread (`<target>|<thread>`), kept in the
  plugin's state in memory as T3 keeps it in a store; its position and
  width outlive a change of the floating tab, and a gesture that outlives
  its tab is ignored. The player is T3's: at the page's aspect ratio
  (`BrowserSurface` gets `followSize={false}` and `onViewport`, so the page
  keeps the size it had), 320 by 320 at most until resized, in the chat's
  bottom right corner above the composer until moved, dragged by the pill
  behind its handle dot (a tap opens the pill on touch), resized by eight
  edges and corners at a fixed aspect ratio, clamped clear of the composer
  by T3's layout (`plugins/preview/mini-player-layout.ts`, with T3's
  tests). The pill holds "Open preview in right panel" and "Close floating
  preview", and the dot pulses while the tab records. The viewer that holds
  control drives the page through the player as through the panel. It
  hides while the right panel shows the same tab, and goes when the tab
  closes. The thread view gets the slot `chat.thread.overlay`
  (`ChatThreadOverlayProps`: target, thread, the composer's height), a layer
  over the messages and composer that lets the pointer through; the player
  is its `jhin.preview.mini-player`, loaded as a chunk of its own when a tab
  first floats. The client commands `preview.float` (an optional `tabId`,
  else the tab the panel shows) and `preview.float.close` act on the thread
  on screen. The e2e drives the buttons, the pill, both commands through
  the palette, and a floating tab closed on the node.

### The chat canvas and the pop-out (W37)

Workstream W37 continues D1202 with decisions from its range D1321–D1340
(D1321–D1325 are the desktop app's, in `desktop.md`). The reference is T3
Code `eb7b35ac`: `apps/web/src/components/chat/{ChatCanvas.tsx,chatCanvasLayout.ts}`,
the `.chat-composer-lane` and `.messages-timeline-scroll` rules of
`index.css`, `ThreadPreviewMiniPlayer.tsx` and `browser/serverPictureInPicture.ts`.

- **D1326. T3's chat canvas: the chat's lane makes room for a floating
  tab.** The thread view measures the area of its messages and composer and
  the lane's padding and widths (T3's width probe), and lays a floating
  player out with T3's `resolveChatCanvasLayout` (`apps/web/src/lib/chat-canvas-layout.ts`,
  with T3's cases but those of its thread details card): a player in the
  bottom corner sits beside the composer when a readable lane (at least
  40rem) fits beside it, the lane moving left and narrowing only as far as
  it must (`--chat-lane-inset-start`/`-end` on the messages and the
  composer lane, T3's rules); otherwise the player stays clear of the
  composer as D1202 placed it. A drag stops before the player would push the
  lane, and the open find bar is an obstacle the player keeps clear of.
  `ChatThreadOverlayProps` gets the optional `canvas` (`ChatCanvas`:
  `report`, `clear`, the `frame` it lays out and its `container`), so any
  overlay contribution can float beside the chat; the mini player reports
  itself and goes where the canvas puts it, and lays itself out as before
  without one. D1202's layout moves to `apps/web/src/lib/mini-player-layout.ts`,
  shared by the two. With W38's inline details card (D1350) the lane's end
  moves in by the larger of the card's inset and the player's, both through
  `--chat-lane-inset-end`; the player does not yet keep clear of the card
  itself (T3's `detailsCard` obstacle, Deferred).

- **D1327. "Pop into separate window", as T3's for a server tab.** The mini
  player's pill gets T3's toggle ("Pop preview into separate window" /
  "Close popped-out preview", tooltips "Pop into separate window" / "Close
  separate window", lucide `PictureInPicture2`) wherever the browser floats
  a canvas's video (T3's `supportsServerPictureInPicture`). Pressing it
  opens the browser's picture-in-picture window during the gesture, seeded
  with the frame on screen, and then paints the tab's frames from its
  `preview/<thread>/<tab>` stream, which makes the window a viewer (D401).
  One tab pops out at a time, kept in the panel plugin's state, so the
  window outlives the player and the panel; it closes when the user leaves
  it, presses the toggle again, or the tab closes. The client commands
  `preview.pop-out` ("Pop into separate window", the floating tab of the
  thread on screen) and `preview.pop-out.close` ("Close separate window") do
  the same; the browser opens the window only during a user's gesture, so
  they work from the palette or a keybinding, not over RPC. This is a
  departure from "every operation is a command reachable from RPC, the CLI
  and MCP", which the owner accepted (2026-10-23): `preview.pop-out` is a
  command that opens a window only with the user's activation, and without it
  (`navigator.userActivation`) it answers `poppedOut: false` with `reason:
  "needs-gesture"`; where a browser has no `userActivation`, the browser's
  own refusal answers instead, as an error.
  `poppedOut: false` means there was nothing to pop out, and `reason` says
  which: `needs-gesture`, `nothing-floats`, `in-panel` (the right panel
  shows the tab), `app-tab` (the app's webview), `unsupported`, or
  `superseded` (closed while it opened: by the user, by another open, or
  as its tab went). A tab the desktop app
  hosts (D1321) has no node frames: it gets no toggle (Deferred). The
  canvas lays out one player at a time, as T3's: a second overlay that
  reports displaces the first (Deferred).

### Cookie import (W34)

The reference is T3 Code at `eb7b35ac`: `apps/desktop/src/preview/BrowserImport/*`,
`packages/contracts/src/browserImport.ts` and
`apps/web/src/components/settings/BrowserImportWizard.tsx`.

- **D1204. The node imports the cookies of its machine's browsers into a
  profile, as T3's desktop does into a session.** T3 reads the browsers of
  the machine its Electron app runs on; Jhin's profiles live on the node
  (D952), so the node reads the browsers of its own machine
  (`plugins/preview/src/browser-import/`, plain TypeScript after T3's
  Effect modules). T3's sources, their folders and platforms: Chrome, Edge,
  Brave, Vivaldi, Opera, Arc and Helium (Chromium; macOS, Linux but Arc,
  and Windows only for Helium, since App-Bound Encryption keeps the others'
  cookies from any other process), Firefox (all three, with Linux's Snap
  home) and Safari (macOS). A source's profiles come from Chromium's
  `Local State` (only single plain folder names) or a scan, Firefox's
  `profiles.ini` (`[ProfileN]` only, relative paths kept inside the root)
  or a scan, and Safari's `SafariTabs.db`; each with its cookie count. A
  source is unavailable for T3's reasons (`unsupportedPlatform`,
  `notInstalled` when no profile has a cookie database, `browserRunning`
  by Chromium's `SingletonLock` or Firefox's `lock` and an fcntl probe of
  `.parentlock`, `needsFullDiskAccess` when Safari's jar refuses an open).
  Databases are read from a `VACUUM INTO` copy in a temporary folder
  (`node:sqlite`). Chromium values are decrypted as T3 does: AES-128-CBC
  `v10`/`v11` with OSCrypt's keys (macOS: the "Safe Storage" secret from
  the login keychain, read with `security find-generic-password`, since the
  node has no keyring binding; Linux: "peanuts" for `v10`, the libsecret
  secret of the browser's `application` for `v11`, read with `secret-tool
  lookup` where T3 ships a libsecret helper, and the empty-passphrase
  retry), the domain hash of schema 24+, Windows' DPAPI-wrapped AES-GCM key
  through PowerShell; partitioned (CHIPS) and undecryptable cookies are
  skipped and counted. Firefox reads only the default container, with its
  expiry unit and SameSite rules by schema; Safari's `binarycookies` are
  parsed with T3's bounds checks. Cookies go into the target profile's
  context with Playwright's `addCookies`: a host-only cookie as its bare
  host (Chromium keeps it host-only, as `__Host-` cookies need), a domain
  cookie with its dot, its path, expiry (seconds, capped at Playwright's
  9999-12-31), Secure, HttpOnly and SameSite (`unspecified` left out). A
  profile no tab runs is started for the import as its first tab would
  start it (`Chromium.withProfile`) and runs on until the browser closes
  (D394), so session cookies last as long as a tab's own; persistent ones
  reach the profile's folder at the latest when it closes. Chromium drops
  a cookie it refuses (SameSite=None without Secure) without an error, so
  the written cookies are read back: only one the profile holds counts as
  imported, the rest are skipped with their domains (at most 20, as T3).
  Read cookies are written once per name, domain and path, the last read
  winning, so an overwritten duplicate is not counted as skipped; a profile
  that closes while it is written fails the import (`sessionUnavailable`).
  T3 waits for a Keychain prompt without limit, as its user sits at its
  window; a node may be unattended, so `security`, `secret-tool` and the
  DPAPI call are killed after 5 minutes (no command takes an abort signal
  yet), an unanswered prompt failing as `needsKeychainApproval`, and an
  import that asks for a key already being asked for waits for the same
  prompt instead of opening another, under its own deadline (the prompt is
  killed once no import waits for it; a run with input, DPAPI's, is never
  shared). The web client calls each node over its own connection, which
  sets no deadline, so the wizard waits as long as the prompt. A call
  relayed with `mesh.call` is cut off after 30 s (`MESH_TIMEOUT`,
  foundation.md) while the prompt and the import go on: that caller sees a
  timeout although the cookies may still land, and imports again to see
  the result (an import that answers at once and is followed is deferred).
  Any other failure while the source is resolved (a folder that went away
  or refuses a read) is `readFailed`. The read-back compares domains
  without case or a leading dot. Commands: `preview.import.sources {}` → `{ sources }` (T3's
  `BrowserImportSource`) and `preview.import.cookies { sourceId,
  sourceProfileDirectory, targetProfileId }` → `{ imported, skipped,
  skippedDomains }`; a failure is `PREVIEW_IMPORT_FAILED` with T3's reason
  in `details.reason` and T3's message ("Importing cookies from firefox
  failed: unknownSourceProfile."). `sourceProfileDirectory` is honoured only
  when the source lists it right then, so no `..` or absolute path reaches
  another database; incognito is refused (`sessionUnavailable`). Both
  commands hand over the machine user's sessions, so they take
  `preview.control` (the panel's, D393) and a new `preview.import` ("Import
  browser cookies"): the owner's `*` holds both, a device token only when
  it is granted `preview.import` or `preview.*`, an agent's never.

- **D1205. Settings → Browser imports as T3's "Import from".** "Add
  profile" opens T3's menu: "Blank profile" (D953's), "You've reached the
  profile limit" at 24, and "Import from" with the browsers of every
  connected node (`preview.import.sources` when the menu opens; a group
  per node, "Import from <node>", once there are several), as D953 clears
  on every node; a browser that is not installed or not supported there is
  not listed. Choosing one opens T3's wizard for that node: "Quit <browser>
  to import", Full Disk Access, "Import from <browser>" with the source
  profiles and their cookie counts ("From") and "New profile" or an
  existing profile ("Into"), "Importing cookies", "Imported N cookies" /
  "Skipped N cookies" / "No cookies found" with the skipped domains, and
  "Couldn't import from <browser>" with T3's copy ("T3 Code" reads "Jhin")
  and "Try again" for the reasons T3 retries. The node's browsers are read
  and its profile written; a new profile is added to this device's list,
  named after the browser, only once cookies landed in it, and its cookies
  are cleared on the node again when the list is full by then
  (`profileLimitReached`). The Full Disk Access step cannot open the
  node's System Settings, so "Continue" checks the node again.

### The device hub (W34)

- **D1206. T3's device tools on first use, pinned.** The node installs T3's
  pins (`deviceToolVersions.json` at `eb7b35ac`): `expo-device-hub` 0.15.3
  (Expo's device hub, which bundles `serve-sim` for iOS Simulators and
  `serve-emu` for Android Emulators) and `agent-device` 0.21.25 (Callstack's
  device automation CLI), both MIT, from the npm registry, into
  `<home>/tools/<package>/<version>` (`plugins/devices/src/toolchain.ts`, from
  T3's `DeviceToolchain.ts`). Nothing is downloaded until a device opens on a
  node that has a simulator platform (a booted or bootable simulator or
  emulator, T3's `readinessIfSupported`): `device.open` and
  `device.hub.access` install the hub, the first input command installs
  `agent-device`. As in T3, `npm install --prefix <staging> --no-fund
  --no-audit <package>@<version>` runs into a `.staging-*` folder beside the
  version (pnpm's `dlx npm@11` when there is no npm, itself an unpinned
  download of npm 11, as in T3), the entry point is
  checked, a `.install-complete` sentinel with the version is written, and
  the folder is renamed into place; an entry without its sentinel or with
  another version installs again, installs run one at a time, a failed one
  leaves nothing behind and says only its step ("Installing expo-device-hub
  failed while running npm install (exit code 1)."), and, as D951 cleans up,
  stagings untouched for an hour go; older versions stay, as another node of
  the home may still run its hub from one. npm runs in a process group of
  its own, so a timeout or a stop also ends its install scripts. The `devices` stream
  carries T3's host status (`hostStatuses.local`: `installing` with "Installing
  device hub 0.15.3…" or "Updating … from … to …", `starting`, `ready`,
  `failed` with "Device support failed during {step}."), and a request waits
  for it up to D951's 45 s, then gets that status with "Try again in a
  minute." while the install goes on. All of it is opt-in until the setup
  wizard lands: T3 downloads its tools only after the user agrees in that
  wizard, Jhin has none yet (Deferred), so `jhin.devices.hub` is off by
  default and turning it on is the consent. Turning it off takes effect at
  once: tickets and proxied sockets go, the proxy answers 503, and the hub
  and its daemon stop, an install in progress too. `jhin.devices.npm` and `.node`
  name the npm and the Node.js to use. npm runs the packages' install
  scripts (the hub's `node-datachannel` fetches its native build there), so
  npm gets a reduced environment: PATH, home and temp folders, proxies,
  certificates and npm's settings other than its credentials, never the node's other variables
  (keys and tokens); the setting's description says the scripts run. The
  hub, the agent-device daemon and its CLI run with the same environment
  plus the Android SDK's and Xcode's variables, the display and the user.

- **D1207. The hub and its daemon run for the node, D408 is the fallback.**
  As T3's `LocalDeviceHost.ts` does, the node starts the hub with its own
  Node.js (or `node` on PATH, T3's "Local device support requires Node.js…"
  otherwise) on a free loopback port, `--host 127.0.0.1 --hide-sidebar
  --hide-boot-device` (and `--platform android` off macOS), with the SDK's
  tools first on PATH and T3's environment, waits for `/readyz`, and records
  its pid so a hub left by a node that died is stopped next time (pid and
  entry path both checked). `agent-device` gets its own state folder in the
  plugin's data, started by its first command (`devices --json`, the daemon
  in HTTP mode, never idling out) and read from its `daemon.json`, with
  T3's startup errors; a recorded daemon that no longer answers is stopped
  with agent-device's own `daemon stop` before a new one starts. As in T3, the daemon starts after the hub: a hub that
  cannot install or start leaves input to adb. A hub that exits starts again
  with the next request that needs it. Deactivating the plugin stops the hub and runs `daemon
  stop` (devices keep running; the user owns those); a stop cuts short an
  install or start in progress instead of waiting for it. D408's tools stay
  beside it and take over whenever the hub cannot run: the setting is off
  (the default; the panel then says "Video and input need the device hub.
  Turn it on with Devices → Device hub (jhin.devices.hub)."), no home (tests), no simulator platform, no Node.js or npm, an offline node
  whose install fails, or a hub that does not answer. Then the panel shows
  D408's screenshots about twice a second with the reason under them, and
  the input commands go through `adb shell input` (Android; text in pieces,
  as `input text` reads `%s` as a space and types no newline); iOS input then
  says it needs the agent tools, as simctl cannot tap.

- **D1208. The hub only behind the node's authenticated proxy.** The hub
  binds loopback and is never reached directly: `serve-sim` has a
  shell-exec route and `serve-emu`'s action routes are unauthenticated. The
  node's HTTP server proxies `/device-hub/*` (`DEVICE_HUB_PATH`) with T3's
  `DeviceHubProxy.ts` rules: only T3's allowed paths (404 otherwise), checked
  as written and once decoded, since the hub decodes before it routes (an
  encoded `/` or `..` never reaches another route), only its mutable ones
  take a body (405), `devices.read` to watch iOS (its video is HTTP) and to
  take a screenshot (T3's screenshot POSTs read the screen),
  `devices.write` for stream tuning, the fold and every WebSocket but the
  device list's (`/api/devices/ws`). `serve-emu`'s socket carries an Android
  Emulator's video and input together, so watching one needs
  `devices.write`, as T3 needs its operate scope; only the request headers the hub needs travel
  on (an allow-list: never cookies, `Authorization`, the referer that carries
  a ticket, or forwarding headers), an `Origin` is rewritten to the hub's, responses are `no-store,
  no-transform`, WebSockets are relayed frame for frame (text and binary;
  a client 16 MiB behind is closed to reconnect)
  and 503 "Device hub is not running" answers while none runs. A caller
  authenticates with a bearer token (`auth.verifier@1`) or, where a browser
  cannot send one (`<img>`, `WebSocket`), T3's `wsTicket`: `device.hub.access`
  (`devices.read`; starting a hub that is not running takes `devices.write`,
  so watching never installs anything) gives the path and two tickets, a media ticket for the HTTP URLs that can
  only watch (it rides in `<img>` URLs, so in history and logs) and a socket
  ticket for the WebSocket upgrades with the caller's grants that opens one
  socket (a client that reconnects asks for a fresh one), both valid five
  minutes as T3's (the media ticket reusable within them), kept only as a SHA-256 hash and
  stripped before the hub. A ticket keeps the grants it was issued with:
  grants narrowed in place reach it only when it expires; a
  rotated or revoked token drops its tickets and ends its proxied sockets and video feeds
  (security.md D414). In `jhin.device-panel` an open device asks for access
  and shows T3's flat view (`stream.ts`, `DeviceStreamView.tsx`): H.264
  through WebCodecs (iOS from the AVCC feed, Android from `serve-emu`'s
  socket), iOS falling back to MJPEG where WebCodecs or the profile is
  missing, pointer touches and swipes (normalized, as T3 sends them), keys,
  and T3's rail ("Home", "Back" and "Recents" on Android, "Rotate device" on
  iOS) over the hub's input socket; a refused ticket asks for a fresh one,
  and a hub that comes up later is asked again when its status turns
  `ready`.

- **D1209. Input as node commands, through agent-device.** `device.tap`
  (`x`, `y`), `device.swipe` (`from`, `to`), `device.type` (`text`) and
  `device.button` (`home`, `back`, `appSwitcher`) take a thread and a device
  as `device.screenshot` does (`devices.write`): a named device may be any
  booted one of the node, open in the thread or not, as T3's device tools
  pick it; without a name, the thread's latest. Agents reach them over
  RPC, CLI and MCP. Each runs agent-device's own command (`press x y`,
  `swipe x1 y1 x2 y2`, `type`, `home`, `back`, `app-switcher`), pinned as
  T3 pins it (`--platform ios --udid` / `--platform android --serial`)
  before a `--`, so typed text that starts with `-` stays text,
  with T3's per-host endpoint file (written `0600`) as `--config` and a
  session per thread and device (`jhin-<hash>`) as `--session`.
  Coordinates are the device's own, as agent-device's snapshots give them.
  Unverified against the real tools: the argument order (flags, `--`, the
  command) comes from reading agent-device 0.21.25's published CLI parser,
  and the hub's flags and paths from T3; neither package ran here.
  An answer says whether `agent-device` or `adb` (D1207's fallback) did
  it. adb takes an input only when agent-device never got it (agent tools
  that cannot start, a daemon that does not answer before the command, or
  agent-device refusing the arguments with `INVALID_ARGS`, so a wrong
  argument order would not take input down);
  once the command ran, its failure is the command's error, a refusal or a
  daemon that died, so an input is never carried out twice. The panel's touches and rail buttons go over the hub's socket
  as in T3, since a command per pointer move would lag; they are the same
  inputs these commands give.

### The tools' integrity (W37)

- **D1330. The hub's tools install from lockfiles the plugin ships.** T3
  installs `expo-device-hub` and `agent-device` with `npm install
  <package>@<version>`, so their dependencies resolve from the registry at
  install time. The plugin ships one lockfile per pinned tool
  (`plugins/devices/src/locks/<package>/`, imported as JSON modules: a `package.json` that depends on the
  pin and npm's `package-lock.json` for it, every package with its
  `sha512` integrity), and D1206's install copies both into the staging
  folder and runs `npm ci` there: npm installs exactly that tree and fails
  on any download whose hash differs. A lockfile that does not pin the
  version or lacks a hash installs nothing ("…failed while checking its
  lockfile."); T3's step wording stays otherwise. The install scripts still
  run (the hub's `node-datachannel` fetches its native build there), so what
  those scripts download is as trustworthy as their own checks. Bumping a
  pin regenerates its lockfile: in an empty folder with the `package.json`,
  `npm install --package-lock-only --ignore-scripts`, whose output a unit
  test checks against `DEVICE_TOOL_VERSIONS`.

### The device setup (W37)

The reference is T3 Code `eb7b35ac`: `apps/web/src/components/device/{DeviceSetup,DeviceHostUpdates,DevicePanel}.tsx`,
`components/ui/wizard.tsx` and `configure`, `readinessIfSupported` and
`agentReadinessIfSupported` of `apps/server/src/device/DeviceService.ts`.

- **D1328. T3's "Set up devices" wizard is the consent.** The Device panel
  shows T3's wizard until the node's devices are set up: its steps "Device
  hub", "Simulators" and "Agent access" with T3's copy ("Enable the device
  hub", "Check simulator support" with each platform's status and "Check
  again", "Allow agent control", "Leave this off to keep manual device
  controls without giving agents access."), Cancel, Back, Continue (once the
  hub is ready) and Done. Its switches are the node's settings, written with
  `host.config.patch` as T3 writes its server settings: "Enable device hub"
  is `jhin.devices.hub` (D1206), "Allow agents to control devices" the new
  `jhin.devices.agentAccess`, and Done sets the new
  `jhin.devices.onboardingCompleted` and writes agent access as the wizard
  showed it, so a node whose access only followed its hub records the
  user's choice; turning the hub off there also turns
  agent access off, as T3's wizard does (`agentAccessEnabled: false` with
  `enabled: false`). It takes `host.config.write` (T3's
  settings-write scope), and a client without it gets the node's refusal. Turning the hub on starts
  it at once (`device.hub.access`), so the wizard shows T3's "Installing
  device hub…" and "Device hub is ready."; T3's host update rows and their
  failure ("Device support could not start.") show above the steps. The
  `devices` stream and `device.state` carry the setup (`setup`:
  `hubEnabled`, `agentAccessEnabled`, `onboardingCompleted`,
  `agentToolsReady`, additive). Cancel closes the wizard and leaves the
  panel with D1207's screenshots, its notice now offering "Set up devices"
  (with the hub off, or on and the setup not finished);
  Cancel is kept on this device per node, so it is not asked again on each
  visit (T3 has no screenshots to fall back on and closes its panel
  instead). Escape or a click outside closes it for this visit only, so a
  stray click during an install does not decline the setup. A host that
  failed to start shows T3's row with "Retry"; Continue and Done wait for a
  ready hub, as T3's do, so until a Retry succeeds the way out is Cancel.
  A node whose hub was turned on by hand shows the wizard once too, its
  switch already on.

- **D1329. Agents control devices only after they are allowed.** As T3
  installs `agent-device` only when agent access is on
  (`agentReadinessIfSupported`), `device.tap`, `.swipe`, `.type` and
  `.button` go through agent-device only while `jhin.devices.agentAccess` is
  on; off (the default on a node new to the hub), they take D1207's adb path, and an iOS input says
  it needs agent access. The agent tools run while the hub is on and agents
  are allowed: turning either on (the other already on) installs and starts
  them at once ("Installing agent tools…", "Agent tools are ready."), a
  failed install shows as the host's failure with its step, and turning
  either off stops their daemon. The panel's own touches go over the hub's
  socket and need no agent access, as in T3. Unset, agent access follows the
  hub (the owner confirmed this default, 2026-10-23): a node that turned the hub on before this setting existed had agreed
  to agent-device with it (D1206 installed both), so an upgrade takes
  nothing away; the wizard writes the setting whenever it turns the hub on
  or off. The same holds for a hub turned on outside the wizard (the config
  file, `host.config.patch`, a mesh's `mesh.config.patch` to its members)
  with `jhin.devices.agentAccess` left unset: turning the hub on that way
  grants agents too, as D1206's hub did, and whoever writes it sets
  `agentAccess: false` alongside to keep agents out. The wizard shows such a
  node once, its switch on, and Done records the choice. Agents cannot grant
  it to themselves: it is written with `host.config.patch`, whose
  `host.config.write` an agent's credential never holds (`AGENT_PERMISSIONS`,
  providers.md D341). What the setting withholds is T3's: the agent tools
  (agent-device and its daemon), not input itself. With it off, `device.tap`
  and the other input commands, which any caller with `devices.write` may
  run, still reach an Android device through adb as D1207's do, and only iOS,
  which has no adb, has none. "Agent tools are ready" means their daemon was
  started; one that died since is started again by the next input.

### The device tools (W37)

The reference is T3 Code `eb7b35ac`: `apps/server/src/device/DeviceActions.ts`
(with its tests), `DeviceAction*` and `DeviceDetail` of
`packages/contracts/src/device.ts`, and in `apps/web/src/components/device`
`DeviceToolsPanel.tsx`, `useDeviceControls.ts` and the rail's "Device tools".

- **D1332. The node runs T3's device actions itself.** serve-sim's own panel
  sends shell commands over a socket; as T3 does, the node runs the same
  commands typed per action instead (`plugins/devices/src/actions.ts`, T3's
  cases as unit tests): `xcrun simctl ui`, `privacy`, `location`, `openurl`,
  `launch`, `terminate`, `push` and serve-sim's `serve-sim-ax-settings` and
  CLI (found in the installed hub, `vendor/serve-sim/dist`) for iOS; `adb
  shell` settings, `cmd uimode`, `svc`, `pm`, `am`, `monkey` and the
  emulator's sensor and geo commands for Android. `device.detail` (T3's
  `DeviceDetail`: settings and foreground app, `devices.read`) reads them
  back, each value unknown when it cannot be read; `device.action`
  (`devices.write`) takes T3's actions without their target and answers the
  settings read after it. An action the platform lacks, or one whose helper
  is not installed (the hub never ran), fails with the new
  `DEVICE_ACTION_UNAVAILABLE` (`details.reason`: `unsupported` or
  `helper_missing`) before anything runs; a command that fails is
  `DEVICE_OPERATION_FAILED` with its step and exit code, its output only in
  the details. Both take a thread and a device as the input commands do.
  Unlike T3, whose panel is their only caller, these commands reach agents
  too: an app id must look like a bundle id or a package name, and a URL or
  app id goes single-quoted through `adb shell`, which the device's shell
  parses again. An Android permission holds when one permission of its group
  took (an app declares the one of its Android version), and Reset, which
  Android has not, is refused there, as T3's panel offers it on iOS only;
  so is clearing an emulator's location, which T3 answers with nothing, and
  setting a phone's, which only an emulator's console places. Wi-Fi and
  mobile data are two commands, not one: a mobile-data step the device
  refuses leaves Wi-Fi as set, and Wi-Fi failing after data took leaves
  data as set; likewise Reduce Motion on Android is three settings, and one
  failing leaves those before it applied. An action that took but whose
  settings could not be read back answers `readError` (additive) with empty
  settings, and the panel keeps what it last read. iOS's `extra-small` text reads back as small (T3 reads it
  as large). `devices.write` is enough for every action, opening a URL and
  sending a push included, as it is for a tap: they act on the owner's
  simulator or emulator through the host's own tools, which the node
  already runs for the device panel. A
  URL to open must carry its scheme. Turning the network off on Android
  takes when Wi-Fi did: mobile data is turned with it where there is one.
  The node runs one action at a time per device, its read-back included,
  and a `device.detail` read waits behind it, so an agent's and the
  panel's steps do not interleave and no read sees one half done; the
  panel's controls wait for its first read.
  Android's appearance is read from a definite `Night mode: yes` or `no`
  (`auto` follows the clock, so it is not shown). A push payload, as text
  or as JSON, carries at most 4096 characters, as agents send it too. A
  failed step answers `DEVICE_OPERATION_FAILED` with the tool's own output
  (up to 2000 characters, host paths included), as D408's device errors do,
  for a `devices.write` caller of the owner's one trust domain (D22).

- **D1333. T3's tools panel beside an open device.** The rail gets T3's
  "Device tools" toggle (lucide `SlidersHorizontal`), which opens "Tools" at
  the screen's side with T3's sections and copy: App (the foreground app with
  Terminate and Relaunch, Open a URL, Launch an app), Simulator or Emulator
  (Appearance, Text size, Liquid Glass and Color filter on iOS, Orientation on
  Android, and the switches T3 shows per platform), Location (latitude,
  longitude, T3's presets, Set, Clear on iOS), Permissions (an app id, the
  permission, Grant, Revoke, Reset on iOS) and Push notification (iOS). It
  reads the settings when it opens ("Reading device settings…"), runs one
  action at a time, shows the settings each action answers, and an error at
  its top. A setting the node could not read cannot be switched. On iOS the
  node reads no foreground app (as T3's), so there the App section shows
  none and Push notification stays off in the panel; `device.action` sends
  a push to any app id (Deferred).

### Touch and uploads (W34)

Workstream W34 continues this plan with decisions from D1201–D1220. The
reference is T3 Code `eb7b35ac`: the touch handling and the file chooser of
`apps/web/src/browser/ServerBrowserSurface.tsx`, `uploadPreviewStreamFiles`
of `packages/client-runtime/src/preview/serverBrowserStream.ts`, and
`receiveUpload` of `apps/server/src/preview/ServerBrowserStream.ts` with the
probe of `ServerBrowser.ts`.

- **D1203. Touch and the page's file picker, as in T3.** On a touch
  screen a tap on the page clicks it (a move, a press and a release of the
  left button), a pan scrolls it by wheel deltas in page pixels, and a tap
  first asks the node whether the point is editable (`preview.tab.probe`,
  T3's `EDITABLE_AT_POINT_SCRIPT`): the page's hidden input takes the focus
  during the tap when the answer is in (iOS needs that), or as soon as it
  comes (Android), so a soft keyboard comes up only for text; an answer is
  reused within 24 px and 10 s. When a page opens its file picker, the
  viewer holding control sees T3's "The page asks for a file." ("files"
  when it takes several) with "Cancel" and "Choose file(s)", which opens
  this device's picker with the page's `accept`; the chosen files go to
  the node in `preview.tab.upload` (base64, T3's 20 files at most) and
  answer the picker, and Cancel answers it with none. T3 posts up to 100
  MB over HTTP; here an upload is one RPC message, which the WebSocket
  transport takes up to 100 MiB of, so it carries at most 64 MiB. A page
  that retitles itself on the files gets its new title in the tab, as
  after a click. Both commands need the viewer to hold control. The picker
  is taken when an upload starts, so a second one finds none, and given
  back when the files do not reach the page while its input is still
  there, so the user can try again; Cancel sets no files and just closes
  it, as T3's does, and a new document closes the old one's. File data
  that is not base64 is refused. The client converts the files one at a
  time, keeps a name to 255 characters with its extension, and disables
  the dialog while its answer is sent. The gestures are a pure state
  machine (`apps/web/src/plugins/preview/touch.ts`, unit tested) the
  surface runs.

### Downloads to the client (W37)

- **D1331. A page's download is offered to the user, as T3 offers it.** T3
  pushes a saved download to the viewer holding control and shows a toast,
  "Downloaded <file>" with "Save", which fetches it from the node. Here each
  saved download gets an id (`PreviewDownload.id`, additive), and the tab's
  frames stream carries `preview.download` (`PreviewDownloadOffer`: `{ id,
  fileName, sizeBytes }`, exported). The node appends the offer and removes
  it at once, so every viewer watching then gets it (`append` hands an event
  to every subscriber before it returns, an RPC subscription's forwarder
  included) and none that attaches later; each page shows T3's toast only if
  it holds control by its own view of the tab, so when control changes
  hands as the file arrives, the offer may show on neither page. "Save"
  calls `preview.tab.download { threadId, tabId, id }` (`preview.control`)
  → `{ fileName, data }` (base64), and the page decodes it in chunks and
  hands the file to the browser's download; a second click while one Save
  runs adds nothing, and a failed Save leaves the toast up to try again. A
  download travels in one RPC message, as an upload does (D1203), so it
  carries at most 64 MiB: encoded, about 85.4 MiB, under the 100 MiB a
  message may carry on the node's and the mesh's WebSockets (`ws`'s
  `maxPayload`). Save reads the file as it is then, with that bound in the
  read itself: one larger, or still growing past it, stays on the node for
  the agent and Save says it is too large for this client; one removed
  answers `PREVIEW_TAB_NOT_FOUND`, as does one the node dropped beyond the
  20 it keeps (a file it cannot remove is logged). A Save holds the file
  and its base64 in the node's memory and the base64 and the decoded bytes
  in the page's, once per Save. The user's own navigation to such a file
  (the address bar, back, forward, reload) is no failure: the page stays,
  and the file is offered. A download Playwright reports but cannot save is
  logged on the node and not offered.

### A device as a surface of the right panel (W40)

W40 of `t3-roadmap.md` (round 5) takes D408's leftover with a number from its
range, at T3 Code `eb7b35ac`: `rightPanelStore.ts` (`openDevice`, the
`device` surface and `dismissedDeviceSurfaceIds`),
`components/RightPanelTabs.tsx` (the device tab's icon) and
`components/device/DevicePanel.tsx` in its embedded mode.

- **D1427. Each open device is a surface of the right panel, beside browser
  tabs,** as in T3. The `devices` surface (T3's `device`, "Device", M in
  "Add panel surface") lists the node's devices; opening one there turns it
  into that device's surface `devices:<hostId>:<deviceId>`, as T3's
  `openDevice` replaces its placeholder, and an already open device's
  surface shows instead. A device's tab is its name with T3's platform icon
  (Apple, Android); its body is D408's screen with "Power off device" and
  "Close device panel". Each device an agent opens for the thread on
  screen adds and shows its surface (`jhin.device.reveal`; the last one
  opened shows; a thread off screen gets none, as the panel opens surfaces
  through the route), unless the user closed that
  device's surface before: T3's dismissed devices, kept per thread on this
  device, so an agent cannot bring back what the user put away; opening it
  by hand again (from the `devices` list) forgets that. A device's surface
  whose device is gone shows the list, as T3's `DevicePanel` does, and a
  device picked there opens beside it. Closing a device's surface leaves
  the device running, as T3's does. T3's renaming of a device's tab and its tooltip
  (host · version) wait (Deferred).

### Device hosts over SSH (W43)

Workstream W43 of `t3-roadmap.md` continues this plan with decisions from
its range D1481–D1500 (the desktop app's take D1481–D1493 in `desktop.md`).
The reference is T3 Code `eb7b35ac`: `apps/server/src/device/SshDeviceHost.ts`,
`sshDeviceScript.ts`, `localSshDeviceHost.ts`, `DeviceHost.ts`, the hosts'
parts of `DeviceService.ts` and `DeviceMultiHost.test.ts`, and
`apps/web/src/components/settings/DeviceHostsSettings.tsx` with
`DeviceHostEditor.tsx`.

- **D1494. Device hosts are T3's `deviceHosts`, a setting of
  `jhin.devices`.** `jhin.devices.sshHosts` lists T3's
  `SshDeviceHostConfig`: `id` (letters, digits, `_` and `-`, not `local`,
  unique), `label`, `target` (`user@host` or an SSH alias, not starting
  with `-`), and optional `identityFile` and `port`. As in T3, a host that
  resolves to this machine (`ssh -G` without a proxy, on port 22, whose
  addresses are all this machine's, `localSshDeviceHost.ts`) is skipped:
  its devices are the local host's. `DeviceHostSummary.kind` gets `"ssh"`
  (additive), and the hosts list, the `devices` stream's `hostStatuses`
  and every device's `hostId` name SSH hosts beside `local`. As with the
  local hub (D1206), nothing is installed or started on any host until
  the user turns the device hub on (`jhin.devices.hub`): that is the
  consent for the remote hosts too.

- **D1495. A host runs T3's remote script, with Jhin's lockfiles.** The
  node runs `ssh [-p port] [-i identity] -o BatchMode=yes <target> sh -c
  '<T3's environment> exec node'` and sends T3's script on stdin
  (`plugins/devices/src/ssh-script.ts`, from `sshDeviceScript.ts`), in one
  of T3's modes: `probe` (Node 22+, npm, and which platforms the host can
  run, with T3's reasons: "iOS needs macOS with Xcode and working xcrun
  simctl.", "Android SDK missing. Set ANDROID_HOME or put adb on the SSH
  PATH."), `start` (the hub), `agent-start` (the hub and agent-device's
  daemon), `stop-agent` and `stop`. Unlike T3, which runs
  `npm install <package>@<version>`, the script installs each tool with
  `npm ci` from the lockfile the plugin ships (D1330), sent inside the
  script, into `~/.jhin/tools/<package>/<version>` on the host with T3's
  sentinel, lock and staging. Its state is `~/.jhin/device/hosts/<owner>`,
  where `owner` is T3's: the first 24 hex digits of SHA-256 over the
  node's id, its home and the host's id. A probe has 45 s; a start, which
  may install, has T3's 1 300 s.

- **D1496. The hub and the daemon are reached through T3's tunnels.** Once
  the script has started them, the node reserves two loopback ports and
  runs `ssh -N -L 127.0.0.1:<port>:127.0.0.1:<remote>` for the hub (and
  the daemon), on a connection of its own (`ControlMaster=no`,
  `ControlPath=none`, `ExitOnForwardFailure=yes`, `ServerAliveInterval=10`,
  `ServerAliveCountMax=3`). It waits for the hub's `/readyz` (and the
  daemon's `/health`) through the tunnel, at most 15 s, and tries fresh
  ports twice when the forward cannot bind. Every 10 s it checks both.
  When the tunnel exits or a check fails, the host's status turns to
  `starting` with "Reconnecting to device host…", and the node connects
  again after 1 s, doubling to at most 30 s, with `failed` and the error
  between attempts, as T3's `SshDeviceHost` does. Deactivating the plugin,
  turning the hub off or removing the host closes the tunnel and runs the
  script's `stop`. Devices keep running: the user owns those.

- **D1497. An SSH host's devices go through its hub, as in T3.** The list
  is the hub's `/api/devices` (simulators and emulators), with the AVDs of
  `emulator -list-avds` run on the host when Android is available. Booting
  is `/api/devices/boot` (iOS also `/vendor/serve-sim/grid/api/start`),
  power off is `/api/devices/shutdown` (iOS `/vendor/serve-sim/grid/api/shutdown`),
  and a screenshot is the vendor's `/api/screenshot`. The commands take
  their `hostId` (absent: `local`, as before), and a session keeps its
  host. One host that fails leaves the others listed, with its own
  `failed` status. `device.list { retryHostId }` (T3's) tries a failed host
  again. `device.open`'s answer for a device of an SSH host names the
  `ssh … adb -s <serial>` or `xcrun simctl … <udid>` invocation pinned to
  it.

- **D1498. The node's proxy reaches every host's hub (D1208).**
  `device.hub.access { hostId }` starts that host's hub as for the local
  one and answers its tickets with `hostId` in both queries, so the
  client's URLs carry it. The proxy sends a request with `hostId` to that
  host's tunnel, and one without it to the local hub. The tickets, the
  allowed paths and the permissions are D1208's for every host.

- **D1499. Input and the device tools run on the host.** `device.tap`,
  `.swipe`, `.type` and `.button` on an SSH host's device run
  agent-device's CLI there over SSH with D1209's arguments, against the
  daemon the script started (`--state-dir` of the host's state).
  Otherwise they run `adb shell input` there, as D1207 falls back.
  `device.detail` and `device.action` run their `adb` and `xcrun` there
  too (T3's `ready.run` over `runSshCommand`), and serve-sim's helpers are
  the paths the script reports.

- **D1500. T3's "Device hosts" in the settings.** The Devices settings get
  T3's row "Device hosts" ("Add remote machines with simulator or emulator
  runtimes installed, and the selected environments will connect over SSH
  and set up device tools automatically.", "Add host"). Each host is
  listed with its label, target, "iOS available" / "Android available",
  its progress ("Installing device support…", "Connecting…"), a failed
  connection's details, "Edit", "Remove", and "Test connection" or
  "Retry". The dialog is T3's "Add device host" / "Edit device host": "Name"
  (placeholder "Mac mini"), "SSH target" ("user@host or SSH alias"), and
  "SSH options" with "Identity file" and "Port". "Test connection" is the
  command `device.hosts.test` (`devices.write`, T3's connection check),
  which answers `connected` with the host's platforms and tool versions,
  `local` ("Already available locally"), or `failed` with the error.
  Saving writes `jhin.devices.sshHosts` through `host.config.patch`. One
  node is one environment here: T3's grouping of several environments'
  hosts is not ported.

### The preview's tools in the work log (W47)

- **D1681. The work log names the preview's tools as T3 does** (T3's
  `t3McpToolPresentation.ts` and `work-log/presentation.ts`). A client
  plugin describes the node commands it owns through a new client capability,
  `chat.tools@1` (`ChatTools.describe(command, presentation)`, a disposable,
  provided by `jhin.chat`): T3's four labels (action, running, completed,
  detail) and a group. A tool call is a command's when its name is the
  command's MCP tool (`preview_click` for `preview.click`) behind the node's
  `jhin` server, with any of the agents' prefixes (Claude's `mcp__jhin__`,
  Codex's `jhin.`, OpenCode's `jhin_`). Its row then reads as T3's:
  "Clicking in the preview browser" while it runs, "Clicked in the preview
  browser", "Failed to click in the preview browser", "Declined to click in
  the preview browser", with the group's icon. `jhin.preview-panel` describes
  the agent's browser tools with T3's labels (its `preview_*`, and
  `t3_preview_list` and `t3_preview_close` for `preview.list` and
  `preview.close`) in the group `browser`; `jhin.device-panel` describes
  T3's `device.list`, `device.open`, `device.screenshot` and `device.close`
  and, in the same group `device`, the input and detail commands T3's agents
  reach through `agent-device` instead (`device.tap`, `device.swipe`,
  `device.type`, `device.button`, `device.action`, `device.detail`); `jhin.html-render-view` describes `html.preview` and
  `html.render` in groups of their own.
- **D1682. A group's summary counts its calls**, as T3's
  `summarizeT3ToolCalls`: "Used browser 3 times", "Used device controls 2
  times", "Previewed 1 HTML page", "Rendered 2 HTML pages". It counts the
  calls that completed when any did, and says "Tried to use browser 2 times"
  when none did. The group takes the place of the "Used N tools" those calls
  fell into, with the same priority among a summary's two parts. A summary
  whose calls are all of one group shows the group's icon (T3's
  `toolGroupSummaryKind`), unless one failed.

### A rendered page's policy (W47)

- **D1689. A rendered page runs under a content security policy in the
  reader's client.** T3 lets a page's scripts load from any host, so a page
  in the timeline could also read from the reader's own loopback (the
  node's address) and network. The web client puts a `<meta
  http-equiv="Content-Security-Policy">` first in the page it gives the
  frame's `srcdoc` (after any doctype, so the page keeps its mode): the
  page's inline code and `eval`, and scripts, styles, images, fonts and
  media over HTTPS (or `data:` and `blob:`); `connect-src https: data:
  blob:` (`https:` also admits `wss:`); no plugins or `<base>`, and no
  embedded frames (`frame-src 'none'`: a page an agent renders draws its
  content itself, and a frame of another site would bring that site's own
  rules).
  Forms are shut too (`form-action 'none'`): a submission would navigate the
  frame to wherever its action names, so only a form a script handles
  (`preventDefault`) works, though the frame keeps D407's `allow-forms`. So the
  page can neither load a subresource nor read a response over plain HTTP
  or `ws:`: nothing on the reader's loopback or on a device of the
  reader's network that serves plain HTTP. A page's own policy can only
  narrow it. The page is unchanged in the thread's stream, and the node's
  measuring (D405, D406) keeps its proxy, which reaches public addresses
  only. What a policy cannot stop stays in Deferred: a host that serves
  HTTPS on a private address, and the frame navigating itself (a GET whose
  answer the page never reads).

### Local servers pushed (W47)

- **D1692. The node pushes the local servers to the panels that watch
  them,** as T3's `subscribeDiscoveredLocalServers` does, instead of each
  panel asking every 3 s. `jhin.preview` serves the streams
  `preview-servers/<configured URLs>` (`previewServersStream`, in
  `@jhin/preview-api`: the project's configured preview URLs, sorted, as
  URI-encoded JSON, so a name says what it lists; `preview.read` and
  `terminals.read`, as `preview.servers.list`). While any of them has a
  subscriber, the node scans every 3 s (T3's `POLL_INTERVAL`), once per set
  of configured URLs, with the scan `preview.servers.list` shares, and
  appends `preview.servers { servers, scannedAt }` to a stream only when
  its list changed; a new subscriber gets a scan at once (T3's `retain`),
  and a tick during a scan is skipped. A stream keeps its latest list only,
  so a subscriber from 0 reads it first; one nobody watches forgets it, and
  the scanning stops with the last subscriber. Sequences only grow, from the
  clock (the next is the later of the last one plus one and the time in
  milliseconds), so a client that resumes after the last list it saw, past
  a reconnect or a restart of the node, never takes a new list for an old
  one. At most 20 sets of configured URLs are watched at once (each costs a
  scan a tick); a 21st subscription is refused. The panel's empty state
  subscribes while it shows and the page is visible, and unsubscribes when
  the page is hidden.
- **D1693. A node without the stream is polled as before.** When the
  subscription is refused (a node older than D1692), or the thread's node
  is reached through another (a mesh member), the panel falls back to
  D950's polling of `preview.servers.list` with its backoff.
  `preview.servers.list` stays, for agents and those clients.

### Proof

- **D409. Tests drive a real headless Chromium** (the one CI installs for
  Vitest browser mode): the browser plugin's tests serve pages from a local
  HTTP server and wait for page events, the stream's frames or command
  results, never for time. The device plugin's tests run against fake `adb`,
  `emulator` and `xcrun` scripts, and the device hub's (D1206–D1209) against
  a fake npm that installs a fake hub (HTTP and WebSocket echo) and a fake
  `agent-device` that logs its arguments: CI has no simulators or emulators,
  so the hub's path is proven end to end against the fakes, the stream
  client by T3's `stream.test.ts` cases, and the panel by an e2e whose fake
  hub serves serve-sim's MJPEG feed and input socket. The panel and the timeline frame are proven
  with Playwright e2e against `jhin serve --ui`, with role locators and
  screenshots in the pull requests.

## Deferred

- Of T3's desktop runtime, beside its webview per tab (`desktop.md` D1321–D1324),
  its DevTools (D1489), its annotation's Select, Region, Draw and Erase tools
  (D1491, `desktop.md` D1690) and its separate window (D1493): the
  annotation's style panel and source lookup (`desktop.md`'s Deferred) and
  "Open in {environment}'s browser".
- Of the cookie import (D1204, D1205): opening the node's System Settings
  at Full Disk Access and watching for the grant (T3's `SafariPermission`
  and `checkSystemPermission`; a browser client cannot reach the node's
  Mac); asking the macOS keychain in the node's own name (T3's in-process
  `@napi-rs/keyring`, so the prompt names the app rather than `security`);
  T3's libsecret helper with its exit codes (`secret-tool` tells a locked
  keyring only by its message); KWallet keys of Chromium browsers started
  with `--password-store=kwallet*` (T3 reads libsecret only); and flushing
  a running profile's cookies to disk at once (T3's `flushStore`;
  Playwright has no call, so Chromium writes them on its own schedule or
  when the profile closes); an import that answers at once and is followed
  to its end, for callers relayed through the mesh, whose calls end after
  30 s.
- A test of the pinned browser's progress answer itself: it needs the
  install a test leaves running to be awaitable once it settles.
- T3's host setup hints for the pinned browser (the AppArmor profile, the
  missing libraries and their setup command, close code 4503).
- A binary channel for frames (T3's WebSocket with per-frame acks); frames
  travel as base64 JSON events.
- A favicon per local server (configured URLs: D1480); the pushed list
  (D1692) reaching a mesh member's servers through the relay instead of
  D950's polling.
- Tests of the panel's local server polling (backoff, the hidden-page pause)
  and of the node's shared scan; the e2e covers the path end to end.
- Around the floating mini player (D1202, D1326, D1327): keeping it clear
  of T3's inline thread details card (with that card, W38): the layout keeps
  T3's card branches as T3 wrote them, unused until the thread view passes a
  card, and its own card cases come with it; a floating device (`jhin.device-panel` shows devices in a panel of its own);
  the control strip inside the player (control is taken in the panel);
  moving and resizing the player from the keyboard (T3's are pointer only
  too); dropping a deleted thread's floating entry, which stays in the
  plugin's memory for the session (one small record per thread).
- Downloads and uploads above 64 MiB (D1203, D1331): a binary channel or an
  HTTP route for them, which also spares the node and the page holding a
  Save's file and its base64 at once, and bounds Saves running together.
- T3's in-tab state for a navigation that became a download (D1331).
- Offering a download again to a viewer that attaches after it, or to the
  viewer that took control as it arrived (D1331): the tab's downloads in
  its state, and the offer addressed by the node to the controller.
- The floating player keeping clear of W38's inline details card (D1326,
  D1350): the layout already takes T3's `detailsCard` and returns
  `overlapsDetailsCard` (with `data-preview-overlaps-chat`, kept as T3's);
  the card's rectangle is not passed to it yet. Until then the player may
  sit over the card, and the lane's end moves in by the larger of the two
  insets, which holds only while they do not stand side by side.
- More than one player on the chat canvas at a time (D1326): the last to
  report is the one laid out, as in T3.
- A popped-out window of a remote node's tab following that tab (D1327):
  a remote thread has no tab feed here, so its window closes when the tab's
  frames stream ends rather than as the tab goes.
- A right-to-left chat canvas (D1326): the layout places the player and
  moves the lane in left-to-right terms, as T3's does.
- `preview.pop-out` from RPC, the CLI or MCP (D1327): the browser opens
  the window only during a user's gesture, so the command refuses without
  one and works from the palette or a keybinding only.
- The picture-in-picture window proven in Safari and Firefox (D1327): it
  asks as T3 does, after `play()` and the metadata, and only Chromium runs
  the tests.
- Reading password values in isolated worlds of out-of-process frames: Jhin
  reads them in each frame's own world.
- T3's outline of a rendered page's boxes for the loading skeleton.
- Rendered pages in an attachment store (W6's blobs) instead of the
  thread's event log, and with it T3's 25 MiB pages.
- What D1689's policy cannot stop: a rendered page reaching the reader's
  network over HTTPS (a policy names schemes and hosts, not address
  ranges), and the page's frame navigating itself to a plain-HTTP address
  (`location`, a meta refresh or a link: a GET whose answer the page cannot
  read; a policy does not govern a frame's own navigation). An MCP app's
  frame (`providers.md` D1403) gets no such policy either.
- In a rendered page: T3's image viewer for a clicked image and passing the
  app's shortcuts through a focused frame.
- Viewer ids bound to their caller or their frame subscription (D397).
- Devices, beside the hub (D1206–D1209):
  - Of the device hosts over SSH (D1494–D1500): T3's tool versions and their
    updates on a host, pruning old tools there and its `deviceToolMaintenance`
    script; `device.open` pointing agents at the host through T3's
    `AgentDeviceShim` (it names the `ssh … adb`/`xcrun` invocation); T3's
    grouping of several environments' hosts in the settings (one node is one
    environment here); the Devices settings' compact per-machine view; a
    changed `jhin.devices.ssh` taking effect before the plugin restarts; a
    run against a real Mac or Android host over SSH (CI runs the host's side
    on its own machine through a fake `ssh`).
  - Pinning what the install scripts download (the hub's `node-datachannel`
    native build): `npm ci` pins the npm tree only (D1330).
  - T3's `canConfigure` in the setup wizard (D1328): its switches disabled
    for a client without the settings-write scope. The web client cannot
    read its own permissions yet, so such a client sees the wizard and gets
    the node's refusal of `host.config.patch` in a toast.
  - Of T3's device tools (D1332, D1333): the accessibility frames overlay
    and the event log (they read the hub's own routes), and the device
    tools' versions popover.
  - Reading an iOS simulator's foreground app (D1332, D1333): T3's
    `readDeviceDetail` gives none on iOS, so its panel, and this one, offer
    no Terminate or Relaunch there, no default app for Permissions, and
    Push notification waits for an app id.
  - Proving `simctl location set` with a negative latitude on macOS
    (D1332): the argument is T3's `<lat>,<lon>`, and CI has no simulator to
    show simctl does not read a leading `-` as an option. Shaking a device,
    which T3's panel has no tool for, is not offered.
  - The tool versions view and updating tools from the panel
    (`deviceToolMaintenance`), and `device.open` pointing agents at the
    `agent-device` shim with `--config` and `--session` (T3's
    `AgentDeviceShim`): it still gives D408's `adb`/`simctl` invocation, and
    the input commands carry agent-device's taps and text.
  - T3's 3D phone models, the iPhone Duo's panels and hinge, Android fold
    controls and the keyboard accessory: only the flat view is ported.
  - Physical iOS devices (agent-device's XCTest runner on a device).
  - A device tab's renaming ("Rename", a double click) and its tooltip with
    the host and the version (D1427).
  - A device an agent opens for a thread that is not on screen gets no
    surface (D1427): the right panel opens surfaces through the route, and
    `jhin.device.reveal` watches only the thread on screen.
  - Hub tickets that follow a caller's grants as they change: the node keeps
    no token to verify again, so a ticket keeps its grants for its five
    minutes, as T3's does.
  - Removing older tool versions no node of the home runs any more (D951
    removes its old browsers; a hub may run from an old version).
  - Proving that the process answering on the hub's port is the hub the node
    started: the port is reserved and freed before the hub binds it, as T3
    does, so a local process that takes it first would get the proxied
    traffic. Reaping a hub orphaned on Windows, where there is no `ps` to
    tell it from a recycled pid.
  - A supervisor that restarts an exited hub with T3's backoff; here the next
    request starts it.
  - Taps and swipes on D408's screenshots when the hub cannot run; the
    commands still work then.
  - A test of the panel decoding real H.264 through WebCodecs: the fake hub
    cannot encode video, so the e2e takes the MJPEG feed (no WebCodecs) and
    the H.264 parsing is proven by T3's stream unit cases.
  - A run of the pinned `expo-device-hub` and `agent-device` on a Mac with a
    simulator and on an Android emulator, by the owner before relying on the
    hub and again with every pin bump: the proxy's allow-list follows T3's
    route names and the input follows agent-device's CLI, both read from the
    packages, not run (CI has neither).

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

- `@jhin/preview-api` gains `device.hosts@1`; `jhin.devices`
  (`plugins/devices`) with `device.list`, `device.open`, `device.screenshot`
  and `device.close` and the `devices` and `device/…` live streams;
  `jhin.device-panel` in the web client.
- **Done when:** tests against fake `adb`, `emulator` and `xcrun` list
  simulators and emulators (AVDs not running too), refuse an ambiguous open,
  boot an AVD into its serial for a thread with its quick start, take its
  screen through the command and the stream, power it off, boot an iOS
  simulator and give a platform's reason when its tools are missing;
  Playwright sees the panel's list, the screen of a device an agent opened
  and powers it off.

### PR 5 — The device hub (W34)

Implements D1206–D1209.

- `jhin.devices` installs and runs T3's pinned `expo-device-hub` and
  `agent-device`, proxies the hub at `/device-hub` (`device.hub.access`
  for the path and a ticket) and takes input (`device.tap`, `device.swipe`,
  `device.type`, `device.button`); `jhin.device-panel` streams an open device
  with T3's flat view and rail, D408's screenshots as the fallback.
- **Done when:** a fake npm installs the hub once (staging, sentinel,
  version, a failed install leaving nothing), the hub starts on loopback and
  stops with the plugin, the proxy refuses a missing or wrong credential and
  forwards requests and a WebSocket to the fake hub without the node's
  credentials, the input commands reach a fake agent-device pinned to the
  device and fall back to adb; T3's stream unit cases pass; Playwright sees
  an open simulator stream from the fake hub and its touches and Home reach
  it.
