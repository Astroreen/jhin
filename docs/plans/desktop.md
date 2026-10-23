# Desktop plan

Status: **in progress** (workstream W18 of `t3-roadmap.md`). This file records
how Jhin ships T3 Code's desktop app: an Electron shell that runs a local node
and the web client, with T3's window chrome, native menus, notifications and
auto update. It takes the Electron item off the Deferred list of
`foundation.md` (D21 named Electron "a fourth packaging of the same client").

## Goal

Install one app, open it, and use Jhin as T3 Code's desktop app is used: the
app starts a node on this machine, shows the web client in a frameless window
with native controls, has the native menus, a dock or taskbar badge for
threads that need the user, and updates itself from this repository's GitHub
releases. Nothing desktop-only is a special case in the web client: the shell
talks to a client plugin, `jhin.desktop`, through a small bridge, and the
plugin uses the public API (slots, commands, capabilities) like any other.

The reference is T3 Code nightly `eb7b35ac` (D53): `apps/desktop/src`
(`window/DesktopWindow.ts`, `window/DesktopApplicationMenu.ts`,
`updates/DesktopUpdates.ts`, `updates/updateMachine.ts`,
`updates/updateChannels.ts`, `ipc/methods/notificationBadge.ts`, `preload.ts`)
and in `apps/web` `components/sidebar/SidebarUpdatePill.tsx`,
`components/desktopUpdate.logic.ts`, the About section of
`components/settings/SettingsPanels.tsx`, `lib/windowControlsOverlay.ts`,
`threadNotifications.ts` and the `.drag-region` / `.wco` rules of `index.css`.
Derived files name their origin and are covered by `THIRD_PARTY_NOTICES.md`.

## Decisions

- **D510. Scope.** Ported: the shell and its local node, the window and its
  chrome, the application and context menus, external links, the
  notification badge, auto update with its UI, a single instance and renderer
  recovery. Not ported, and why: the browser preview, its devices and
  recordings (W12 owns them), WSL and SSH backends (a Jhin node on another
  machine is a mesh member, not a backend of the app), T3 Connect, Clerk and
  passkeys (T3's hosted service, out of scope for the roadmap), screen
  captures ("snapshots"), telemetry, the `t3` CLI shim and importing browser
  cookies (Deferred below).

- **D511. `apps/desktop` is the package `@jhin/desktop`** (private), an
  Electron app on Electron 44, T3's major. The main process and the preload
  are TypeScript bundled by Vite (`vp build`) into `dist/`: the main process
  as one ES module (`vite.config.ts`), the preload as one CommonJS file
  (`vite.preload.config.ts`), because a sandboxed preload can be
  neither an ES module nor `require` anything but `electron`. The product name
  is "Jhin", the app id `io.github.astroreen.jhin`.

- **D512. The local node is a child process: the CLI's `jhin serve --ui`**,
  run by Electron's own Node (`ELECTRON_RUN_AS_NODE=1`), so the app needs no
  Node on the machine, as T3's backend runs. Its home is the CLI's
  (`$JHIN_HOME` or `~/.jhin`): the app and `jhin` on the command line are the
  same node with the same threads, as T3's app and server share `~/.t3`. The
  shell waits for the node to print its `ui:` line, reads the node's token
  from the home, and on quit stops the node with `SIGTERM` and waits for it
  to exit. A node that fails to start is shown in a native dialog with its
  last output, offering to try again or quit; one that exits while the app
  runs comes back by itself (D1201).

- **D513. The window loads the node's own address** with the token in the
  fragment (`http://127.0.0.1:7777/#token=…`), exactly as a browser opens
  `jhin serve --ui`. The port is the node's `jhin.http.port` (7777 unless
  configured), so the page's origin, and with it this device's settings and
  saved connections in `localStorage`, stay the same across launches. T3
  serves its client from a custom protocol instead; Jhin's client comes from
  the node with its client plugins and their change events (D16), so the
  node's origin is the page's.

