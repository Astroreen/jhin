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
  to exit. A node that fails to start or exits while the app runs is shown in
  a native dialog with its last output, offering to restart it or quit.

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
  (D922); a build without that feed shows updates as disabled with T3's
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
range D920–D939 (the range `t3-roadmap.md` first gave it, D720–D739, belongs
to A7 in `agents.md`). The reference stays T3 Code `eb7b35ac`:
`scripts/build-desktop-artifact.ts`, `.github/workflows/release.yml` and
`release-desktop.yml`.

- **D920. W25's scope and order.** W25 lands as small PRs, one at a time:
  packaging, signing and the release workflow first (so D519's feed exists),
  then the app's smaller T3 pieces (release notes in the update control,
  Paste as Text, the quit-hold shortcut), then the preview's leftovers of
  `preview.md`. What a PR leaves stays in the Deferred lists below and in
  `preview.md`.

- **D921. Packaging stages the app from packed tarballs.**
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

- **D922. The feed is this repository's releases, written only when asked.**
  With `--repository owner/repo` the build gets T3's GitHub `publish` entry:
  stable builds read `latest*.yml` from releases, nightly builds
  (`x.y.z-nightly.YYYYMMDD.N`) read `nightly*.yml` from prereleases, so
  electron-builder writes those files and the app's `app-update.yml`
  (D519). Without it the build has no feed and the app shows updates as
  disabled, as an unpackaged build does. electron-builder itself never
  publishes (`--publish never`): the workflow does.

- **D923. A build signs only when every secret of its system is set.** As
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
  missing, so a typo never ships an unsigned release by accident.

- **D924. The release workflow.** `.github/workflows/release-desktop.yml`
  builds Linux x64, macOS arm64 and Windows x64 in parallel. A pushed tag
  `v1.2.3` publishes a stable release; a manual run publishes a nightly
  prerelease `v<version>-nightly.<date>.<run>` or, by default, is a dry run
  that builds without a feed and only keeps the installers as workflow
  artifacts. The last job creates the GitHub release with T3's generated
  notes and uploads the installers, their blockmaps and the feed files.
  Versions come from `apps/desktop/package.json` (nightly) or the tag.

## Deferred

- The `desktop.update.*` commands over RPC, CLI and MCP: they are client
  commands of the app's page (D520), as every client command is today, so
  only the palette, keybindings and client plugins reach them.
- A machine-readable ready signal from `jhin serve` (the app reads the CLI's
  `ui:` and `logs:` lines and the token file the CLI itself reads for
  `--url`).
- A graceful stop of the node on Windows: `SIGTERM` is an immediate kill
  there, so D522's "stops the node first" waits for no shutdown work.
- Release notes in the update control (T3's popover for nightly builds), the
  Intel-on-Apple-Silicon warning, the record of an install that did not
  apply, and telling a .deb install apart (D519 treats Linux outside an
  AppImage as not updatable).
- Checking the macOS chrome (traffic lights, the controls
  inset, full screen) and the Windows overlay badge on those systems: CI
  proves Linux only.
- Release builds beyond D924's three: macOS x64 (T3 merges the two
  `latest-mac.yml` files), Linux and Windows arm64; T3's scheduled nightly
  that skips days without changes, its preview channel, and promoting a
  nightly's commit to stable; T3's DMG background; the AUR package.
- Trimming the packaged app (about 400 MB unpacked: every agent SDK's
  binaries) and an asar archive with the node's files unpacked (D921).
- Attaching to a node of the same home that already runs (`jhin serve`), and
  choosing another port when 7777 is taken by something else (D513 keeps the
  origin stable, so the choice must be kept).
- Restarting a node that exits by itself with a backoff, as T3's backend
  manager does, instead of D512's dialog.
- Paste as Text, the quit-hold shortcut (T3's `QuitHold`), the trackpad
  scroll-end and window-fullscreen events beyond macOS's controls inset.
- The browser preview and devices in the app (W12), WSL and SSH backends,
  screen captures, telemetry, the CLI shim, importing browser cookies,
  T3 Connect, Clerk and passkeys (D510).
- A `.wco` class for an installed web app (PWA) with a window controls
  overlay: only the desktop plugin sets it.
- Styles of runtime client plugins: a plugin's Tailwind classes exist only
  if the web client's build scanned its sources (D514); a plugin cannot ship
  its own CSS yet.
