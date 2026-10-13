# JHIN — T3 Code Experience Plan: clone the t3code UI/UX onto the HTML SDUI stack

**Date:** 2026-10-11 · **Status:** approved for execution · **Executor:** chunked build-agent tasks (`/start-work`) · **Supersedes:** `jhin-t3code-ui-clone-plan.md` (Flutter-era; its task list and file paths are obsolete — this plan re-targets everything to the current HTML/Java stack and re-uses its §3.1/§3.2/§4.2/§4.5 design extraction as the design knowledge base).

**Language rule for this plan and everything it produces: ENGLISH.** Every source comment, Javadoc, JS comment, `docs/**`, `AGENTS.md`, commit message and QA script label is written in English.

**Id block:** `T300`–`T319` (20 tasks). `T50`–`T121` and `T200`–`T209` are taken; never renumber into them.

> **Execution state (checked 2026-10-13):** T304–T309 done and committed; T310 code (run summary + open-diff) committed, its QA script is the current work item (T310d). The continuation brief lives in `.sisyphus/progress.md` — read it before resuming execution.

---

## 1. Context and goal

Jhin's product is plugins over a kernel; the only client is the server-rendered HTML web client (contract level 4: `api: 4, minApi: 4, schema: 5, minSchema: 5`) built by the completed `jhin-web-client-plan.md` (T200–T209; `main` == `origin/main` == `a836efd`). The goal of this plan: **get the Jhin web app as close as possible to the T3 Code desktop app (`pingdotgg/t3code`, MIT, checked out at `/tmp/opencode/t3code`) in look, interaction and workflow coverage** — tools and sub-agents in the run timeline, mid-run questions, model/branch pickers, run summaries with changed files and diffs, project-grouped session sidebar with the full snooze/settle/done lifecycle, real git commit/push/PR, VS Code deep links, file browsing, and t3code-grade text/path rendering.

Everything product-shaped lands in plugins (`jhin.ui-kit`, `jhin.ui`, `jhin.tools-builtin`, the new `jhin.git`). Kernel and SDK are **frozen**: no edits to `kernel/` or `sdk/` in any task. The wire schema stays **5** — no new Ui primitive names; every new surface is composed from the existing 68-name catalog (§2.5 of `docs/sdui.md`). We port design **values** (numbers, OKLCH colours, structure, copy strings) from `/tmp/opencode/t3code`, never React/Tailwind/TypeScript code.

## 2. Real-vs-decorative rulings (user features a–m)

The owner delegated all choices ("pick the best one"). These rulings are final.

| # | Feature | Ruling | Mechanism | Task(s) |
|---|---------|--------|-----------|---------|
| a | tools + sub-agents visualization in the run timeline | **REAL** | timeline rows built from real `jhin.sessions` event log (`tool_use`/`tool_result` structured payloads, `run_start`/`run_end`): collapsible tool groups, LiveActivityRow, WorkLog, V2LifecycleRow, ProviderSubagentBar | T305, T306, T307 |
| b | mid-run questions / clarification | **REAL** | new blocking `ask_user` tool in `jhin.tools-builtin` + `QuestionBridge` service; the pending question renders in the composer (ComposerPendingUserInputPanel: question card + option chips + free-text reply) and the answer is POSTed to `POST /ui/action/answer-question`, which completes the tool future and resumes the run | T309 |
| c | selection of agent, model, git branch | **REAL** | ModelListRow (provider icons, favourites, `mod+1..9`/type-ahead jump) fed by `jhin.llm` provider registry; agent = provider+model pair (Jhin has one agent loop — no separate agent roster); BranchToolbar fed by `jhin.git` `GitService.branches()` | T308 (model/agent + branch shell), T314 (branch data) |
| d | changed-files summary at end of run + closing the working process | **REAL** | ChangedFilesTree (sticky header, "Open diff") computed from the run's `file-write`/`edit` tool events in the event log; WorkLog rows flip to done at `run_end` | T310 |
| e | sessions per project (project-grouped sidebar) | **REAL** | sidebar rows grouped under project headers derived from `Session.workdir` (basename of the workdir; "No project" bucket) inside each of the 5 sections | T303 |
| f | snooze / settle / done session actions | **REAL** | `SessionLifecycleService` (already real: settle/unsettle/pin/unpin/snooze/wake/archive/restore/setAutoSettle + `UndoJournal`): action menu with `Snooze` submenu (15 min / 1 h / 4 h / until tomorrow / custom), `Auto-settle behavior` toggle, undo notice via the `undo` directive (5 s window) | T304 |
| g | overall session display fidelity | **REAL** | thread row slot layout, context chip, hover card, `--workspace-topbar-height: 52px` topbar, breadcrumb | T303, T304 |
| h | open VS Code via SSH | **REAL (trivial)** | OpenInPicker emitting real URI links: `vscode://vscode-remote/ssh-remote+<host>/<path>` (desktop URI handler, upstream-canonical form) and `vscode-remote://ssh-remote+<host>/<path>` (remote-authority form), plus `vscode://file/<path>` for local — dispatched with the existing `openUrl` directive | T313 |
| i | look at diffs | **REAL** | pure-Java `DiffEngine` (Myers LCS, unified + split hunks, `DiffStat` +N/−N) in `jhin.ui-kit` powering the `diff_view` primitive (drops `demo: true`); unified/split toggle, stat header, DiffStatLabel | T311 |
| j | project files browsing | **REAL** | file tree + file preview via a new `FileTreeService` exported from `jhin.tools-builtin` (gitignore-aware walking already exists there: `GitIgnore`, `PathSandbox`) | T312 |
| k | commit / push / create pull request | **REAL** | new plugin `plugins/git/` (`jhin.git`) on **JGit** (`org.eclipse.jgit:org.eclipse.jgit`, published, pure Java — allowed by rule 3): status/diff/branch/commit/push real; PR creation via GitHub REST (`java.net.http`) with a user-supplied token in settings | T314, T315, T316 |
| l | run agents on different servers | **PARTIALLY REAL** | environment/host picker UI copied faithfully; ONE real host ("this host", id `local`); decorative `demo: true` rows for remote hosts; documented `HostRegistry` ServiceRegistry extension point (`com.astroreen.jhin.plugin.ui.api.HostRegistry`) so a future plugin can contribute hosts. **Limitation: the worker protocol / remote tool execution is out of scope (AGENTS.md "Not in this MVP"); selecting a remote host is preview-only and says so.** | T317 |
| m | how text and paths look | **REAL** | markdown GFM parity (add strikethrough + task-list + autolink commonmark extensions; raw HTML stays disabled), code-block header with language label + copy button, long-path middle truncation (`PathDisplay.middleTruncate`), path chips in monospace | T302 |

**Approval-gate UI** (`ComposerPendingApprovalPanel`) is NOT in the user's list and NOT in MVP: it ships only as a **static decorative composer state** (one `demo: true` panel fixture) inside T309 "for free" — no tool-approval backend is built.

### OUT of scope (hard — never schedule)

PTY/terminal emulation (the terminal drawer stays a decorative surface), cloud relay (T3 Connect), usage metering, telemetry, voice, browser import, scheduled tasks, snapshots, Electron/React/Tailwind/shadcn/Tiptap/lucide (zero new client dependencies), VS Code theme import + eyedropper, mobile view-transition API, session compaction/branching, OS-level isolation, hot-swap class reload, MCP server side, multi-instance sync, encryption of stored API keys (plaintext settings, documented).

## 3. Locked decisions (do not reopen)

