# T86 — decisions and verification notes

Upstream reference: `/tmp/opencode/t3code`, commit `37de6cb`
(`refactor(server): share one keyed lock that releases idle keys (#15577)`).
Every ported value below was re-read from that checkout before coding.

## Upstream anchors (verified file:line)

- Font clamps: `packages/contracts/src/settings.ts:122-139` — interface
  12-20 default 16, prompt 12-20 default 14, code 10-18 default 13.
- Font stacks: `apps/web/src/index.css:167-169` (`--font-sans`,
  `--font-mono`) and `apps/web/src/appearanceFonts.ts:16-19`
  (DEFAULT_SANS_FONT_STACK / DEFAULT_CODE_FONT_STACK); user-family
  composition `appearanceFonts.ts:33-61` (quote rules, `cssFontFamilies`,
  `appearanceFontStack` = custom families before the default); the composer
  falls back to the sans stack (`appearanceFonts.ts:110`).
- Interface size drives the root font-size (`appearanceFonts.ts:95-99`,
  `:113`), so every rem scales with it — the chat lane width is computed as
  rem × interface size.
- Contrast pref: `settings.ts:100-107` — `appearanceContrast` is a
  percentage 50-200, default 100. `apps/web/src/appearanceContrast.ts:3-11`
  derives `--appearance-contrast-base` = min(pref, 100)%, `--appearance-
  contrast-boost` = max(pref - 100, 0)%, `--appearance-contrast-border-
  boost` = boost / 4.
- Contrast formulas: `apps/web/src/index.css:91-94` and `:143` (target
  black in light, white in dark) and `:1505-1614` (the full two-stage
  `color-mix` recipes: foregrounds in oklab toward their own surface, then
  toward the target; borders/inputs in srgb toward transparent, then toward
  a palette foreground with the border boost).
- Chat width: `settings.ts:292` (`comfortable|wide|full`) and
  `index.css:128` (46rem default), `:2031-2038` (wide 72rem, full 100%).
- Diff scheme: `settings.ts:289` (`red-green|blue-orange`), `index.css:2025-
  2028` (default: addition = success, deletion = destructive) and `:2041-
  2045` (blue-orange: blue-600/400, orange-600/400, foregrounds = the lane
  colours). The four Tailwind v4.3.3 OKLCH constants come from the v4.3.3
  `theme.css` (blue-600 oklch(54.6% 0.245 262.881), blue-400 oklch(70.7%
  0.165 254.624), orange-600 oklch(64.6% 0.222 41.116), orange-400
  oklch(75% 0.183 55.934)), converted through the palette generator's own
  OKLCH pipeline for internal consistency (the T84 convention).
- Reduced motion: `index.css:589-602` (`@media (prefers-reduced-motion:
  reduce)` → `animation: none`); the duty-cycle periods `index.css:216-220`
  (skeleton 2.4s, status-pulse/ping 2s).

## Plan-vs-upstream discrepancies (do not trust plan prose; measured)

1. **Font clamps.** The plan's step 4 says "clamped 12-18 / 12-18 / 12-20";
   upstream is interface 12-20, prompt 12-20, code 10-18
   (settings.ts:122-139). Implemented upstream (the T83 finding).
2. **Prompt floor.** The plan applies `prompt = max(size, 16)`
   unconditionally; upstream clamps to 16px only on touch inputs
   (index.css:131 `--font-size-prompt-touch`). Followed the plan (the
   floor is unconditional); the touch-only gating is recorded here.
