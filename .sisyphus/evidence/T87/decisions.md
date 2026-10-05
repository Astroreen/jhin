# T87 — decisions and verification notes

Upstream reference: `/tmp/opencode/t3code`, commit `37de6cb`
(`refactor(server): share one keyed lock that releases idle keys (#15577)`).
Every ported value below was re-read from that checkout before coding
(re-verified by the review pass on 2026-10-05).

## Upstream anchors (verified file:line, apps/web/src/index.css)

- Glass tokens: `:116-118` (`--glass-blur: 12px`, `--glass-opacity: 80%`,
  `--glass-saturation: 1.14`), dark `:146-147` (16px, 1.08).
- Inset control shades: `:188-189`; `--ease-drawer`: `:190`;
  `--shadow-composer` + dark: `:193-194`.
- Duty cycles: `skeleton` steps(4) `:283-299`, `status-pulse` steps(6)
  `:302-315`, `status-ping` steps(8) `:317-327`; periods `:216-220`
  (skeleton 2.4s, pulse/ping 2s).
- Glass recipes: `surface-glass` `:334-342`, `alert-glass` `:344-374`,
  `dialog-glass` `:376-390` + `dialog-backdrop` `:391-398`,
  `dropdown-glass` `:405-419` — each with the
  `@supports not (backdrop-filter: …)` solid-fill degradation.
- Safe-area utilities: `pt-safe`/`pb-safe`/`pl-safe`/`pr-safe` `:1031-1042`.

## Plan-vs-upstream discrepancies (do not trust plan prose; measured)

1. **status-ping steps(6) → steps(8).** The plan's step 3 says
   "status-pulse/status-ping steps(6)"; upstream declares steps(6) only for
   `status-pulse` and **steps(8)** for `status-ping` (index.css:317-327).
   Upstream wins: the burst progress is quantized to 8 steps over the first
   40% of the cycle (`JhinStatusPingCurve`).
2. **Skeleton update count.** The upstream comment's "~14 updates per cycle
   at 120 Hz" (index.css:286-290) is prose, not a normative count. The
   measured count of the ported waveform is 8 discrete opacity updates per
   2.4s cycle (steps(4) over two segments plus the endpoints); the widget
   test asserts the measured count, not the prose.
3. **Curve vs keyframe body.** The plan says the duty cycles become
   `AnimationController` curves. The `Curve` contract pins t=0→0 and t=1→1
   (`curves.dart`), which the keyframe bodies violate (they start and end
   at opacity 1). Implemented as `JhinDutyCycle.valueAt(t)` waveforms
   sampled by the controller's value, not `Curve` subclasses.

## The dialog glass scene decision (the open question)

**Question.** The previous worker observed the dialog glass scenes
rendering ~0.22-0.25 alpha over the striped backdrop — the stripes never
"fill the whole scene" under the loose test constraints; only the panel
band paints.

**Decision: test-harness artifact, not a product bug. The test was fixed,
the code is correct.** Reasons, from the verified upstream recipes:

- `dialog-glass` (index.css:376-390) applies to the **dialog panel only**:
  the background at 80% over a blurred+saturated backdrop. Upstream never
  blurs the whole scene with glass — the panel is the only glass element.
- The rest of the viewport is the `dialog-backdrop` scrim
  (index.css:391-398): background at 60% (64% dark) behind a 4px blur.
  The page content stays visible under it, unpainted by any glass layer.
- A golden therefore shows: striped scene + scrim + one glass panel band.
  The stripes outside the panel band are *supposed* to remain visible —
  that is exactly what upstream renders.
- Fixes applied to the harness: `_dialogScene` expands the scene
  (`SizedBox.expand` + `Positioned.fill` stripes) so the capture is not
  sized to the panel, and the glass-vs-solid pair is asserted byte-different
  (`the blur is visible` test), proving the panel band really composites
  the backdrop. The scrim itself rides the runtime `dialog` presentation
  (`_dialogBackdropScrim` in `sdui_runtime.dart`), matching upstream's
  separation of panel glass and backdrop scrim.

## §15.4 — golden target

The goldens are produced on the **flutter_test VM target**
(`flutter test`, no browser): Flutter 3.47.0 stable, Dart 3.13.0
(`evidence/T87/flutter-version.txt`). The web target's `BackdropFilter`
cost remains unmeasured; the degradation path (solid fill) is exercised
through `JhinGlass.debugBackdropSupport` so the behaviour is proven
regardless of platform.

## The in-place diff (kept / fixed)

- **Fixed (bug):** `SduiRuntime.dialog()` read the glass flag from
  `node['props']`, but the wire shape is flat (`UiNode.fromJson` folds
  every top-level key into props), so the glass scrim could never
  activate. Now accepts both the flat and the nested shape.
- **Fixed (formatting):** a collapsed line in `_buildTop`
  (two statements on one line).
- **Fixed (harness):** the dialog scene constraint (above) and the missing
  sixth golden — the skeleton mid-animation stepped frame
  (`skeleton-stepped.png`, captured at 55% of the 2.4s cycle, opacity 0.55).
- **Kept:** everything else — the parsers (`parseCssDuration/Length/Color/
  BoxShadow/InsetShadow`, `parseCubicBezier`), `JhinGlass` +
  `jhinGlassSurface`, the dialog/menu recipes, the duty-cycle waveforms,
  `jhinSafeAreaPadding`, `kComposerSurfaceId`, the primitive wiring
  (card/sheet/dialog/menu/banner glass; button inset lines; container
  composer surface; skeleton pulse; progress reduced-motion static track)
  and the runtime dialog transition (`--ease-drawer`, 0.95→1 scale /
  16px slide, reduced-motion collapse).

## Follow-on test debt from this todo (paid here)

- `test/primitives_batch8_test.dart` and `test/boot/state_test.dart`
  asserted the old `ShaderMask` shimmer; updated to the stepped `Opacity`
  pulse contract.
- 17 committed goldens regenerated — all trace to the two intended visual
  changes (the 1px button inset highlight line, the skeleton opacity
  pulse): fixture-button-basic/propheavy ×2, fixture-dialog-propheavy ×2,
  fixture-menu-basic ×2, fixture-sheet-propheavy ×2,
  fixture-skeleton-basic/propheavy ×2, state-loading/error/offline.
  Nothing else drifted (verified: the full golden set re-ran byte-stable).

## Verification

- `./gradlew :jhin-plugin-ui-default:test :jhin-plugin-ui-kit:test --rerun`
  → BUILD SUCCESSFUL (jvm.txt).
- `scripts/qa/flutter-test.sh test` → 841 tests, All tests passed
  (flutter-full.txt).
- `scripts/qa/t87.sh` → green (checks.txt, flutter-design.txt,
  flutter-sdui.txt, flutter-goldens.txt, flutter-goldens-verify.txt,
  flutter-version.txt, goldens/ with the 6 frames).
- `scripts/qa/t87.sh --fail` → the broken-glass fixture fails the
  degradation probe (checks-fail.txt, degrade-probe.txt); the fixture is
  removed again; exit non-zero.
- `scripts/qa/t78.sh` (regression gate, evidence under
  `T87/t78-regression/`) → green (294 JVM tests, kernel boot, bootstrap
  and settings round-trips).