| # | Decision | Consequence |
|---|----------|-------------|
| D-1 | **No schema bump.** No new Ui primitive names; every surface composes from the 68-name catalog (`diff_view`, `tree`, `hover_card`, `kbd`, `toast_stack`, `card`, `chip`, `menu`, `dialog`, `list_row`, `segmented`, `banner`, `form`, `dropdown` cover everything). `contract {api: 4, minApi: 4, schema: 5, minSchema: 5}` unchanged. | No contract-level early task; only prose cleanups in `docs/sdui.md` (§5 `session_updated` leftover, folded into T303). |
| D-2 | **Budget solved by splitting, not by inflating one file.** `app.js` (59970/60000 — full) splits into `web/js/core.js, render.js, actions.js, sse.js, keymap.js, timeline.js`; `app.css` (35229/40000) splits into `web/css/tokens.css, components.css, screens.css`. Loaded in order via `<script>`/`<link>` tags with the per-response CSP nonce. No bundler, no npm. | New budget table (§6); AssetRoute allowlist and the shell template change in T300 before any feature code lands. |
| D-3 | **Diff engine is pure Java in `jhin.ui-kit`** (`com.astroreen.jhin.plugin.uikit.diff`): `DiffEngine` (Myers LCS), `DiffHunk`, `DiffStat`. It is the data model of the `diff_view` primitive — generic text processing, zero domain words, no new dependency. | T311 needs no git; git working-tree diffs in T314 feed the same engine. |
| D-4 | **Git lives in a new plugin `plugins/git/` (`jhin.git`)**, JGit only there. `tools-builtin` keeps its tool-only charter. | `settings.gradle` gains `plugins/git`; the plugin catalogue in `AGENTS.md` lists 13 plugins (final gate T319). |
| D-5 | **`ask_user` is a tool, not an agent-SPI change.** The run blocks in `ToolDefinition.execute` on a `CompletableFuture` held by the `QuestionBridge` service (exported from `jhin.tools-builtin`); no timeout (run blocks until answered or cancelled); run cancel completes all pending futures exceptionally. | Zero changes to `jhin.agent`; `jhin.ui` consumes the bridge via an optional `requires` entry. |
| D-6 | **Changed files come from run events, not git** (the ruling: "fully real off existing session + agent-run events"). The event log's `file-write`/`edit` tool payloads accumulate the run's file set; "Open diff" renders the diff recorded in the tool payload through `DiffEngine`. | T310 works before `jhin.git` exists. |
| D-7 | **Branch picker degrades gracefully** until T314: T308 ships the picker UI with an explicit empty state "Git plugin not installed — branches unavailable" (`demo: false`, honest, not decorative); T314 populates it from `GitService.branches()`. | Build stays green and honest at every commit; feature (c) is fully real by the git wave. |
| D-8 | **Host model:** one real host `local` ("this host", `workdir`-local execution — the status quo) + `HostRegistry` extension point + 2 decorative remote rows (`demo: true`) + a permanent limitation banner on the picker ("Remote hosts need the worker protocol — not in this build"). | T317; limitation text is normative and ships in the UI and `docs/`. |
| D-9 | **Execution convention** (from `jhin-web-client-plan.md`): chunked build-agent tasks; each task = code + tests + QA script + evidence, verified, then exactly one Conventional Commit; evidence under `.sisyphus/evidence/T3XX/` committed with `git add -f`; QA kernel runs plain HTTP on `:18443` (kernel default 8443 is occupied; no `--no-tls` product flag). Each task ≤ ~400 lines of diff (pure file moves in T300 excepted). |
| D-10 | **Theme truth is upstream `packages/shared/src/themePalettes.ts` + `apps/web/src/index.css`** — explicit OKLCH maps for the 5 built-in themes (t3-chat, grove, ocean, ember, iris), not the generated PaletteGen fallback, wherever upstream has an explicit value. | T301. |

## 4. Architecture constraints (mechanically enforced)

1. **Kernel and SDK frozen** — no edits to `kernel/` or `sdk/` in any task; `KernelPurityTest` green untouched; no domain words enter the kernel.
2. **Everything product-shaped in plugins** — `jhin.ui-kit` (builder/renderer/tokens/diff model), `jhin.ui` (screens, actions, streams, web assets), `jhin.tools-builtin` (tools + `QuestionBridge` + `FileTreeService`), `jhin.git` (new).
3. **Server-driven UI** — plugins build `Ui` trees; `HtmlRenderer` renders them over the 68-primitive catalog; the client hardcodes ONLY the pairing fallback + `GET /_jhin/bootstrap` fetch. New interactive behaviour rides the 17 directives (`patch`, `setScreen`, `dialog`, `setState`, `toast`, `undo`, `openUrl`, …) and SSE frames (`node`/`patch`/`replace`/`remove`/`client`) of `docs/sdui.md` §4–§5.
4. **No npm, no bundler, no eval, no `new Function`, no WebSocket** — JSON + SSE only; JS ships as plain committed files loaded by ordered `<script>` tags with the CSP nonce; markdown is server-rendered (commonmark, raw HTML disabled).
5. **Pure Java in tools** — zero external binaries (rule 1); JGit is a published JVM library (rule 3), allowed.
6. **Gradle wrapper only**; fat-jar packaging via `gradle/plugin-conventions.gradle`.
7. **English** everywhere in code, docs, commits.
8. **The client never crashes on server content** — unknown event kinds, missing GitService/QuestionBridge/HostRegistry all degrade to explicit empty states, never throws.

## 5. Feature → upstream design references (design knowledge base)

The Flutter-era plan's extractions stand as the visual spec: §3.1 (what to copy: token layer, theme model, app shell 52px topbar/gutters/breadcrumb, sidebar 5 sections + row anatomy + action menu + undo notice, chat surface with 14 timeline row kinds + 16 event kinds + composer rows + markdown parity, panel chrome, 26 screens, palette/keybindings), §3.2 (what not to copy), §4.2 (route → screen id table), §4.5 (row/event kinds). Key upstream sources under `/tmp/opencode/t3code`:

| Surface | Upstream files |
|---------|----------------|
| tokens / themes | `apps/web/src/index.css` (63 colour tokens, `--color-*` aliases, `--contrast-*`, sidebar family, radius/text scales, insets, `--workspace-topbar-height: 52px`, `--chat-content-max-width: 46rem`, `--thread-details-panel-width: 17.5rem`, glass, motion, shadows, scrollbar, `--z-sheet: 46`), `packages/shared/src/themePalettes.ts` (5 themes OKLCH), `apps/web/src/themePalette.ts` |
| timeline | `apps/web/src/components/chat/` (MessagesTimeline, LiveActivityRow, WorkLog, V2LifecycleRow, ProviderSubagentBar), `ChatMarkdown.tsx` |
| composer | `ComposerPendingUserInputPanel`, `ComposerPromptEditor.tsx`, `docs/user/composer.md`, `docs/user/permission-modes.md` |
| pickers | `ModelListRow`, `BranchToolbar.tsx` + `BranchToolbar.logic.ts`, `docs/user/providers-*.md` |
| sidebar | `components/Sidebar*`, `components/sidebar/`, `docs/user/thread-sidebar.md` |
| diffs / files / git | `DiffPanel.tsx`, `DiffFilePathCopyButton.tsx`, `components/diffs/`, `components/files/`, `docs/user/source-control.md` |
| VS Code links | `apps/web/src/remoteOpen.ts`, `components/chat/OpenInPicker.tsx` (`vscode://vscode-remote/ssh-remote+<host>/<path>`) |
| hosts / environments | `docs/user/remote-access.md`, `docs/user/devices.md`, `BranchToolbarEnvironmentSelector.tsx` |
| keybindings / palette | `docs/user/keybindings.md`, `CommandPalette*.tsx` |
| text look | `docs/user/appearance.md`, `ChatMarkdown.tsx` |

## 6. Budget and contract changes (explicit)

**Budget — before this plan:**

| Asset | Size | Cap | Status |
|-------|------|-----|--------|
| `web/app.js` | 59970 | 60000 | **FULL** |
| `web/app.css` | 35229 | 40000 | 4771 free — the 63-token theme expansion blows it |

**Budget — after T300 (new table, asserted by every later QA script):**

| Asset | Cap | Justification |
|-------|-----|---------------|
| `web/js/core.js` (transport, state, expr, interpolate) | 60000 | current modules 1–4 ≈ 15 kB |
| `web/js/render.js` (screens + shell) | 60000 | current module 5 ≈ 32 kB |
| `web/js/actions.js` (actions + directives) | 60000 | current modules 6–7 ≈ 27 kB |
| `web/js/sse.js` (stream frames + prop applier) | 60000 | current module 8 ≈ 21 kB |
| `web/js/keymap.js` (keymap + overrides) | 60000 | current module 9 ≈ 6 kB |
| `web/js/timeline.js` (NEW: tool-card expand, diff toggle, drawer/focus driver) | 60000 | head-room for this plan's client behaviour |
| **total JS** | **300000** | per-file cap 60000; total cap 300000 (≈3× current 101 kB content); gzip stays the reverse proxy's job |
| `web/css/tokens.css` (token/theme layer, grows by 63 colour tokens × light/dark) | 40000 | token expansion alone ≈ +12 kB |
| `web/css/components.css` | 40000 | primitive styling |
| `web/css/screens.css` | 40000 | screen compositions |
| **total CSS** | **120000** | 3 × 40000 |

**Contract changes: NONE.** `api: 4, minApi: 4, schema: 5, minSchema: 5` unchanged; no primitive names added (D-1); the 17 directives and 5 frame shapes unchanged. `docs/sdui.md` prose edits only: §5 `session_updated` props paragraph completion (loose end, T303) and per-task notes where a previously decorative surface becomes real (the `demo: true` marker is dropped on it). The `X-Jhin-Client` grammar and the 426 gate are untouched.

## 7. Phased task list

QA convention (every `scripts/qa/t3XX.sh`): `set -euo pipefail`; self-re-exec watchdog `timeout --kill-after=15 900`; `--fail` flag selects the failure path; evidence dir `.sisyphus/evidence/T3XX/`; `checks.txt`/`checks-fail.txt` with `ok:`/`FAIL:` lines; `jq` guard; plain HTTP `:18443`; `boot_kernel()` jars the needed plugins into a `mktemp -d` `JHIN_HOME` and launches `scripts/qa/run-kernel.sh` (template: `scripts/qa/t206.sh`); `step` helper sends `X-Jhin-Client: api=4; version=0.2.0; schema=5; caps=sse,open_url,secure_storage`; static asserts on rendered HTML, CSS tokens, JS file contents and API JSON. **No browser automation is available** — every visual case writes `.sisyphus/evidence/T3XX/browser-unavailable.txt` listing exactly which visual checks are uncovered and which curl/static asserts substitute them. `catalog_primitives()` keeps extracting the legal primitive set from `docs/sdui.md` §2.5 and fails on any emitted node `type` outside it. One Conventional Commit per task; evidence staged with `git add -f`.