3. **Contrast pref scale.** The plan says "boost 0-100 from the appearance
   pref"; upstream stores a percentage 50-200 and derives the boost
   (appearanceContrast.ts). Implemented the upstream semantics: pref 50-200
   → base = min(pref, 100)%, boost = max(pref - 100, 0)%, borderBoost =
   boost / 4. The parser accepts both spellings (`appearanceContrast`
   50-200 and the plan's direct `contrastBoost` 0-100). The acceptance's
   "boost 30" = pref 130.
4. **Contrast formula shape.** The plan's one-stage
   `color-mix(foreground, contrastTarget, boost%)` is only the boost stage;
   upstream is two-stage (base mix toward the surface first, index.css:1505-
   1614). Implemented the full two-stage form, including the srgb
   transparent-base borders with the separate border boost.
5. **Chat width literals.** The plan spells the default `default`; upstream
   is `comfortable` (settings.ts:292). The parser accepts both.
6. **Diff scheme literals.** The plan spells the default `default`; upstream
   is `red-green` (settings.ts:289). The parser accepts both.
7. **Density.** The plan mentions `comfortable|compact` only; the §1 token
   lattice (and the existing `JhinDensity`) carries
   `compact|comfortable|spacious`. Kept the three-value lattice enum — the
   switch parses through `JhinDensity.parse`.

## The leftover tokens.dart diff (kept / fixed)

The previous session's uncommitted diff was corrupted and did not compile:

- **Broken (removed):** duplicate `JhinChatWidth` / `JhinDiffColorScheme` /
  `JhinDensity` enum declarations (the second `JhinDensity` collided with
  the §1 lattice enum); references to types that were never defined
  (`JhinFontSizes`, `JhinFontFamilies`, `JhinMotionTokens`,
  `JhinThemePalette`); invented contrast keys (`contrast-boost`,
  `contrast-soft`, `contrast-strong`, `contrast-muted`, `contrast-inverse`
  — no such upstream names); invented font stacks (`ui-sans-serif`, emoji
  fonts — not the stylesheet strings); a negative-boost
  `jhinBoostForeground` (upstream has no negative boost); a parallel
  `JhinDataSwitches` class duplicating `JhinSwitches`.
- **Kept (rewritten where noted):** the font clamp constants and the
  `resolveFontSizes` shape (values verified against settings.ts:122-139);
  the `prompt = max(size, 16)` rule; the switches-parse shape (keys
  renamed to the upstream spellings); the `resolveDiffColors` shape (the
  blue/orange values now come from the OKLCH pipeline, not hardcoded hexes).

## Implementation notes

- The contrast resolution lives in `JhinTheme` (`contrastLight` /
  `contrastDark`, `colorOf`): the palette the recipes resolve against is
  the theme palette (`theme.colors`, the PaletteGen names the server pins
  into the bootstrap) over the assembled scheme's fallbacks, so a bare
  theme still resolves every recipe input.
- `$color.*` node props resolve through the contrast indirection for the
  ambient brightness (`ui_registry.dart` `_resolveNodeTokens` now takes the
  design + brightness); `JhinTokens.resolveToken` stays brightness-agnostic
  (raw palette) for the non-colour namespaces.
- The ThemeData assembly adds the resolved sans stack as the default font
  family (first family + `fontFamilyFallback`) and scales the text theme by
  the interface size over its 16px base (at the default 16 the seeds stand
  unchanged, so the committed goldens are stable).
- Reduced motion: `JhinDesignScope.of` collapses motion when the OS
  `disableAnimations` OR the user switch is on; the skeleton reads the same
  collapse (no ticker under reduced motion).
- The purity gate scans `frontend/lib/sdui/primitives/` only (the
  acceptance wording). Out of scope, recorded for a later todo:
  `sdui_runtime.dart` / `keyboard/palette.dart` (runtime chrome) and
  `ui_registry.dart` (the padding parser constructs `EdgeInsets.all` from
  parsed values — not a literal).
- The chart categorical palette and the axis stroke moved to the token
  layer (`kChartPalette` / `kChartAxisColor` in `design/tokens.dart`) — the
  token layer is the one place allowed to carry palette constants (it
  mirrors upstream's own literal palette definitions).

## Verification

- `./gradlew :jhin-plugin-ui-default:test :jhin-plugin-ui-kit:test --rerun`
  → BUILD SUCCESSFUL (jvm.txt).
- `scripts/qa/flutter-test.sh test` → 820 tests, All tests passed
  (flutter-full.txt).
- `scripts/qa/t86.sh` → green (checks.txt, sweep.txt, token-goldens/ with
  the four boost-30 dumps, flutter-design.txt, flutter-sdui.txt,
  flutter-goldens.txt).
- `scripts/qa/t86.sh --fail` → the fixture primitive with
  `Color(0xFF000000)` fails the purity test and the sweep
  (checks-fail.txt, purity-fail.txt, sweep-fail.txt); the fixture is
  removed again.
- `scripts/qa/t78.sh` → green (the T78 regression gate).