- **D514. Desktop behaviour is the client plugin `jhin.desktop`**
  (`plugins/desktop`, side `client`), served by the app's node only: the
  shell starts the node with the CLI's new `--plugin-dir <dir>` option, which
  adds a plugin location of the dev layer (D15). A browser that opens the
  same node from elsewhere never gets the plugin. The web client has no
  Electron checks. The plugin reaches the shell through a bridge the preload
  puts on `window.jhinDesktop` with `contextBridge` (D521) and provides it to
  other client plugins as the capability `desktop.shell@1`. A browser runs
  only JavaScript, so this plugin's manifest names its built
  `dist/index.js` also in the workspace (D10 lets a packed package do so);
  its imports are the shared packages of the import map (D16), and the web
  client's Tailwind build scans its sources so its classes exist.

- **D515. Window chrome is T3's.** On Linux and Windows the window has no
  frame: `titleBarStyle: "hidden"` with a 40px transparent
  `titleBarOverlay` whose symbols follow the light or dark theme; on macOS
  `hiddenInset` with the traffic lights at x 16, centred in the 52px top bar.
  At least 840 × 620, hidden until the first paint, the background colour of
  the theme, the title always "Jhin", the bounds and maximized state kept in
  the app's data folder (written 500 ms after the last move or resize, and on
  close) and restored when they fit on a connected display. The web client
  marks its top bars with T3's `drag-region` class and keeps their controls
  clear of the native buttons with `wco:` insets; `@jhin/ui` ships T3's
  `.drag-region` and `.wco` rules, which do nothing in a browser. The plugin
  sets T3's `electron` and `electron-windows` classes, the `wco` class while
  the window controls overlay is visible, and on macOS moves
  `--workspace-controls-left` past the traffic lights unless the window is
  full screen. Tooltips keep clear of the overlay, as T3's do
  (`useNativeTitlebarHeight` in `@jhin/ui`, from the standard
  `navigator.windowControlsOverlay`).

- **D516. The application menu is T3's template.** On macOS the app menu
  (About, Check for Updates..., Settings... ⌘,, Services, Hide, Hide Others,
  Show All, Quit); File (Settings... Ctrl+, and Quit elsewhere, Close on
  macOS); Edit (undo, redo, cut, copy, paste, delete, select all, Speech on
  macOS); View (Reload, Force Reload, Toggle Developer Tools, Actual Size,
  Zoom In, Zoom Out with the keypad variants, Toggle Full Screen) acting on
  the main window's contents only, zoom in steps of half a level; Window;
  Help (Check for Updates...). An item that acts in the web client sends a
  command name to the renderer, where the plugin runs it: Settings... runs
  `settings.open`. Plugins add items with stable ids through
  `desktop.shell@1` (`menu.contribute({ id, menu, label, command,
  accelerator? })`, a disposable) to the File, View or Help menu; the shell
  rebuilds the menu when they change.

- **D517. The context menu and links are T3's.** Right click shows up to
  five spelling suggestions (or "No suggestions"), Copy Link for an http(s)
  or mailto link, Copy Image for an image, then Cut, Copy, Paste and Select
  All as the page allows. A link that opens a window, or a navigation away
  from the node's origin, opens in the system browser (http, https and mailto
  only) and never in the app.

- **D518. Notifications are the web client's, with a native badge.** The
  web client's thread notifications (`jhin.notifications`) use the
  Notification API, which Electron shows as native notifications. The count
  of notifications shown becomes public as the capability
  `client.notifications@1` (`count()`, `subscribe(listener)`), and the
  desktop plugin mirrors it into the app's badge as T3 does:
  `app.setBadgeCount` on macOS and Linux, an overlay icon with T3's drawn red
  badge on Windows; zero while a window of the app has focus, and cleared
  when one gains focus or the app quits.

