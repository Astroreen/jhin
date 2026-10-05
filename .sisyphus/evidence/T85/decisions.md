# T85 — decisions and verification notes

Upstream reference: `/tmp/opencode/t3code`, commit `37de6cb`
(`refactor(server): share one keyed lock that releases idle keys (#15577)`).
Every seed triple and stage-art token in `ThemeCatalog.java` was extracted
programmatically from that checkout and verified verbatim (20 OKLCH triples
from `packages/shared/src/themePalettes.ts`, 60 stage-art values from
`apps/web/src/index.css`).

## Orchestrator decision D5 — active seed pair per appearance (record)

Every theme carries both the light and the dark seed pair
(`ThemeCatalog.Theme.light` / `.dark`). The active pair is chosen by the
existing `UiSettings` appearance logic:

- `appearance=light` → the theme's light pair;
- `appearance=dark` → the theme's dark pair;
- `appearance=system` → the light pair.

Rationale: the pre-T85 logic has no server-side system resolution — the
stored `canvas`/`accent` seeds answer as-is and the client's own `themeMode`
override (T69) decides the rendered mode. `system` therefore stores the
theme's primary (light) pair, matching upstream where every built-in
declares `appearance: "light"` as its primary map
(`themePalettes.ts:254`, `:381`, `:508`, `:635`, `:762`).
Covered by `SettingsActionsTest.themeSaveUnderSystemAppearanceResolvesToTheLightPair`
and `ThemeCatalogTest.systemAppearanceResolvesToTheLightPair`.

## Default seeds changed with the default theme (discrepancy, resolved)

The plan's Files: list does not touch the default seeds, but D4 fixes the
default `themeId` to `t3-chat`. Keeping the old default seeds
(`#16161e` / `#7E57C2`, the jhin identity) under a `t3-chat` id would answer
an incoherent bootstrap, and the acceptance wording — "the jhin theme
*reproduces* the exact pre-plan palette" — implies the pre-plan look moves
into the selectable `jhin` theme while the out-of-box look becomes
`t3-chat`. Therefore:

- `UiSettings.DEFAULT_THEME_ID = "t3-chat"`;
- `UiSettings.DEFAULT_CANVAS` / `DEFAULT_ACCENT` now derive from the default
  theme's light pair (`#fdf7fd` / `#db2777`, the Oklch conversion of
  `themePalettes.ts:256` and `:272`), so the defaults can never drift from
  the catalogue;
- the jhin theme keeps the exact pre-plan seeds `#16161e` / `#7E57C2` for
  both appearances (D1/D2).

Forced collateral updates (files outside the plan's T85 Files: list, all
asserting the superseded defaults or the old include list):

- `scripts/qa/t78.sh:218,225,241,247` — default-seed assertions;
- `scripts/qa/t78.sh:281` — the `save-appearance` include list gains
  `themeId` (six ids);
- `scripts/qa/t84.sh:199` — default canvas assertion;
- `plugins/ui-default/src/test/.../BootstrapContractTest.java:68` — default
  accent/canvas/id assertions.

Cross-check: `scripts/qa/t84.sh:154-155` already pinned the five built-in
light accent hexes (`#db2777 #1b7d50 #2672af #ae552a #7253b9`) as T84 test
vectors; the catalogue conversions agree byte-for-byte.

## Store migration 3→4 (plan §15.6 answer)

Verified on a copy of a real schema-3 store — the exact on-disk state a
pre-T85 build writes (every key enveloped at schema 3, `appearance` without
a `themeId` field): `frontend/test/store/v3_to_v4_migration_test.dart`.

- A migrated `appearance` key gains `themeId: "t3-chat"` through the 3→4
  `sideKeys` merge; every pre-existing field and every other key survives
  byte-identical (no data loss).
- An `appearance` that already carries a `themeId` is never clobbered.
- A fresh store seeds `appearance` through the shipped 2→3 step (which
  predates the field and must not be edited, docs/updates.md §6), so the
  3→4 `introduced()` hook never fires for it; the reader default
  (`AppearancePrefs.defaultThemeId`, `frontend/lib/sdui/keyboard/palette.dart`)
  answers `t3-chat` there. Recorded here per the "never edit a shipped
  step" rule.

## Reservation scope (plan T85 step 5 vs upstream)

Upstream additionally reserves the legacy aliases (`t3-chat-dark`,
`t3-grove`, …) and the built-in ids themselves
(`themePalettes.ts:19-29`). Jhin implements the plan's scope: the
appearance modes `system`/`light`/`dark` are rejected as theme ids
(`ThemeCatalog.isReserved`), and catalogue membership is checked directly
(`ThemeCatalog.isThemeId`), which covers the built-ins.

## Stage-art metadata

Stored per theme (5 tokens × light/dark, verbatim `oklch(...)` strings from
`index.css`, `:root` defaults as the fallback layer the `jhin` theme
carries; the `:root` dark block overrides top/mid/bottom only, highlight
and line inherit). Not emitted by the bootstrap in T85 — the T95 stage
backdrop consumes it. `UiTokens.COLOR_KEYS` stays 56 and `PaletteGen` is
untouched (D3).

## Save-appearance semantics with a themeId

When the payload carries a `themeId`, the server re-derives `canvas`/
`accent` from the catalogue for the saved appearance and ignores the
payload hex fields (a raw dispatch cannot desynchronize a theme from its
seeds). Without a `themeId` the save is the legacy T78 seed save: the hex
fields are validated and persisted as-is and the selected theme stays
untouched. Covered by `SettingsActionsTest.legacySeedSaveWithoutThemeIdKeepsTheSelectedTheme`.