---

### Phase 0 — Runtime budget & foundations

#### T300 — Split the client runtime into budgeted chunks; drawer focus handling
**Goal:** the runtime fits a sustainable budget before any feature code lands, and the three known JS loose ends are closed.
**References:** `jhin-web-client-plan.md` §4.3/§4.4 (runtime modules), T207 (AssetRoute/CSP), `docs/sdui.md` §9.5 (focus restore), current `web/app.js` module markers (`/* module 1 … 9 */`).
**Files:**
- NEW `plugins/ui-default/src/main/resources/web/js/core.js` (app.js modules 1–4: transport, state, expr, interpolate)
- NEW `web/js/render.js` (module 5: screens + shell)
- NEW `web/js/actions.js` (modules 6–7: actions + directives)
- NEW `web/js/sse.js` (module 8: frames + prop applier + focus restore)
- NEW `web/js/keymap.js` (module 9: keymap + overrides)
- NEW `web/js/timeline.js` (new behaviours: tool-card expand/collapse driver, diff unified/split toggle driver, drawer driver below)
- NEW `web/css/tokens.css`, `web/css/components.css`, `web/css/screens.css` (split of `app.css`)
- DELETE `web/app.js`, `web/app.css`
- EDIT `web/index.html` — six ordered `<script src>` + three `<link rel=stylesheet>` tags, each with the per-response nonce
- EDIT `WebShellRoute.java`, `AssetRoute.java` (allowlist: the 9 new names, exact match; `Content-Type` per extension; ETag = sha-256; `Cache-Control: no-cache`), `ServiceWorkerRoute.java` (cache list = the 9 names)
**Steps:** 1) split `app.js` at the module markers verbatim — no logic changes; globals stay on one shared `Jhin` namespace object so cross-module calls work as today; 2) split `app.css` into tokens (custom properties + `:root`/theme blocks) / components (primitive classes) / screens (compositions); 3) wire the shell template + asset allowlist + SW cache; 4) close the three loose ends in `render.js`/`timeline.js`: **Tab-cycle focus trap** in open drawers/dialogs (Tab and Shift+Tab cycle within the overlay), **Escape closes the open drawer** (and only the topmost overlay), the **`jhin-drawer-open` class driver** (body class toggled on drawer open/close, restoring the T206 hook); 5) budgets asserted in tests and QA.
**Acceptance:** `./gradlew :jhin-plugin-ui-kit:test :jhin-plugin-ui-default:test` green; all 9 assets serve 200 + 304 on `If-None-Match`; every chunk ≤ its cap (§6 table) and totals ≤ 300000 JS / 120000 CSS; `grep -c "focus trap\|jhin-drawer-open\|Escape" web/js/*.js` ≥ 3; no reference to `app.js`/`app.css` remains (`rg "app\.(js|css)" plugins/ui-default/src` empty).
**QA `scripts/qa/t300.sh`:** happy — build + suites, `curl` each of the 9 assets (200, `Content-Type`, ETag, 304 revalidation), byte-size asserts per §6 table, grep for the three drawer/focus behaviours, `browser-unavailable.txt` (visual drawer choreography). Failure — `/ui/assets/app.js` must 404 after the split (`evidence/T300/old-name-404.txt`); an oversized chunk fails the script (`evidence/T300/budget.txt`).
**Commit:** `chore(web): split the runtime into budgeted js/css chunks and close the drawer focus gaps`

---

### Phase 1 — Tokens and themes

#### T301 — Token parity: 63 colour tokens + five OKLCH themes
**Goal:** the t3code token layer lands in `UiTokens`/`TokenCss`/`app.css` with upstream-exact values; the 5 built-in themes carry upstream OKLCH maps.
**References:** `/tmp/opencode/t3code/apps/web/src/index.css` (`:root` token layer), `packages/shared/src/themePalettes.ts` (per-theme OKLCH), Flutter-era plan §3.1 token inventory + §4.3 token shape; current `UiTokens.java` (60 `COLOR_KEYS` today), `ThemeCatalog.java`, `TokenCss.java`, `Oklch.java`, `PaletteGen.java`.
**Files:** EDIT `plugins/ui-kit/src/main/java/com/astroreen/jhin/plugin/uikit/UiTokens.java` (align `COLOR_KEYS` to upstream's 63 semantic colour names; keep `CONTRAST_KEYS` indirection in sync), `ThemeCatalog.java` (explicit OKLCH light/dark maps for t3-chat, grove, ocean, ember, iris from `themePalettes.ts`, overriding PaletteGen output where upstream is explicit), `html/TokenCss.java` (emit all eleven families incl. `--color-*` aliases and `--contrast-*` indirection), `plugins/ui-default/src/main/resources/web/css/tokens.css` (consumes the emitted variables; adds the sidebar token family, radius/text scales, insets incl. `--control-radius`, `--sidebar-content-inset`, `--sidebar-control-gap`, `--sidebar-row-content-inset`, `--command-shell-inset`, `--command-content-inset`, `--floating-content-inset`, `--workspace-topbar-height: 52px`, `--chat-content-max-width: 46rem`, `--thread-details-panel-width: 17.5rem`, glass, motion `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)` + skeleton/status-pulse/status-ping, shadows, scrollbar `--app-scrollbar-width: 6px`, `--z-sheet: 46`); EDIT tests `TokenCssTest`, `ThemeCatalogTest`.
**Steps:** 1) diff `UiTokens.COLOR_KEYS` against upstream's 63 names; add the missing keys (expected: `warning-surface` companions / `surface-raised` aliases — take the exact upstream list); 2) port the per-theme OKLCH maps verbatim (light + dark + stage art already present); 3) `TokenCss` emits `--color-*` aliases + `--contrast-*` indirection exactly as upstream's alias block; 4) `tokens.css` consumes them; 5) tests assert: every `COLOR_KEYS` name has a value in every theme, 63 names emitted, the fixed geometry tokens equal upstream values.
**Acceptance:** served token CSS contains ≥ 63 `--color-` semantic names, `--workspace-topbar-height: 52px`, `--chat-content-max-width: 46rem`, `--thread-details-panel-width: 17.5rem`, `--z-sheet: 46`, `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)`; theme test asserts the t3-chat dark `--primary` (and 5 sentinel values per theme) equal `themePalettes.ts` values exactly.
**QA `scripts/qa/t301.sh`:** happy — suites + `curl /` and grep the inlined/linked token CSS for the sentinel tokens (`evidence/T301/tokens.txt`, `themes.txt`); failure — a theme missing a `COLOR_KEYS` entry fails the suite (count mismatch printed to `evidence/T301/missing-keys.txt`).
**Commit:** `feat(ui-kit): t3code token parity — 63 colour tokens and five OKLCH themes`

---

### Phase 2 — Text and path look (feature m)

#### T302 — Markdown GFM parity, code-block header, path rendering
**Goal:** text and paths look like t3code: GFM markdown, code blocks with language label + copy, middle-truncated long paths, monospace path chips.
**References:** `docs/sdui.md` §2.6 `markdown` mapping table + `code_block` props (`copyable`, `language`), upstream `ChatMarkdown.tsx`, `docs/user/appearance.md`; current `MarkdownRenderer.java`.
**Files:** EDIT `plugins/ui-kit/build.gradle` (+ `org.commonmark:commonmark-ext-gfm-strikethrough:0.24.0`, `commonmark-ext-gfm-tasklist:0.24.0`, `commonmark-ext-autolink:0.24.0` — published, MIT), EDIT `html/renderers/MarkdownRenderer.java` (register the three extensions; code_block header emits the muted language label + ghost copy action per §2.6 recipe), NEW `plugins/ui-kit/src/main/java/com/astroreen/jhin/plugin/uikit/text/PathDisplay.java` (`middleTruncate(String path, int max)` — keeps the first segment and the filename, replaces the middle with `…`), EDIT `web/css/components.css` (`.jhin-path-chip` monospace chip; path text `direction: ltr; overflow-wrap: anywhere`), EDIT `plugins/ui-default/src/main/java/.../screens/MessageCardBuilder.java` + `SidebarBuilder.java` (render workdir/paths through `PathDisplay` + path chips), tests `MarkdownRenderTest`, `PathDisplayTest`.
**Steps:** 1) add the three GFM extensions to the commonmark parser (raw HTML stays disabled — XSS rule unchanged); 2) code-block header = language label + copy button (copy = clipboard + `toast`, the §2.6 recipe); 3) `PathDisplay.middleTruncate` with unit tests (paths > 48 chars middle-truncate to ≤ 48, short paths untouched); 4) path chips: every path-like string in sidebar rows, tool cards and changed-files rows renders in a monospace chip; 5) tests + a markdown fixture sweep (GFM table, strikethrough, task list, autolink, alert blockquote).
**Acceptance:** suites green; rendered markdown HTML for the GFM fixture contains `<del>`, `<input type="checkbox" disabled>`, `<a href="https://…">` autolinks, and the code-block header `data-jhin-type="code_block"` with a language label and copy affordance; `PathDisplay.middleTruncate("/very/long/…/file.java", 48)` returns a ≤ 48-char string preserving `file.java`.
**QA `scripts/qa/t302.sh`:** happy — suites + `curl` a QA probe screen rendering the markdown fixture + grep the HTML (`evidence/T302/markdown.html`, `paths.txt`); failure — an unclosed fenced block still degrades to plain text (`evidence/T302/degraded.txt`, the §2.6 degradation rule).
**Commit:** `feat(ui-kit,web): GFM markdown parity, code-block headers and path chips`