- **D519. Auto update is T3's flow on electron-updater against this
  repository's GitHub releases** (`provider: github`, owner `Astroreen`,
  repo `jhin`), which packaging writes into the app's `app-update.yml`
  (D943); a build without that feed shows updates as disabled with T3's
  "no update feed" reason. The state machine is T3's (`updateMachine.ts`): `disabled`,
  `idle`, `checking`, `up-to-date`, `available`, `downloading`,
  `downloaded`, `error` with the available and downloaded versions, progress,
  the error's context and whether it can be retried. Nothing downloads by
  itself: the first check runs 15 s after start, then every 4 minutes; the
  user downloads, then installs, which stops the node and restarts the app
  (`quitAndInstall`, silent, run after). Two tracks, Stable (`latest`) and
  Nightly (prereleases whose version is `x.y.z-nightly.YYYYMMDD.N`), chosen in
  the settings and kept in the app's data folder; switching checks at once and
  may go back to an older version. Updates are disabled, with T3's reasons,
  without an update feed, in a build that is not packaged, with
  `JHIN_DISABLE_AUTO_UPDATE`, or on Linux outside the AppImage and the .deb.
  `JHIN_DESKTOP_UPDATE_FEED` points a build that is not packaged at a
  generic feed (T3's mock updates); tests use it. A packaged app ignores it,
  so nothing that launches the app can redirect its updates.

- **D520. The update UI is T3's.** The sidebar footer gets T3's update
  control (the contribution `desktop.update` in `sidebar.footer`): an icon
  button named by T3's tooltip text, "Check for updates" while there is
  nothing to do, then "Update 1.2.0 ready to download", "Downloading update
  (40%)" with its progress ring, "Update 1.2.0 downloaded. Click to restart
  and install." and the failures with "Click to retry". A finished download
  shows T3's "Update downloaded" toast with a link to the release. Installing
  asks first, in a `ui.dialogs` confirmation with T3's text ("Install update
  1.2.0 and restart Jhin?", "Any running tasks will be interrupted. Make sure
  you're ready before continuing."). Settings get T3's About section (`about`):
  "Version" with the app's version and a button that checks, downloads or
  installs, and "Update track". The menu's Check for Updates... answers in
  native dialogs ("You're up to date!", "Update check failed", "Updates
  unavailable"). Every action is a client command with Zod schemas:
  `desktop.update.state`, `desktop.update.check`, `desktop.update.download`,
  `desktop.update.install` and `desktop.update.channel.set`.

- **D521. The bridge is small and checked on both sides.** The preload
  exposes `window.jhinDesktop` with a `version` (1), the platform and the
  app's version (one synchronous message when the page starts), and
  functions over IPC channels named `jhin-desktop:*`: update state, actions
  and changes, the menu's command requests, menu contributions, the badge
  and the full-screen state. The contract and its Zod schemas are
  `@jhin/desktop-api`; the channel names are a module of their own
  (`@jhin/desktop-api/channels`), so the preload stays a few kilobytes
  without Zod. The main process validates every payload and answers only the
  main window's top frame on the node's origin, except the synchronous app
  info the preload reads before the page exists (the platform and the
  version, nothing else).

- **D522. One instance, recovered renderers, a clean quit (T3).** A second
  launch focuses the running app's window. A renderer that crashes, is
  killed or runs out of memory is reloaded after 500 ms, at most three times
  a minute. Quitting stops the node first (SIGTERM, then SIGKILL after 5 s);
  installing an update does too.

- **D523. Proof with Playwright's Electron support.**
  `e2e/tests/desktop.spec.ts` starts the built app with `_electron.launch` in
  a fresh home with the fake agent and an update feed the test serves, and
  checks the window, the node, the menus (also an item a user client plugin
  adds through `desktop.shell@1`), the plugin, the badge and the update flow
  through the accessibility tree. xvfb has no window manager, so the badge
  test plays the window system: no window has focus, then one gains it. CI
  runs the suite under `xvfb-run`, installs Electron's binary itself (a
  cached install may lack it) and lets Electron's sandbox use user
  namespaces; a local run without a display skips these tests. The update
  controller, the menu template and the settings file have unit tests
  without Electron.

### Packaging and releases (W25)

Workstream W25 of `t3-roadmap.md` continues this plan with the decision
range D941–D960 (the range `t3-roadmap.md` first gave it, D720–D739, belongs
to A6 and A7 in `agents.md`). The reference stays T3 Code `eb7b35ac`:
`scripts/build-desktop-artifact.ts`, `.github/workflows/release.yml` and
`release-desktop.yml`.

- **D941. W25's scope and order.** W25 lands as small PRs, one at a time:
  packaging, signing and the release workflow first (so D519's feed exists),
  then the app's smaller T3 pieces (release notes in the update control,
  Paste as Text, the quit-hold shortcut), then the preview's leftovers of
  `preview.md`. What a PR leaves stays in the Deferred lists below and in
  `preview.md`.

- **D942. Packaging stages the app from packed tarballs.**
  `scripts/package-desktop.ts` (`pnpm package:desktop`) builds the main
  process and the preload, packs `jhin-ai` and `@jhin/plugin-desktop` with
  every workspace package they need through `scripts/pack.ts` (as
  `pnpm pack:smoke` does), installs them into a staged app outside the
  workspace with the third-party versions of `pnpm-lock.yaml` and a flat
  `node_modules`, and runs electron-builder on it. The app runs the packed
  CLI's own `jhin` bin (`dist/main.js`, read from its manifest) with
  Electron's Node (D512), so the files stay outside an asar archive and
  nothing is rebuilt: node-pty is a Node-API addon and loads in Electron's
  Node as built. Targets are T3's: AppImage and .deb (with T3's static
  AppImage runtime and .deb dependencies), dmg and zip, NSIS. The app id is
  `ai.jhin.desktop`, artifacts are `Jhin-<version>-<arch>.<ext>`, and the
  icon is `apps/desktop/resources/icon.png`, rendered from `icon.svg` beside
  it (electron-builder derives the macOS and Windows formats).

