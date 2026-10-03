# Golden gallery (T57)

Visual-regression harness for the primitive catalog. `gallery_nodes.dart` is
generated — never edit it by hand — from the real `Ui` builders on the JVM
side, so every fixture is guaranteed to be a shape the server can actually
emit.

## Files

- `gallery_nodes.dart` — generated fixture list (50 `UiNode` JSON trees, 2 per
  current primitive: a basic variant and a prop-heavy variant exercising the
  box/text/flex/interaction universal surface, including `$token` strings).
- `golden_test.dart` — pumps each fixture through the standard SDUI render
  path at a fixed 800×1200 surface, once with the light theme and once with
  dark (density `comfortable`), and compares against `goldens/*.png`.
- `goldens/` — the committed baseline PNGs.

## Regenerating the fixtures

The fixtures come from
`plugins/ui-kit/src/test/java/com/astroreen/jhin/plugin/uikit/gallery/GalleryDump.java`,
a plain JUnit test (not a separate Gradle task) so the invocation stays
uniform with the rest of the module's tests:

```sh
./gradlew :jhin-plugin-ui-kit:test --tests '*GalleryDump*'
```

This overwrites `gallery_nodes.dart` and (for local inspection only, not
committed) `plugins/ui-kit/build/gallery/coverage.txt`. The generator is
idempotent: re-running it with no builder changes produces a byte-identical
file — `scripts/qa/t57.sh` checks this on every run.

Covers the current 25 primitives only (plan §4.4's 56-primitive catalog is
the future target arriving in later tasks); new primitives get their own
fixtures in their own tasks, and the whole gallery is refreshed at T82.

## Regenerating the golden baselines

After an intentional visual change to a primitive's rendering:

```sh
scripts/qa/flutter-test.sh test/gallery --update-goldens
```

Then run the suite once more without `--update-goldens` to confirm it's
green, review the diffed PNGs under `goldens/` in your usual git diff tool,
and commit them alongside the code change that caused them.

## QA

`scripts/qa/t57.sh` runs the full happy path (regenerate fixtures, idempotency
check, flutter gallery suite, coverage table) and a `--fail` path (corrupts
one baseline on purpose to prove the suite actually catches a regression).
