# T111 evidence notes

## Upstream reference

- Checkout: `/tmp/opencode/t3code`, commit `37de6cbde65c7cf9ba90a2557c232e63b7e16988`.
- Verified command labels (`apps/web/src/components/settings/KeybindingsSettings.logic.ts`):
  - `composer.sendAlternate` → "Composer: Opposite Queue or Steer Action" (`:315`)
  - `composer.sendBackground` → "Composer: Start in Background" (`:316`)
  - `composer.sendAndNewThread` → "Composer: Send and Start New Thread" (`:317`)
  - `thread.steerQueuedMessage` → "Queue: Send First Queued Message as Steer" (`:318`)
  - `composer.cycleHost` is not a special-case label; it exists as a command id
    (`packages/contracts/src/keybindings.ts:92`) and derives to
    "Composer: Cycle Host" through the dotted-id title-casing (`:329-340`).
- The command table layout is `KeybindingsSettings.tsx:1327-1567`; the key pill
  is `:74-105`; the row layout is `:1021-1050`.
- Diagnostics shell: `DiagnosticsSettings.tsx:708-1299`. Storage cleanup:
  `StorageSettings.tsx:85-288`.

## Plan-vs-upstream discrepancies and how they were resolved

1. **Search field is decorative.** Upstream filters the keybinding list
   client-side (`KeybindingsSettings.tsx:1349-1354`, `buildKeybindingRows`).
   Jhin has no client-side table filter primitive and the plan freezes
   `frontend/lib/sdui/keyboard/` ("no change"), so the panel renders the whole
   table and the search `input` carries `demo: true` (the shared preview
   tooltip). The `keybindSearch` id is the seam a later todo can wire.

2. **Inert upstream additions are `demo`-marked.** The plan asks for the
   upstream names verbatim, but commands such as `composer.sendBackground`,
   `composer.sendAndNewThread`, `composer.cycleHost`, `thread.steerQueuedMessage`
   are not in Jhin's dispatch vocabulary (`command_registry.dart:66-100`), so
   their Change buttons carry `demo: true` (plan section 14.10). The 33 T67
   commands stay real.

3. **Inline errorText on the capture dialog.** The server renders the
   `keyCapture` field with `required: true` and `errorText: "Press a chord
   first"` (`KeybindActions.java`). The client's `ActionDispatcher` only
   validates `include`d fields it can find in the current screen root
   (`action_dispatcher.dart:93-98`); the dialog node lives outside that root
   (`sdui_runtime.dart:362`), so the required rule is proven at the validator
   level (`keyboard_surface_test.dart` "a bare modifier capture fails
   validation and never saves") and the empty-capture `keybind-save` side
   effect persists nothing (`KeymapStore.applyAction` requires a non-empty
   `keys`). The QA `--fail` path asserts both the server-rendered
   `required`/`errorText` props and the client validator/no-persistence test.

4. **No Flutter golden for the three panels.** T111 changes no client
   primitive (the panels are server-authored node trees), so the T111 golden
   artifacts are the node-tree dumps `keybinds.json`, `diagnostics.json`,
   `storage.json` and `keybinds-override.json`. The Flutter keyboard suite
   covers the capture dialog behaviour.

5. **Storage data source.** Jhin has no worktree/artifact cleanup engine (plan
   section 14.1); the storage panel reports the shared store's real per-status
   counters and the `data/jhin.db` size, and keeps Clear cache decorative.

## UNVERIFIED answers

- Upstream checkout available at commit `37de6cb`; recreated not needed.
- `catalog_primitives()` sensitivity: all three panel trees use only
  documented section 2.5 types (gate asserted in `scripts/qa/t111.sh`).
- Toolchain: Flutter 3.47.0 stable (see `flutter-version.txt`).