- **D943. The feed is this repository's releases, written only when asked.**
  With `--repository owner/repo` the build gets T3's GitHub `publish` entry:
  stable builds read `latest*.yml` from releases, nightly builds
  (`x.y.z-nightly.YYYYMMDD.N`) read `nightly*.yml` from prereleases, so
  electron-builder writes those files and the app's `app-update.yml`
  (D519). Without it the build has no feed and the app shows updates as
  disabled, as an unpackaged build does. electron-builder itself never
  publishes (`--publish never`): the workflow does.

- **D944. A build signs only when every secret of its system is set.** As
  in T3: macOS needs `CSC_LINK` (a Developer ID Application certificate,
  .p12 in base64), `CSC_KEY_PASSWORD`, and an App Store Connect API key
  (`APPLE_API_KEY`, the .p8's text, `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER`) with which electron-builder notarizes; Windows needs
  Azure Trusted Signing (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
  `AZURE_CLIENT_SECRET`, `AZURE_TRUSTED_SIGNING_ENDPOINT`,
  `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
  `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`,
  `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`), and also signs `.node` and
  `.dll` files; Linux is not signed. None set builds unsigned (macOS ad hoc,
  which Apple Silicon needs to start an app, and without keychain
  discovery); some but not all set fails the build and names what is
  missing. A stable release requires signing on macOS and Windows (an
  unsigned macOS app cannot update itself), unless the run asks for
  `allow_unsigned`. Packaging builds for the machine it runs on only: native
  addons are installed for it and never rebuilt (D942).

- **D945. The release workflow.** `.github/workflows/release-desktop.yml`
  builds Linux x64, macOS arm64 and Windows x64 in parallel (each system
  for both arches since D1210). A pushed tag
  `v1.2.3` or a manual "stable" run publishes the stable release of
  `apps/desktop/package.json`'s version (a tag that names another version
  fails), only from a commit on `main`; stable versions are plain `x.y.z`,
  since a suffixed one would be a GitHub prerelease the stable feed never
  offers. A manual "nightly" publishes the prerelease
  `v<version>-nightly.<date>.<run>`, also only from `main`. A manual "dry-run" (the default), and
  every pull request that changes packaging, builds as a release would (feed files included), unsigned, and keeps
  the installers as workflow artifacts. The last job creates the GitHub
  release with T3's generated notes and uploads the installers, their
  blockmaps and the feed files; a re-run uploads into the release that
  already exists as this run's draft (marked with the run's id, published
  once every file is up), so "Re-run failed jobs" finishes a run one platform
  broke, while any other run of an already released version fails instead of
  replacing its files. A failed run that is not re-run leaves its draft
  behind (racing runs leave one each): delete the draft on the releases page,
  then run again. Only publishing runs, which build from `main`, get the
  signing secrets; a dry run is unsigned, and packaging gives the secrets to
  electron-builder only, never to the install's scripts.

- **D946. Paste as Text is T3's Edit menu item.** "Paste as Text"
  (`CmdOrCtrl+Shift+V`, id `jhin.paste-as-text`) follows Paste. Its shortcut
  reaches the page as a keydown, which arms the composer (D295's
  `pasteAsText`) and pastes natively, so the menu ignores a click triggered
  by its accelerator, as T3 does. A click with the mouse runs the client
  command `desktop.paste-as-text`, which first runs
  `chat.composer.paste-as-text` (when the chat plugin is there) and then
  asks the app over the bridge's optional `pasteAsText()` to paste into the
  focused page: armed before the paste, the composer keeps a large paste
  inline for the one paste that follows within a second (a paste elsewhere
  spends it too), instead of attaching it as
  `pasted-text.txt`.

- **D947. ⌘/Ctrl+Q is T3's quit hold.** The main process runs T3's
  `QuitHold` handler on the window's `before-input-event`
  (`apps/desktop/src/quit-hold.ts`, with T3's tests): in Hold mode (T3's
  default) the shortcut quits when held for 1.2 s, or on two presses within
  0.5 s, and the window is hidden until the keys are released so their
  repeats cannot reach the next app; Double press quits on the second press;
  Direct quits at once. While the keys are down the page shows T3's hint
  ("Hold Ctrl+Q or press twice to quit", "Press Ctrl+Q again to quit"),
  contributed to `app.global` by `jhin.desktop`. The choice is kept in the
  app's data folder with the update track; the bridge gets the optional
  `getQuitShortcut`, `setQuitShortcut` and `onQuitShortcut`, and the client
  command `desktop.quit-shortcut.set` sets it. T3's "Quit shortcut" row
  (Direct, Hold, Double press) sits in General → Behavior through the new
  slot `settings.general.behavior`, where other plugins add rows too.

- **D948. Nightly shows T3's release notes in the update control.** On the
  nightly track electron-updater collects the notes of every release since
  the running one (`fullChangelog`); the controller keeps those of its own
  track through T3's `normalizeDesktopUpdateReleaseNotes`
  (`apps/desktop/src/updates/release-notes.ts`, with T3's tests): at most six
  releases of at most eight items each, markup stripped, "What's Changed"
  and the changelog links left out. `DesktopUpdateState` gets
  `releaseNotes` and `omittedReleaseCount` (with defaults, so the shape is
  additive), kept while a downloaded version is offered and cleared when up
  to date, as T3's machine does. When the control has an update to show and
  notes exist, hovering it opens T3's popover ("Update ready to download",
  "What's changed", "Changes in <version>", links to each release and to
  older ones on GitHub) instead of the tooltip; a press still runs the
  action. Stable keeps the tooltip.

### Restarts, the preview and devices (W34)

Workstream W34 of `t3-roadmap.md` continues this plan and `preview.md` with
the decision range D1201–D1220. The reference stays T3 Code `eb7b35ac`.

- **D1201. A node that exits by itself restarts with T3's backoff**
  (`apps/desktop/src/backend/DesktopBackendManager.ts`), not D512's dialog:
  after 500 ms, doubled for each start that fails since, at most 10 s, with
  no limit on attempts; a node that comes up starts the count over, and one
  that dies while a restart is starting it counts as a failed start. As in
  T3, a node that comes up and then dies every time restarts every 500 ms:
  its last 20 lines of output, which D512's dialog showed, go to the app's
  log with each exit. One restart is pending at a time. It leaves alone a
  node another path started or is starting (a failed update's restart, with
  its Try Again dialog), which neither counts as a start nor fails one. A
  quit cancels it (and stops a node a restart is starting, D522), and a
  failed update install, after which the app runs on, takes it back. The
  window loads the restarted node as it loads the first, or opens on it if
  none was open. Meanwhile the page shows the web client's own disconnected
  state. The first start keeps D512's dialog, since no window is open yet.
  `apps/desktop/src/node-restart.ts` holds the policy, unit tested with a
  scheduler the test runs by hand; the desktop e2e kills the node and sees
  the restart scheduled after 500 ms in the app's log and the page come
  back without a dialog.

- **D1210. Six release builds, with T3's merged feed files.** The release
  workflow builds every system for x64 and arm64, each on a runner of that
  arch, since packaging installs native addons for the host and never
  rebuilds them (D944): Linux on `ubuntu-latest` and `ubuntu-24.04-arm`,
  macOS on `macos-latest` (arm64) and `macos-15-intel`, Windows on
  `windows-latest` and `windows-11-arm`. electron-updater reads one feed
  file per platform and channel and picks the entry whose name carries the
  running arch: Linux names arm64's feed itself (`latest-linux-arm64.yml`),
  while macOS and Windows write one name for both. So each build names its
  feed by arch (`latest-mac-x64.yml`, `latest-win-x64.yml`,
  `latest-win-arm64.yml`) and uploads it as an artifact of its own, and the
  new `feeds` job merges them back into `latest-mac.yml` and `latest.yml`
  (the nightly ones likewise) with T3's merge
  (`scripts/update-manifests.ts`, from T3's `scripts/lib/update-manifest.ts`
  and `merge-update-manifests.ts`, with T3's tests). Unlike T3's, a
  file entry's other keys (electron-builder's `blockMapSize`) are carried
  through. The job fails when one of the four feeds of the channel is
  missing, when a merged feed lacks one of its arches, or on different
  versions or conflicting entries.
  The job runs on dry runs too, so a pull request proves the files a
  release publishes; the release job uploads the installers with the
  merged feeds. Signing is unchanged (D944): the arm64 Windows and the x64
  macOS builds sign with the same secrets once the owner adds them.

### The preview in the app (W37)

Workstream W37 of `t3-roadmap.md` continues this plan and `preview.md` with
the decision range D1321–D1340. The reference stays T3 Code `eb7b35ac`:
`apps/desktop/src/preview/{CdpRelay,GuestInput,DesktopBrowserHost,BrowserSession}.ts`,
the `will-attach-webview` gate of `window/DesktopWindow.ts`,
`apps/server/src/preview/DesktopBrowserChannel.ts` and the desktop parts of
`ServerBrowser.ts`, and in `apps/web` `browser/ElectronBrowserHost.tsx`,
`HostedBrowserWebview.tsx`, `hostedBrowserWebviewStyle.ts` and
`previewRuntime.ts` (`rendersServerTabNatively`).

- **D1321. The app shows its own node's browser tabs in a `<webview>`, as
  T3 renders a server tab natively.** T3's desktop shows the tabs of its
  primary environment in Electron webviews that the server's Playwright
  drives over CDP; Jhin's app does the same for its local node (the node
  the page was loaded from), and every other node's tabs keep D403's
  frames. The node learns of the app from the live stream
  `preview-desktop` (`preview.control`): while the app's page subscribes to
  it, a new tab, a human's (`preview.tab.open`) or an agent's
  (`preview.open`), is announced there (`preview.desktop.tabs`: the tabs the
  app should host, with their partition, D1323) and waits up to T3's 10 s for
  the app to attach its webview with `preview.desktop.attach { threadId,
  tabId, endpoint }` (`preview.control`). The node then connects Playwright
  to the endpoint (`connectOverCDP`), and the tab is the node's as before:
  the agent's tools, the control model (D397), dialogs, the file chooser,
  downloads and recordings act on the webview's page. Without an attach in
  time (no app, a page that does not host, an attach that fails) the tab
  opens in the headless Chromium (D394), as T3 falls back. A popup of a
  headless tab stays headless. The endpoint must be a loopback `ws://` URL;
  it is the app's, so a client of another machine cannot attach.
  `PreviewTab` gets `desktop: true` for such a tab (additive). The node does
  not size, zoom or screencast a desktop page: the webview's size is the
  page's viewport, so `fill` follows the panel by itself, and a preset or a
  zoom is applied by the page (D1324); the frames stream still carries the
  agent's pointer. "Clear cookies" and "Clear cache" go through the page's
  own CDP session. The user types into the page without the node, so a
  desktop page reports a new title itself (a binding its documents call),
  and the tab's title follows as after the node's own actions. Closing the tab disconnects Playwright (the webview's
  page is the app's to close) and drops the tab from the stream, so the app
  removes the webview; a webview that goes away (closed, crashed, a reload of
  the window) drops its tab, where T3 reconnects (Deferred).

- **D1322. The relay is T3's, in the app's main process.** Electron allows
  one debugger per `webContents`, and Playwright speaks to a browser, so the
  main process attaches the guest's `debugger` (protocol 1.3) and serves a
  browser of one page on a loopback WebSocket with a random 24-byte path,
  one connection at a time: T3's `CdpRelay.ts` (the browser target, the
  page session and its child sessions, `Runtime.runIfWaitingForDebugger`,
  downloads) and `GuestInput.ts` (key and text input kept inside the guest
  while the app has focus), with T3's tests. T3 relays through file
  descriptors to a WebSocket the server opens; here the app opens it and the
  node connects, since the attach is a command and the node already runs on
  the same machine. The bridge gets the optional `preview` part
  (`attachWebview(webContentsId)` → `{ endpoint }`, `onOpenLink`,
  `clearPartition`), and `desktop.shell@1` gets it too (1.1). The main
  process attaches only a webview guest of the app's window whose embedder
  is the asking page, and refuses one DevTools or another debugger holds;
  the endpoint closes with the guest, and the debugger is let go when the
  node disconnects.

- **D1323. Webviews are T3's hardened guests, one partition per profile.**
  The window enables the `<webview>` tag and gates `will-attach-webview` as
  T3 does: only a partition of the preview (`persist:jhin-preview-<profile>`
  for a human's profile, D952; `jhin-preview-incognito-<tab>` and an agent's
  isolated `jhin-preview-agent-<tab>` in memory, as D394 isolates an agent's
  tab), no preload, sandboxed, no Node, HTML full screen kept inside the
  webview; any other attach is refused. A guest's sessions grant T3's preview
  permissions (clipboard, notifications, geolocation, full screen) and
  nothing else. A page that opens a window gets none: an http(s) URL opens as
  a new tab of the same thread and profile (T3's `onOpenLink`), anything else
  is dropped. A profile's cookies in the app are its partition's: removing a
  profile in Settings → Browser also clears the partition in the app
  (`clearPartition`), and D1204's import still fills the node's headless
  profile only (Deferred).

- **D1324. The page hosts every webview, the panel places them.**
  `jhin.preview-panel` contributes `jhin.preview.desktop-host` to
  `app.global`; when `desktop.shell@1` has `preview`, it subscribes to its
  node's `preview-desktop`, keeps one webview per announced tab mounted for
  as long as the tab lives (switching threads or closing the panel does not
  reload a page), and attaches each one. The panel's surface and the mini
  player's report the rectangle a native tab's page takes, every animation
  frame, and the host lays the webview over it (T3's
  `hostedBrowserWebviewStyle`); a tab nobody shows is parked outside the
  window at its last size. A preset gives the webview the preset's size,
  scaled down to fit (T3's `viewportScale`), and the tab's zoom is the
  webview's zoom factor. In the panel the webview lies over the page area;
  in the mini player it lies under the player, whose page area lets the
  pointer through, so the pill and the resize handles stay on top. The
  panel's surface hides the webview while it shows a dialog, the file
  picker's prompt or an error page. The user's input reaches the page
  natively, except while the agent or another viewer holds the tab and this
  viewer does not: then the webview takes no pointer, so "Take control"
  (D403) is what lets the user in. The agent's cursor is drawn over the
  webview from the frames stream, which the host watches while the tab is
  shown.

- **D1325. Devices in the app are the web client's.** T3's desktop shows
  its devices with the web view its browser client has
  (`components/device/*`); nothing of its Electron runtime is for devices.
  So the app adds nothing either: the Device panel reaches its node's hub
  through `/device-hub` on the page's own origin (D1208) and decodes with
  Chromium's WebCodecs. The desktop e2e opens a simulator from D409's fake
  hub in the app and sends it a touch and Home.

## Deferred

- The `desktop.update.*`, `desktop.paste-as-text` and `desktop.quit-shortcut.set` commands over RPC, CLI and MCP: they are client
  commands of the app's page (D520), as every client command is today, so
  only the palette, keybindings and client plugins reach them.
- A machine-readable ready signal from `jhin serve` (the app reads the CLI's
  `ui:` and `logs:` lines and the token file the CLI itself reads for
  `--url`).
- A graceful stop of the node on Windows: `SIGTERM` is an immediate kill
  there, so D522's "stops the node first" waits for no shutdown work.
- The Intel-on-Apple-Silicon warning, the record of an install that did not
  apply, and telling a .deb install apart (D519 treats Linux outside an
  AppImage as not updatable).
- Checking the macOS chrome (traffic lights, the controls
  inset, full screen), Paste as Text's shortcut reaching the page before
  the menu (D946), and the Windows overlay badge on those systems: CI proves
  Linux only.
- T3's scheduled nightly that skips days without changes, its preview
  channel, and promoting a nightly's commit to stable; T3's DMG background;
  the AUR package; T3's x64 macOS build on arm64 hardware (D1210 builds it
  on an Intel runner, since packaging installs native addons for the host).
- Proof of the signed and publishing paths: pull request dry runs are
  unsigned and publish nothing, so the first nightly (and the first run with
  the signing secrets) is what proves notarization, Azure Trusted Signing,
  `--require-signing` and the publish job.
- Packaging checks what it installed as `pnpm pack:smoke` does: print the
  third-party packages the lockfile cannot pin, and fail on a version the
  workspace lockfile does not have.
- A pull request dry run also when the app's sources change (the desktop
  plugin, `packages/desktop-api`, the web client), or a scheduled dry run on
  `main`: today its path filter covers the packaging files only.
- A test of `scripts/package-desktop.ts`'s orchestration with a fake spawn:
  its pure parts are unit tested and the pull request dry run runs it whole
  on all three systems.
- A protected GitHub environment (required reviewers) for the signing
  secrets and the publishing job: today they are repository secrets, reachable
  by anyone who may dispatch a workflow on `main`.
- Pinning the release workflow's actions to commit SHAs (the repository's
  workflows use version tags today).
- Trimming the packaged app (about 400 MB unpacked: every agent SDK's
  binaries) and an asar archive with the node's files unpacked (D942).
- Attaching to a node of the same home that already runs (`jhin serve`), and
  choosing another port when 7777 is taken by something else (D513 keeps the
  origin stable, so the choice must be kept).
- The trackpad
  scroll-end and window-fullscreen events beyond macOS's controls inset.
- Around the preview in the app (D1321–D1324): a desktop tab that outlives
  its webview (T3 reconnects a tab after a reload of the window or once its
  DevTools close; here the tab closes); T3's DevTools, element annotation,
  passkeys, favicon capture and context menu of a guest; T3's desktop-only
  tabs (`runtime: "desktop"`) of a remote environment; importing cookies
  into the app's partitions (D1204 fills the node's headless profiles); a
  recording of a desktop tab nobody shows (Electron stops compositing a
  parked guest, T3 keeps it inside the window behind the app); input that
  reaches a webview through the window system in the e2e (xvfb has no window
  manager, so the test gives the guest its input); the keyboard and focus
  routing of `GuestInput.ts` proven against a real guest (its unit cases
  are T3's).
- WSL and SSH backends,
  screen captures, telemetry, the CLI shim, importing browser cookies,
  T3 Connect, Clerk and passkeys (D510).
- A `.wco` class for an installed web app (PWA) with a window controls
  overlay: only the desktop plugin sets it.
- Styles of runtime client plugins: a plugin's Tailwind classes exist only
  if the web client's build scanned its sources (D514); a plugin cannot ship
  its own CSS yet.