---

### Phase 3 — Sidebar and session lifecycle (features e, f, g)

#### T303 — Project-grouped sidebar + thread row fidelity
**Goal:** sessions group per project; thread rows carry the t3code slot anatomy; topbar/breadcrumb/context chip match upstream.
**References:** upstream `components/Sidebar*`, `docs/user/thread-sidebar.md`, Flutter-era plan §3.1 sidebar + shell bullets; current `SidebarBuilder.java` (5 sections already real), `ShellScreen.java`, `docs/sdui.md` §5 `session_updated` mapping (the leftover paragraph).
**Files:** EDIT `screens/SidebarBuilder.java` (project group headers inside each section: group key = `PathDisplay` basename of `Session.workdir`, "No project" bucket last; collapsed-group persistence `sidebar.project.<key>.collapsed`), EDIT `screens/ShellScreen.java` (breadcrumb: project › session title; 52px topbar per `layout.topbarHeight`), EDIT `screens/MessageCardBuilder.java` (context chip: model + provider + workdir path chip), EDIT `docs/sdui.md` §5 (complete the `session_updated` props paragraph — the loose end: state that absent fields become `null` and the full row-prop table governs the patch), tests `SidebarBuilderTest`.
**Steps:** 1) group rows by project with count badges and collapse persistence; 2) thread row slots: status indicator, title, secondary line (project · workdir chip · relative time), trailing hover-reveal cluster (`hoverReveal`); 3) breadcrumb + topbar exact metrics; 4) context chip on the chat screen header; 5) finish the §5 paragraph.
**Acceptance:** suites green; sidebar HTML for a seeded 2-project store contains two group headers with correct counts and the rows nested under them; breadcrumb contains `›`; topbar CSS height 52px; `docs/sdui.md` §5 paragraph is complete (no "TBD"/unterminated sentence).
**QA `scripts/qa/t303.sh`:** happy — boot with `jhin.sessions`+`jhin.ui-kit`+`jhin.ui`, seed sessions via the API in two workdirs, `curl /` and grep group headers/counts (`evidence/T303/sidebar.html`, `groups.txt`); failure — a session with `workdir=null` lands in "No project" (`evidence/T303/null-workdir.txt`).
**Commit:** `feat(ui): project-grouped sidebar and thread-row fidelity`

#### T304 — Session action menu: snooze/settle/done + hover card + undo
**Goal:** the t3code thread action menu is fully real over `SessionLifecycleService`.
**References:** upstream `CustomSnoozeDialog.tsx`, `docs/user/thread-sidebar.md` (Snooze submenu, Auto-settle, undo notice), `threadSettled.ts:255-303` settle presets (already cited in `SidebarBuilder`); `SessionLifecycleService.java`, `SettleReason.java`, `UndoJournal`.
**Files:** EDIT `screens/SidebarBuilder.java` (action `menu` per row: Open / Pin / **Snooze ▸** 15 min / 1 h / 4 h / until tomorrow 09:00 / custom (`dialog` with datetime `input`) / Settle ▸ presets / Wake / Archive / Regenerate title / Delete; `Auto-settle behavior` `switch` bound to `setAutoSettle`), EDIT `SessionActions.java` (the action handlers: snooze computes `snoozed_until`; settle dispatches with a `SettleReason`; every lifecycle mutation returns the `undo` toast with the 5 s window and the action), EDIT `screens/SidebarBuilder.java` hover card (`hover_card`: title, project, workdir chip, model, created/updated, status, last event), tests `SessionActionsTest`.
**Steps:** 1) action menu with the exact upstream item set and order; 2) Snooze submenu incl. custom dialog; 3) settle presets mapping to `SettleReason` values; 4) auto-settle switch; 5) undo notice on every mutation (existing `UndoJournal` + `undo` directive); 6) hover card content; 7) status indicators per section (pin glyph, snooze clock, settled check, working pulse — `statusPulse` token).
**Acceptance:** suites green; curl the action endpoints: `snooze` sets `snoozed_until` and moves the row to Snoozed; `settle` moves it to Settled and clears pin/snooze (service contract); every response body carries the `undo` toast directive; the menu HTML contains the Snooze submenu with 5 entries.
**QA `scripts/qa/t304.sh`:** happy — boot, seed, POST the actions, assert state via `GET /sessions/{id}` + row HTML via `curl /` (`evidence/T304/{menu.html,actions.jsonl}`); failure — `settle` on a settled session must 409/4xx per the service contract (`evidence/T304/invalid-transition.txt`); `undo` after 5 s is a no-op toast (`evidence/T304/undo-expired.txt`).
**Commit:** `feat(ui): real snooze/settle/done session actions with hover card and undo`

---

### Phase 4 — Timeline: tools, work log, sub-agents (feature a)

#### T305 — Tool cards + collapsible tool groups + live activity rows
**Goal:** real tool calls from the event log render as the t3code timeline: standard tool cards with the 5-state status chip, collapsible groups of consecutive same-kind tools, LiveActivityRow shine while running.
**References:** `docs/sdui.md` §5 (standard tool card anatomy, card expansion via `patch`/`visible`, event kinds), Flutter-era plan §4.5; current `MessageCardBuilder.java` (row/event kind constants already exist), `EventFrames.java`, `QaTimelineScreen.java`.
**Files:** EDIT `screens/MessageCardBuilder.java` (tool card from real `tool_use`/`tool_result` events: header icon+name+status chip+chevron, mono argument summary line, output region (`markdown`/`code_block`/`diff_view`), footer timestamp+copy; group rows: consecutive `tool_use` under one `work` row with count header `work-toggle`; `work-live` row with the accent shine while the call is unmatched), EDIT `EventFrames.java` (map `tool_use` → `node` of the live row; `tool_result` → `replace` of the row to its done state), EDIT `web/js/timeline.js` (expand/collapse: chevron patches `ev-<seq>-body` `visible: true/false`, pure client-side), tests `MessageCardBuilderTest`.
**Steps:** 1) tool card renderer fed by real events; 2) grouping rule: consecutive `tool_use` events with the same tool name inside one run fold under a `work` group; 3) live row + done flip; 4) expansion via `patch`/`visible` (§5 recipe); 5) empty output = muted italic "No output."; 6) five status chips exactly as §5 (pending/running/success/error/cancelled).
**Acceptance:** suites green; with `jhin.qa-mock-llm` scripted tool calls, the session HTML contains tool cards with the correct chips and a group header when 2+ consecutive same-tool calls occur; expanding patches only `ev-*-body` (assert the frame is a `patch` shape).
**QA `scripts/qa/t305.sh`:** happy — boot with sessions/ui-kit/ui/agent/llm/llm-builtin/tools-builtin/qa-mock-llm, run a scripted tool call, `curl /ui/screen/chat:<id>` and grep cards/chips (`evidence/T305/timeline.html`, `frames.jsonl` from the SSE endpoint); failure — an unknown tool name renders the `unknown` placeholder card, never throws (`evidence/T305/unknown-tool.txt`).
**Commit:** `feat(ui): real tool cards, collapsible tool groups and live activity rows`

#### T306 — WorkLog + V2LifecycleRow run lifecycle
**Goal:** the run's working process is visible and closes cleanly: WorkLog rows (icon + label + timestamp), V2LifecycleRow states, working spinner strip that disappears at `run_end`.
**References:** upstream `WorkLog`, `V2LifecycleRow`; `docs/sdui.md` §5 `run_start`/`run_end`; current `EventFrames.java`.
**Files:** EDIT `screens/MessageCardBuilder.java` (`work-log-entry` event card = icon + label + trailing timestamp; `working` row = spinner strip; `assistant-meta` row = model/effort line; `turn-fold`/`attempt-fold` affordances), EDIT `EventFrames.java` (`run_start` → `node` the working strip + V2 lifecycle row; `run_end` → `replace` the lifecycle row to done + `remove` the strip), tests `MessageCardBuilderTest` (extend).
**Steps:** 1) WorkLog row kinds from `work-log-entry` structured payloads; 2) V2LifecycleRow state machine (queued → running → done/failed) driven by `run_start`/`run_end`/`error`; 3) working strip appears at run start and is removed at run end; 4) done state = success glyph + duration.
**Acceptance:** one scripted run renders: working strip during the run (SSE `node`), lifecycle row flipping to done at `run_end` (`replace`), WorkLog rows with trailing timestamps; re-open after the run shows no strip and the done state persists from the event log replay.
**QA `scripts/qa/t306.sh`:** happy — boot full agent bundle, scripted run, assert via SSE transcript + final screen HTML (`evidence/T306/{run.jsonl,timeline.html}`); failure — an `error` event flips the lifecycle row to failed with the danger tone (`evidence/T306/error-state.txt`).
**Commit:** `feat(ui): work log and run lifecycle rows that close at run_end`

#### T307 — Sub-agent visualization (ProviderSubagentBar)
**Goal:** sub-agent activity shows as the upstream right-aligned bar and grouped rows.
**References:** upstream `ProviderSubagentBar`; `docs/sdui.md` §5 `subagent` event kind ("the row carries `align: centerRight` — self-end"); current kind constant `subagent` in `MessageCardBuilder`.
**Files:** EDIT `screens/MessageCardBuilder.java` (subagent event card: provider icon + agent label + task summary + status chip, `align: centerRight`; nested tool calls from the sub-agent's structured payloads indent under the bar), EDIT `EventFrames.java` (structured `tool_result` with `type: "subagent"` dispatch), NEW fixture entry in `resources/fixtures/` (`subagent-fixtures.json`: 3 scenarios), tests.
**Steps:** 1) subagent bar renderer; 2) nested event grouping under the bar via the continuation key `subagent:<id>`; 3) decorative fallback: when the tool reports no sub-agent payloads, no bar is emitted (honest absence, not an empty bar); 4) fixture-driven QA probe row in `QaTimelineScreen`.
**Acceptance:** a structured `tool_result` of kind `subagent` renders a self-end bar with the status chip; nested events indent; the plain (non-subagent) timeline is byte-identical to T306 output (regression assert).
**QA `scripts/qa/t307.sh`:** happy — suites + `curl` the QA probe fixture screen and grep `self-end`/bar markup (`evidence/T307/subagent.html`); failure — a malformed subagent payload falls back to the `unknown` card (`evidence/T307/malformed.txt`).
**Commit:** `feat(ui): sub-agent activity bars in the run timeline`

---

### Phase 5 — Composer: pickers and questions (features c, b)

#### T308 — Model/agent picker real + branch picker shell
**Goal:** the composer's ModelListRow and BranchToolbar are real controls (no `demo: true`): model/agent from `jhin.llm`, branch with the D-7 honest empty state until T314.
**References:** upstream `ModelListRow`, `BranchToolbar.tsx`/`BranchToolbar.logic.ts`, `docs/user/providers-*.md`; current `ChatScreen.java` (`chat_branch` state, `composer-branch-picker`, decorative `dialogOptions`), `jhin.llm` provider registry API.
**Files:** EDIT `screens/ChatScreen.java` (ModelListRow dialog: providers with icons, models under each, favourites (`star`) persisted in `jhin.ui` settings key `composer.favoriteModels` (JSON array), type-ahead filter + `mod+1..9` jump labels via `kbd`; selection writes `Session.model`/`providerId` through the session API and updates `assistant-meta`; BranchToolbar button + branch dialog: list `GitService.branches()` when the `jhin.git` service is present (ServiceRegistry lookup), else the empty-state card "Git plugin not installed — branches unavailable"), EDIT `UiSettings.java` (favourites key), tests `ChatScreenTest`.
**Steps:** 1) replace the decorative model dialog with the real provider/model list; 2) favourites add/remove + persistence; 3) Kbd jump labels (1–9) + type-ahead; 4) selection updates the session and the meta row; 5) branch dialog: service-present branch list (for T314) / honest empty state now; 6) host/environment button stays as the T317 shell (label "This host") — no `demo` marker on model/branch controls after this task.
**Acceptance:** with `jhin.llm` + `jhin.llm-builtin` booted, the model dialog HTML lists the real providers/models from the registry; selecting one updates `Session.model` and the `assistant-meta` row; favourites persist across reload; with `jhin.git` absent the branch dialog shows exactly the empty-state copy (not a preview badge).
**QA `scripts/qa/t308.sh`:** happy — boot sessions/ui-kit/ui/security/llm/llm-builtin, `curl` the chat screen, POST `select-model`, assert session JSON + screen HTML (`evidence/T308/{picker.html,session.json}`); failure — with no providers configured the picker shows the "no providers" empty state (`evidence/T308/no-providers.txt`).
**Commit:** `feat(ui): real model and agent picker, branch picker shell`

#### T309 — `ask_user` blocking tool + pending question composer panel
**Goal:** the agent can ask mid-run; the question renders in the composer and the answer resumes the run.
**References:** upstream `ComposerPendingUserInputPanel`, `docs/user/composer.md`, `docs/user/question-attachments.md`; `docs/sdui.md` §5 `question` event card; agent `ToolDefinition`/`ToolProvider` SPI; `SendAction.java`.
**Files:**
- NEW `plugins/tools-builtin/src/main/java/com/astroreen/jhin/plugin/toolsbuiltin/AskUserTool.java` (`name: ask_user`, params `{question: string, options?: string[]}`; `execute` publishes the question and blocks on the bridge future; returns the answer text as `tool_result`)
- NEW `toolsbuiltin/api/QuestionBridge.java` (service interface: `CompletionStage<String> ask(sessionId, callId, question, options)`, `void answer(sessionId, callId, answer)`, `void cancelAll(sessionId)`) + `QuestionBridgeImpl.java` (`ConcurrentHashMap` of futures; **no timeout** — runs block until answered or cancelled)
- EDIT `ToolsPlugin.java` (register `AskUserTool`, publish `QuestionBridge` to `ServiceRegistry`; manifest exports `com.astroreen.jhin.plugin.toolsbuiltin.api`)
- EDIT `plugins/tools-builtin/src/main/resources/jhin-plugin.json` (exports +)
- EDIT `plugins/ui-default/build.gradle` (compileOnly `jhin.tools-builtin`) + `jhin-plugin.json` (optional `requires` `jhin.tools-builtin`)
- EDIT `screens/ChatScreen.java` + `MessageCardBuilder.java` (ComposerPendingUserInputPanel: question card + option chips (`button` per option) + free-text reply row; rendered when the latest `ask_user` `tool_use` has no `tool_result`; `demo: false`)
- NEW `AnswerQuestionAction.java` (`POST /ui/action/answer-question`, body `{sessionId, callId, answer}` → `bridge.answer` → run resumes; response replaces the composer region back to the normal input via `replace`)
- EDIT `CancelAction.java` (`bridge.cancelAll(sessionId)` on run cancel)
- Static decorative composer state: one `demo: true` `ComposerPendingApprovalPanel` fixture row in `QaTimelineScreen` (approval-gate is NOT built)
- Tests: `AskUserToolTest`, `QuestionBridgeTest`, `ChatScreenTest` (extend)
**Steps:** 1) bridge service + tool; 2) the `tool_use` event renders both the timeline question card (§5 `question` kind) and the composer `replace` frame with the panel; 3) option chips POST `answer-question` with the chip label; the free-text row posts the typed text (existing send flow re-routed when a question is pending); 4) `tool_result` (the answer) replaces the composer back to normal; 5) run cancel fails pending futures with `cancelled` → `tool_result` `error: true`; 6) the decorative approval fixture.
**Acceptance:** a scripted run that calls `ask_user` blocks; the screen HTML contains the question card + option chips; POST `answer-question` with an option resumes the run and the final `tool_result` content equals the answer; cancelling the run yields a cancelled `tool_result`; with `jhin.tools-builtin` absent the composer never shows a question panel (optional-dep degradation).
**QA `scripts/qa/t309.sh`:** happy — boot sessions/ui-kit/ui/security/llm/llm-builtin/agent/tools-builtin/qa-mock-llm, drive a run with a scripted `ask_user`, `curl` screen (panel HTML), POST the answer, `curl` the events (answer in `tool_result`) (`evidence/T309/{panel.html,events.jsonl,answer.json}`); failure — answering twice is idempotent-rejected (second POST 409/4xx, `evidence/T309/double-answer.txt`); cancel path (`evidence/T309/cancel.txt`).
**Commit:** `feat(tools,ui): blocking ask_user tool with the pending-question composer panel`

---

### Phase 6 — Run summary and diffs (features d, i)

#### T310 — Changed-files summary + WorkLog done state ("closing the working process")
**Goal:** at run end the timeline shows the t3code ChangedFilesTree (sticky header, per-file A/M/D + line stats, "Open diff") and the working process visibly closes.
**References:** upstream `ChangedFilesTree`, Flutter-era plan §4.8 `files-fixtures.json` (exists), D-6; current `RightPanelBuilder.java`, `QaTimelineScreen.java`, fixtures `files-fixtures.json`/`empty-files-fixtures.json`.
**Files:** EDIT `screens/MessageCardBuilder.java` (run-summary card at `run_end`: sticky header "Changed files · N", one `tree`/`list_row` per path with A/M/D badge + `DiffStatLabel` +N/−N from the run's tool payloads, "Open diff" button per row), EDIT `EventFrames.java` (`run_end` frame carries the summary card), EDIT `screens/RightPanelBuilder.java` ("Open diff" opens the diff panel tab pre-focused on that file — the T311 engine, or the tool-recorded diff payload), NEW `screens/RunSummaryBuilder.java` (accumulates `file-write`/`edit` tool payloads of the run into path → {add, del, kind}), tests `RunSummaryBuilderTest`.
**Steps:** 1) accumulate the run's file set from events (D-6); 2) summary card with sticky header + per-file rows + stats; 3) "Open diff" action → right panel diff view for the file; 4) WorkLog/lifecycle rows are in the done state (T306) — this task adds the summary that "closes" the process; 5) empty run (no file events) renders the `empty-files-fixtures` empty state.
**Acceptance:** a scripted run that writes 2 files ends with a summary card listing both paths with correct +/− stats; "Open diff" response contains the file's diff HTML; a run with no writes shows the empty state copy.
**QA `scripts/qa/t310.sh`:** happy — boot full bundle, scripted write run, assert summary HTML + diff action response (`evidence/T310/{summary.html,diff.html}`); failure — a run with zero file events (`evidence/T310/empty.txt`).
**Commit:** `feat(ui): run summary with changed files and open-diff`

#### T311 — Real diff engine + unified/split diff panel
**Goal:** diffs are real computed diffs: `DiffEngine` + `diff_view` with unified/split toggle, stat header, DiffStatLabel +N/−N.
**References:** `docs/sdui.md` §2.6 `diff_view` props + `HasDiffView`; upstream `DiffPanel.tsx`, `DiffPanelShell.tsx`, `DiffFilePathCopyButton.tsx`, `docs/user/source-control.md`; D-3.
**Files:**
- NEW `plugins/ui-kit/src/main/java/com/astroreen/jhin/plugin/uikit/diff/DiffEngine.java` (Myers LCS line diff → `List<DiffHunk>` with `add`/`del`/`ctx` lines), `DiffHunk.java`, `DiffStat.java` (add/del counts)
- EDIT `plugins/ui-kit/src/main/resources/jhin-plugin.json` (exports += `com.astroreen.jhin.plugin.uikit.diff` — required so `jhin.git` (T314) can return `DiffHunk` types across the class-loader boundary)
- EDIT `html/renderers/DataRenderers.java` (`diff_view` renders from real hunks: hunk headers `@@ -a,b +c,d @@`, line numbers both sides in split mode, `DiffStatLabel` `+N/−N` header; `demo: true` dropped when fed real hunks)
- EDIT `web/css/components.css` (diff colours on `diff-addition`/`diff-deletion` tokens; split two-column grid)
- EDIT `web/js/timeline.js` (unified/split toggle: `segmented` control dispatching `setState` + `patch` on the diff node — client-side, no round-trip)
- EDIT `screens/RightPanelBuilder.java` (diff panel: stat header + file path chip + copy-path button + segmented unified/split)
- Tests: `DiffEngineTest` (golden hunks: pure add, pure del, mixed, no-change), `DataRenderersTest` (diff_view HTML)
**Steps:** 1) `DiffEngine` with unit goldens; 2) renderer feeds hunks; 3) toggle; 4) stat header + labels; 5) wire T310's "Open diff" to the engine when the tool payload has no recorded diff (compare recorded before/after text); 6) fixtures `diff-fixtures.json`/`empty-diff-fixtures.json` keep driving the QA probe.
**Acceptance:** `DiffEngine.diff(old, new)` golden test passes (exact hunks); rendered `diff_view` HTML contains `@@` headers, both line-number columns in split mode, and a `+N/−N` label matching `DiffStat`; the toggle swaps the node body via a `patch` frame only.
**QA `scripts/qa/t311.sh`:** happy — suites + `curl` the QA probe diff screen (fixture hunks) + grep (`evidence/T311/{diff.html,stat.txt}`); failure — identical texts render the "No changes" empty state (`evidence/T311/empty.txt`).
**Commit:** `feat(ui-kit,web): real diff engine with unified and split diff views`

---

### Phase 7 — Files browsing (feature j)

#### T312 — Project file tree + file preview
**Goal:** browse the project's files with the t3code file tree and a preview pane.
**References:** upstream `components/files/`, fixtures `files-fixtures.json`; tools-builtin `GitIgnore.java`, `PathSandbox.java`, `FileToolSupport.java`, `ReadTool.java`.
**Files:**
- NEW `plugins/tools-builtin/src/main/java/com/astroreen/jhin/plugin/toolsbuiltin/api/FileTreeService.java` (`List<FileNode> tree(workdir, depth)`, `String preview(workdir, path, maxBytes)` — gitignore-aware, path-sandboxed; reuses `GitIgnore` + `PathSandbox`) + `FileTreeServiceImpl.java` + `api/FileNode.java` (path, dir flag, size, mtime)
- EDIT `ToolsPlugin.java` (publish the service; manifest export — already added in T309)
- EDIT `plugins/ui-default/.../screens/ProjectScreen.java` (file `tree` + preview `code_block`/`markdown` pane; expand/collapse rows via `patch`/`visible`; file select → preview content via action → `patch` the preview node)
- EDIT `web/css/screens.css` (tree indent, active file row)
- Tests: `FileTreeServiceTest` (temp dir with `.gitignore` cases), `ProjectScreenTest`
**Steps:** 1) service over the existing walker; 2) tree UI with lazy expand; 3) preview action (text ≤ 256 kB, binary → size placeholder); 4) path chips + `PathDisplay` truncation on deep paths; 5) "Open in VS Code" per file row is the T313 link (added there).
**Acceptance:** seeded workdir with nested dirs + `.gitignore` renders the tree without ignored files; selecting a file patches the preview pane with its content; a binary file shows the placeholder; path outside the sandbox 403s/empty-contents per `PathSandbox`.
**QA `scripts/qa/t312.sh`:** happy — boot sessions/ui-kit/ui/llm/llm-builtin/agent/tools-builtin (tools-builtin has a non-optional `requires` on `jhin.agent`, which non-optionally requires `jhin.llm` — the bundle MUST include agent+llm or tools-builtin fails to load and `FileTreeService` never publishes), seed a temp workdir, `curl` the project screen + the preview action (`evidence/T312/{tree.html,preview.txt}`); failure — ignored file absent (`evidence/T312/gitignore.txt`); sandbox escape (`evidence/T312/sandbox.txt`).
**Commit:** `feat(tools,ui): project file tree and file preview`

---

### Phase 8 — VS Code links (feature h)

#### T313 — OpenInPicker with real VS Code URIs
**Goal:** "Open in editor" hands the OS real VS Code deep links.
**References:** upstream `remoteOpen.ts`, `OpenInPicker.tsx`, `OpenInPicker.logic.ts` (the exact URI formats), `docs/user/remote-access.md`.
**Files:** EDIT `screens/MessageCardBuilder.java` + `screens/ProjectScreen.java` + `screens/RightPanelBuilder.java` (an "Open in ▾" `menu` on file rows/paths: `VS Code (local)` → `vscode://file/<abs-path>`; `VS Code (SSH)` → `vscode://vscode-remote/ssh-remote+<host>/<abs-path>`; `VS Code Remote` → `vscode-remote://ssh-remote+<host>/<abs-path>`; `Copy path` → clipboard + toast), NEW `ui/OpenIn.java` (URI builders with `URLEncoder` on the path segments — mirror upstream `remoteOpen.test.ts` cases incl. spaces → `%20` and `C:\` → `C%3A`), tests `OpenInTest`.
**Steps:** 1) URI builders with the upstream-exact formats and unit tests from `remoteOpen.test.ts` cases; 2) the picker menu on file paths (T310 rows, T312 tree, diff panel header); 3) dispatch via the `openUrl` directive; 4) `<host>` = the session's host label (`local` → the machine hostname; remote hosts per T317 `HostRegistry` — absent → only the local entry); 5) `Copy path` fallback everywhere.
**Acceptance:** `OpenIn.uri(...)` tests match upstream expected strings byte-for-byte for the three formats; the menu HTML on a file row contains the three entries + Copy path; the `openUrl` directive payload carries the exact URI.
**QA `scripts/qa/t313.sh`:** happy — suites + `curl` a file-row menu (`evidence/T313/menu.html`, `uris.txt`); failure — a path with spaces encodes to `%20` not raw spaces (`evidence/T313/encoding.txt`).
**Commit:** `feat(ui): OpenInPicker with real VS Code local and SSH deep links`

---

### Phase 9 — Git wave (feature k + branch half of c)

#### T314 — `jhin.git` plugin: JGit service + branch picker populated
**Goal:** real git reads behind the UI: status, branches, working-tree diff; the T308 branch picker becomes real.
**References:** `docs/user/source-control.md`; D-4; `gradle/plugin-conventions.gradle` (fat-jar); `plugins/example/` (plugin template).
**Files:**
- NEW `plugins/git/build.gradle` (`org.eclipse.jgit:org.eclipse.jgit:6.10.1.202505221210-r` — published, pure Java; fat-jar via plugin-conventions), `plugins/git/src/main/resources/jhin-plugin.json` (id `jhin.git`, apiVersion 1, exports `com.astroreen.jhin.plugin.git.api`), `src/main/java/com/astroreen/jhin/plugin/git/GitPlugin.java`, `api/GitService.java` (`branch(workdir)`, `List<GitBranch> branches(workdir)`, `List<GitFileStatus> status(workdir)`, `List<DiffHunk> diff(workdir, path)` (re-uses `jhin.ui-kit` `DiffEngine` types via a requires on `jhin.ui-kit`), `commit(workdir, message, paths)`, `push(workdir)` — commit/push bodies land in T315), `api/GitBranch.java`, `api/GitFileStatus.java` (path, A/M/D, ahead/behind), `GitServiceImpl.java` (JGit porcelain over `workdir/.git`; non-git dir → explicit `GitException("not a git repository")`)
- EDIT `settings.gradle` (include `plugins/git`)
- EDIT `plugins/ui-default/build.gradle` + manifest (compileOnly + optional requires `jhin.git`)
- EDIT `screens/ChatScreen.java` (branch dialog reads `GitService` (optional lookup): branch list with current-branch marker + switch action; non-git workdir → "Not a git repository" state)
- Tests: `GitServiceImplTest` (JGit `Git.init()` temp repos: branch list, status, diff)
**Steps:** 1) plugin skeleton per `plugins/example/`; 2) service impl on JGit; 3) unit tests on temp repos; 4) branch picker wiring (D-7 resolves); 5) non-git degradation.
**Acceptance:** `./gradlew build` green including `:jhin-plugin-git:test`; on a temp repo with 2 branches the branch dialog lists both with the current marked; `status` returns the exact A/M/D set; `diff` hunks equal `DiffEngine` output for the same file.
**QA `scripts/qa/t314.sh`:** happy — build + suites + boot with `jhin.git` staged, seed a temp git repo as workdir, `curl` the branch dialog + `GET /git/status` route if exposed via ui actions (`evidence/T314/{branches.html,status.json}`); failure — a non-git workdir (`evidence/T314/not-git.txt`).
**Commit:** `feat(git): JGit-backed git service and the real branch picker`

#### T315 — Commit and push (source-control screen)
**Goal:** the t3code source-control screen commits and pushes for real.
**References:** upstream `GitActionsControl.tsx`/`.logic.ts`, `docs/user/source-control.md`; `docs/sdui.md` action protocol.
**Files:** EDIT `plugins/git/.../api/GitService.java` + `GitServiceImpl.java` (commit: JGit `git.commit().setMessage(m).setOnly(paths)`; push: `git.push()` to the configured remote/branch; dry-run error surfaces), NEW `plugins/ui-default/.../screens/SourceControlScreen.java` (screen id `settings:source-control` becomes real — replace the decorative fixture row set: changed-files list w/ checkboxes, commit message `textarea` + `Commit` button, branch bar, `Push` button with ahead/behind chip, last-commit row), EDIT `SettingsActions.java`/`ActionDescriptors.java` (actions `git-commit`, `git-push`), EDIT `screens/SettingsScreen.java` (nav entry points to the real screen), tests `GitServiceImplTest` (commit+push to a local bare remote).
**Steps:** 1) commit/push service methods + tests against a local bare `origin`; 2) the screen (form + list + buttons); 3) actions with real errors (nothing staged → inline error, push rejected → toast with the remote message); 4) success path updates the status list + a `toast`.
**Acceptance:** commit on a dirty temp repo creates a commit with the message and only the selected paths; push to a local bare remote updates its ref; the screen HTML reflects the new clean status afterwards.
**QA `scripts/qa/t315.sh`:** happy — boot with `jhin.git`, temp repo + bare remote, POST `git-commit`/`git-push`, assert via JGit-readable state + screen HTML (`evidence/T315/{screen.html,commits.jsonl}`); failure — commit with empty message 4xx (`evidence/T315/empty-message.txt`); push to a dead remote → error toast (`evidence/T315/push-fail.txt`).
**Commit:** `feat(git,ui): real commit and push on the source-control screen`

#### T316 — Create pull request (GitHub REST) + token setting
**Goal:** "Create pull request" opens a real GitHub PR from the UI.
**References:** upstream PR flow, fixtures `pull-requests-fixtures.json`; D-4; AGENTS.md "no encryption of stored API keys".
**Files:** EDIT `plugins/git/.../GitServiceImpl.java` + NEW `api/PrService.java` (`createPr(workdir, title, body, base, head)` → GitHub REST `POST https://api.github.com/repos/{owner}/{repo}/pulls` via `java.net.http.HttpClient`, token from settings; owner/repo parsed from the `origin` remote URL; response: PR number + html_url), EDIT `plugins/git` manifest exports, EDIT `screens/SourceControlScreen.java` ("Create pull request" button → `dialog` form: title (prefilled from branch), body `textarea`, base branch `dropdown` (from `GitService.branches()`), submit → `PrService` → success `toast` + `openUrl` to the PR URL), EDIT `SettingsActions.java` (settings `git.githubToken` — plaintext settings store, documented; and `git.githubApiBase` — the API base URL, default `https://api.github.com`, overridable so tests/QA can point at a stub; a `settings:source-control` "GitHub token" `input` row), tests `PrServiceTest` (mock HTTP via a local `HttpServer` stub through `git.githubApiBase`).
**Steps:** 1) `PrService` with unit test against a stub server (no network in tests); 2) remote URL → owner/repo parser (`https://github.com/o/r.git` and `git@github.com:o/r.git`); 3) the PR dialog; 4) token setting row + validation (401 → "Token rejected" inline error); 5) success opens the PR URL via `openUrl` and toasts.
**Acceptance:** with a stubbed GitHub endpoint the service posts the right JSON and returns the PR URL; the dialog submits and the response carries `openUrl` to the PR; a missing token yields the inline "GitHub token not configured" state (honest, not decorative).
**QA `scripts/qa/t316.sh`:** happy — boot, `curl` the PR dialog HTML + POST `git-pr` against a stubbed endpoint configured via the `git.githubApiBase` setting (point it at the JVM test stub URL; the HTTP stub itself is covered by `PrServiceTest` — QA asserts dialog HTML + action wiring + the no-token/401 paths via curl and the suite), `evidence/T316/{dialog.html,action.json}`; failure — no token (`evidence/T316/no-token.txt`), 401 path (`evidence/T316/unauthorized.txt`).
**Commit:** `feat(git,ui): create GitHub pull requests from the source-control screen`

---

### Phase 10 — Host picker (feature l)

#### T317 — Environment/host picker with HostRegistry extension point
**Goal:** the upstream environment picker ships with one real host, decorative remote rows, and a documented extension point.
**References:** upstream `BranchToolbarEnvironmentSelector.tsx`, `EnvironmentMachineIcon.tsx`, `docs/user/devices.md`, `docs/user/remote-access.md`; D-8.
**Files:** NEW `plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/api/HostRegistry.java` (service SPI: `List<HostDescriptor> hosts()`; `HostDescriptor`: id, label, kind (`local`/`ssh`), hostName, icon) + `api/HostDescriptor.java` (exported package `com.astroreen.jhin.plugin.ui.api` in the manifest), EDIT `screens/ChatScreen.java` (environment button + `dialog` picker: real `local` row ("This host" with the machine hostname) + registered `HostRegistry` rows + 2 decorative remote rows `demo: true` (`ssh staging`, `ssh gpu-box`) + permanent `banner` limitation: "Remote hosts need the worker protocol — not in this build. Selecting a remote host is a preview."; selecting `local` sets the session host state; selecting a remote row shows the limitation toast — never pretends to connect), EDIT `docs/plugin-dev.md` (document `HostRegistry` as the extension point for host plugins), tests `HostRegistryTest`.
**Steps:** 1) SPI + default `local` descriptor; 2) picker UI copied from upstream geometry (icon + label + kind chip + check on active); 3) decorative rows + limitation banner (the D-8 ruling); 4) selection semantics (local real, remote preview-only toast); 5) docs.
**Acceptance:** picker HTML contains the `local` row + 2 `demo` rows + the limitation banner text verbatim; with a test `HostRegistry` impl registered, a third real row appears; selecting `local` persists to the session; selecting a decorative row never mutates the session.
**QA `scripts/qa/t317.sh`:** happy — boot, `curl` the picker dialog (`evidence/T317/picker.html`, `hosts.json`); failure — with no registry the picker still renders `local` + banner (`evidence/T317/no-registry.txt`).
**Commit:** `feat(ui): environment picker with one real host and the HostRegistry extension point`

---

### Phase 11 — Settings, keybindings, palette parity

#### T318 — Appearance/keybindings/palette parity sweep
**Goal:** settings and command surface match upstream structure; every remaining decorative affordance carries `demo: true` (or is removed).
**References:** `docs/user/appearance.md`, `docs/user/keybindings.md`, upstream `CommandPalette*`, `settings.appearance.tsx`/`settings.keybindings.tsx`; current `SettingsScreen.java`, `KeybindCatalog.java`, `DefaultKeymap.java`, `ClientKeybindings.java`.
**Files:** EDIT `screens/SettingsScreen.java` (`settings:appearance`: theme picker (5 real themes — T301), light/dark/system, chat width `default/wide/full`, diff colour scheme `default/blue-orange`, contrast boost, per-role font sizes clamped 12–18/12–18/12–20; `settings:keybindings`: the upstream when-context table + rebind sheet via `keyCapture` + reset), EDIT `KeybindCatalog.java`/`DefaultKeymap.java` (the upstream command set incl. `mod+1..9` thread jump, `mod+z` undo with 5 s coalescing, `mod+shift+p` palette `>` action prefix), EDIT `web/js/keymap.js` (last-match-wins already; add the coalescing window + `>` palette prefix), EDIT `web/css/screens.css` (settings panel layouts), demo-sweep test `DemoMarkerSweepTest` (every interactive node without a server-side write action must carry `demo: true` — enforce across all builders), tests.
**Steps:** 1) appearance settings real (they feed `bootstrap.theme`/`tokens` prefs); 2) keybindings surface (list + rebind + reset + persistence — `ClientKeybindings` store exists); 3) palette parity (`>` prefix, grouped results with subtitles); 4) the demo-marker sweep test green; 5) remove any leftover decorative-but-unmarked controls found by the sweep.
**Acceptance:** suites green incl. the sweep (0 unmarked decorative nodes); rebind persists (`X-Jhin-Keybindings` enrichment unchanged); appearance change is visible in the next bootstrap (`tokens.prefs`).
**QA `scripts/qa/t318.sh`:** happy — suites + `curl` settings screens + assert the sweep artifact 0 (`evidence/T318/{appearance.html,keybindings.html,sweep.txt}`); failure — an unmarked demo node fails the sweep with its node id listed (`evidence/T318/fail-path.txt` via `--fail`).
**Commit:** `feat(ui): appearance, keybindings and palette parity with the demo sweep`

---

### Phase 12 — Final gate

#### T319 — Full verification, docs and catalogue close-out
**Goal:** the plan's definition of done is proven; docs and AGENTS.md describe the shipped reality.
**References:** all prior tasks; `AGENTS.md`, `README.md`, `docs/architecture.md`, `docs/plugin-dev.md`, `docs/sdui.md`, `docs/updates.md`.
**Files:** EDIT `AGENTS.md` (plugin catalogue: + `plugins/git/` (`jhin.git`); repository layout 13 plugins; frontend rule unchanged), `README.md` (feature list: timeline, questions, git, VS Code links, files, hosts), `docs/architecture.md` (new plugin + services), `docs/plugin-dev.md` (`QuestionBridge`, `FileTreeService`, `HostRegistry` extension points), `docs/updates.md` (schema stays 5 — note explicitly), `docs/sdui.md` (any residual prose), NEW `scripts/qa/t319.sh` (the gate).
**Steps:** 1) `./gradlew build` full green (all modules incl. `:jhin-plugin-git:test`); 2) run `scripts/qa/t300.sh` … `t318.sh` — all PASS; 3) budget gate: totals ≤ 300000 JS / 120000 CSS, per-chunk caps (§6); 4) contract gate: bootstrap `contract` still `{api:4,minApi:4,schema:5,minSchema:5}`; `catalog_primitives()` sweep 0 unknown types; 5) `KernelPurityTest` green untouched; 6) docs links resolve (`rg` for stale paths); 7) evidence index: `ls .sisyphus/evidence/T3{00..19}` complete, each with `checks.txt` + `browser-unavailable.txt` where visual.
**Acceptance:** every checklist item above green; `git log --oneline` shows exactly one commit per task T300–T319 with the planned messages; working tree clean.
**QA `scripts/qa/t319.sh`:** happy — the full re-run of the t3XX chain + build + budget + contract asserts → `evidence/T319/{summary.txt,budget.txt,contract.txt,evidence-index.txt}`; failure — `--fail` stops at the first red script and names it (`evidence/T319/failures.txt`).
**Commit:** `chore: t3code experience close-out — docs, catalogue and the full QA gate`

---

## 8. Dependency matrix

| Task | Depends on | Unblocks |
|------|-----------|----------|
| T300 | — (T200–T209 done) | T301…T319 (budget first) |
| T301 | T300 | T302, T303 |
| T302 | T301 | T303…T313 (text/path look underpins every surface) |
| T303 | T301, T302 | T304, T305 |
| T304 | T303 | T305 |
| T305 | T303 | T306, T307 |
| T306 | T305 | T307, T309, T310 |
| T307 | T306 | T308 |
| T308 | T307 | T309, T314 |
| T309 | T306 | T310 |
| T310 | T306, T309 | T311 |
| T311 | T300 (DiffEngine independent), T310 | T312, T313, T314 |
| T312 | T302, T309 (FileTreeService export) | T313 |
| T313 | T312 | T314 |
| T314 | T308 (picker shell), T311 (DiffHunk types) | T315 |
| T315 | T314 | T316 |
| T316 | T315 | T317 |
| T317 | T308 (composer host button) | T318 |
| T318 | T301 (themes), T304 (keymap cmds) | T319 |
| T319 | all | — |

Execution order is exactly T300 → T319 (the matrix only names the true content dependencies). Every commit leaves `./gradlew build` green.

## 9. Must-NOT-Have (hard prohibitions for the executor)

1. No edits to `kernel/` or `sdk/` — ever. No domain words in the kernel.
2. No new Ui primitive names and **no schema bump** (D-1): `contract` stays `api:4/minApi:4/schema:5/minSchema:5`.
3. No npm, no bundler, no TypeScript build, no `eval`/`new Function` in the runtime, no WebSocket, no custom binary protocol.
4. No React/Tailwind/shadcn/Tiptap/lucide code copied from `/tmp/opencode/t3code` — port design values only (numbers, OKLCH colours, structure, copy strings).
5. No PTY/terminal emulation, cloud relay, usage metering, telemetry, voice, browser import, scheduled tasks, snapshots, VS Code theme import + eyedropper, view-transition API, session compaction/branching, OS-level isolation.
6. No tool-approval backend (the approval composer state is static `demo: true` only).
7. No remote execution: `HostRegistry` rows beyond `local` are decorative and must carry `demo: true` + the limitation banner (D-8).
8. No raw-HTML markdown path, no unescaped `Ui.raw` outside its contract role, no `<script>` in server fragments (CSP unchanged).
9. No single JS/CSS file may exceed its §6 cap; never re-merge the chunks into one file.
10. No encryption scope creep for the GitHub token (plaintext settings, documented — AGENTS.md "Not in this MVP").
11. No human-intervention QA: every check is curl/static/JVM-assertable; visual gaps go to `browser-unavailable.txt`.
12. No "TBD", no "decide later", no "may also include" in code, docs or commits — every decision in this plan is final.

## 10. Final verification (the plan is done when)

1. `./gradlew build` green across sdk, kernel, 13 plugins; `KernelPurityTest` green with zero kernel diffs (`git diff --stat origin/main -- kernel sdk` empty).
2. `scripts/qa/t300.sh` … `scripts/qa/t319.sh` all PASS on `:18443`; each `.sisyphus/evidence/T3XX/` holds `checks.txt` (+ `browser-unavailable.txt` where visual).
3. **Budget:** `find plugins/ui-default/src/main/resources/web/js -exec wc -c {} +` total ≤ 300000, each ≤ 60000; `web/css` total ≤ 120000, each ≤ 40000 (asserted in T300 + T319).
4. **Contract:** `curl -H 'X-Jhin-Client: api=4; version=0.2.0; schema=5; caps=sse,open_url,secure_storage' :18443/_jhin/bootstrap` → `contract == {api:4,minApi:4,schema:5,minSchema:5}`; an `api=3` request → 426 `contract_upgrade`; `catalog_primitives()` sweep 0 unknown node types.
5. **Feature proof (curl-level):** timeline tool cards/groups (T305), worklog/lifecycle close (T306), subagent bar (T307), model picker real (T308), ask_user round-trip (T309), changed-files summary + open-diff (T310), diff hunks + stats (T311), file tree + preview (T312), VS Code URI strings (T313), branch list (T314), commit+push state (T315), PR dialog (T316), host picker + banner (T317), settings/sweep (T318).
6. **Real-vs-decorative table (§2) holds:** every REAL row demonstrably server-backed; every decorative row carries `demo: true` (sweep test green); the l-limitation banner text is present in the picker.
7. `git log --oneline -20` = exactly the 20 planned commit messages; working tree clean; evidence staged with `git add -f`.
