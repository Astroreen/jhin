import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/design/tokens.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T87: the duty-cycled motion — the upstream stepped keyframes ported
/// verbatim as [Curve]s (index.css:283-327), the duty-cycle durations and
/// the `--ease-drawer` curve parsed from the token surface, and the
/// safe-area helpers.
///
/// The frame-count assertions sample each curve at 120 Hz over one cycle
/// (the way a 120 Hz display drives the compositor) and count the discrete
/// value changes: skeleton 8 (steps(4) × 2 segments), status-pulse 12
/// (steps(6) × 2), status-ping 8 (steps(8) × 1 segment) — a handful of
/// updates per cycle instead of one per vsync (the upstream comment at
/// index.css:286-290; its "~14" is prose, the measured counts are asserted
/// here).
void main() {
  group('T87 — the stepped keyframe curves', () {
    /// Samples one cycle the way a display compositor sees it: mid-frame
    /// (the value rendered during frame i is the curve at its midpoint),
    /// counting the discrete value changes including the wrap into the
    /// next cycle. Mid-frame sampling also keeps the step boundaries off
    /// the sample points (no floating-point floor hazards).
    int changesPerCycle(JhinDutyCycle curve, int samples) {
      var changes = 0;
      double? previous;
      double? first;
      for (var i = 0; i < samples; i++) {
        final value = curve.valueAt((i + 0.5) / samples);
        first ??= value;
        if (previous != null && value != previous) changes++;
        previous = value;
      }
      // The wrap into the next cycle (the last mid-frame → t=0).
      if (previous != first) changes++;
      return changes;
    }

    test('skeleton: steps(4) × 2 segments → 8 updates per 2.4s cycle', () {
      const curve = JhinSkeletonCurve();
      // 2.4s at 120 Hz = 288 frames.
      expect(changesPerCycle(curve, 288), 8);
      // The keyframe anchors (index.css:283-299): the drop segment
      // [42%, 50%] holds the start value through its first quarter, then
      // steps at 44/46/48/50%.
      expect(curve.valueAt(0.0), 1.0);
      expect(curve.valueAt(0.43), 1.0);
      expect(curve.valueAt(0.445), closeTo(1.0 - 0.45 * 0.25, 1e-9));
      expect(curve.valueAt(0.465), closeTo(1.0 - 0.45 * 0.5, 1e-9));
      expect(curve.valueAt(0.485), closeTo(1.0 - 0.45 * 0.75, 1e-9));
      expect(curve.valueAt(0.5), 0.55);
      expect(curve.valueAt(0.91), 0.55);
      // The rise segment [92%, 100%].
      expect(curve.valueAt(0.945), closeTo(0.55 + 0.45 * 0.25, 1e-9));
      expect(curve.valueAt(1.0), 1.0);
    });

    test('status-pulse: steps(6) × 2 segments → 12 updates per 2s cycle', () {
      const curve = JhinStatusPulseCurve();
      // 2s at 120 Hz = 240 frames.
      expect(changesPerCycle(curve, 240), 12);
      // The keyframe anchors (index.css:302-315).
      expect(curve.valueAt(0.0), 1.0);
      expect(curve.valueAt(0.39), 1.0);
      expect(curve.valueAt(0.5), 0.5);
      expect(curve.valueAt(0.9), 0.5);
      expect(curve.valueAt(1.0), 1.0);
    });

    test('status-ping: steps(8) burst + the loop restart → 9 updates', () {
      const curve = JhinStatusPingCurve();
      // 8 burst steps over the first 40% plus the loop restart (the hold
      // at invisible jumps back to the burst start when the cycle wraps).
      expect(changesPerCycle(curve, 240), 9);
      // The burst runs over the first 40% and holds invisible (the
      // progress saturates; opacity/scale derive from it).
      expect(curve.valueAt(0.0), 0.0);
      expect(curve.valueAt(0.2), closeTo(0.5, 1e-9));
      expect(curve.valueAt(0.4), 1.0);
      expect(curve.valueAt(0.9), 1.0);
      // opacity 0.9 → 0, scale 0.75 → 2 (index.css:318-326).
      expect(JhinStatusPingCurve.opacityAt(0.0), 0.9);
      expect(JhinStatusPingCurve.opacityAt(1.0), 0.0);
      expect(JhinStatusPingCurve.scaleAt(0.0), 0.75);
      expect(JhinStatusPingCurve.scaleAt(1.0), 2.0);
    });

    test('the curves are constant outside their animated segments', () {
      // The skeleton holds 1 for the first 42% and 0.55 until 92%.
      const skeleton = JhinSkeletonCurve();
      expect(skeleton.valueAt(0.1), 1.0);
      expect(skeleton.valueAt(0.7), 0.55);
      // The pulse holds 1 for the first 40% and 0.5 until 90%.
      const pulse = JhinStatusPulseCurve();
      expect(pulse.valueAt(0.1), 1.0);
      expect(pulse.valueAt(0.7), 0.5);
    });
  });

  group('T87 — the duty-cycle durations and the drawer curve', () {
    test('parsed from the token surface (index.css:216-220)', () {
      final surface = JhinTokenSurface.defaults();
      expect(
        jhinDutyCycleDuration(surface, 'skeleton', fallback: kSkeletonCycle),
        const Duration(milliseconds: 2400),
      );
      expect(
        jhinDutyCycleDuration(surface, 'statusPulse',
            fallback: kStatusPulseCycle),
        const Duration(milliseconds: 2000),
      );
      expect(
        jhinDutyCycleDuration(surface, 'statusPing', fallback: kStatusPingCycle),
        const Duration(milliseconds: 2000),
      );
    });

    test('malformed durations degrade to the upstream constants', () {
      final surface = JhinTokenSurface.fromOverrides(const {
        'motion': {'skeleton': 'soon', 'statusPulse': -1},
      });
      expect(
        jhinDutyCycleDuration(surface, 'skeleton', fallback: kSkeletonCycle),
        kSkeletonCycle,
      );
      expect(
        jhinDutyCycleDuration(surface, 'statusPulse',
            fallback: kStatusPulseCycle),
        kStatusPulseCycle,
      );
    });

    test('easeDrawer parses to the upstream cubic-bezier', () {
      final surface = JhinTokenSurface.defaults();
      final curve = jhinEaseDrawerCurve(surface);
      expect(curve, isA<Cubic>());
      final cubic = curve as Cubic;
      expect(cubic.a, 0.32);
      expect(cubic.b, 0.72);
      expect(cubic.c, 0.0);
      expect(cubic.d, 1.0);
      // Malformed token → the upstream constant.
      final broken = JhinTokenSurface.fromOverrides(const {
        'motion': {'easeDrawer': 'linear'},
      });
      expect(jhinEaseDrawerCurve(broken), const Cubic(0.32, 0.72, 0.0, 1.0));
    });
  });

  group('T87 — the glass, shadow and length parsers', () {
    test('glass resolves per brightness (index.css:116-118, :146-147)', () {
      final surface = JhinTokenSurface.defaults();
      expect(JhinGlass.of(surface, Brightness.light).blur, 12);
      expect(JhinGlass.of(surface, Brightness.light).opacity, 0.8);
      expect(JhinGlass.of(surface, Brightness.light).saturation, 1.14);
      expect(JhinGlass.of(surface, Brightness.dark).blur, 16);
      expect(JhinGlass.of(surface, Brightness.dark).saturation, 1.08);
    });

    test('composer shadow parses to the upstream BoxShadow', () {
      final surface = JhinTokenSurface.defaults();
      final light = jhinComposerShadow(surface, Brightness.light);
      expect(light, isNotNull);
      expect(light!.offset, const Offset(0, 12));
      expect(light.blurRadius, 28);
      expect(light.spreadRadius, -18);
      expect(light.color.a, closeTo(0.40, 1e-6));
      final dark = jhinComposerShadow(surface, Brightness.dark);
      expect(dark!.offset.dy, 14);
      expect(dark.blurRadius, 32);
      expect(dark.spreadRadius, -18);
      expect(dark.color.a, closeTo(0.75, 1e-6));
    });

    test('inset control shades parse to the 1px top lines', () {
      final surface = JhinTokenSurface.defaults();
      final highlight = jhinControlHighlight(surface);
      expect(highlight!.offset, 1);
      expect(highlight.color.a, closeTo(0.16, 1e-6));
      final pressed = jhinControlPressed(surface);
      expect(pressed!.offset, 1);
      expect(pressed.color.a, closeTo(0.08, 1e-6));
    });

    test('radius lengths parse rem and calc (§4.3)', () {
      expect(parseCssLength('0.625rem'), 10);
      expect(parseCssLength('calc(0.625rem + 4px)'), 14);
      expect(parseCssLength('calc(0.625rem - 2px)'), 8);
      expect(parseCssLength('12px'), 12);
      expect(parseCssLength('nonsense'), isNull);
      // rem scales with the interface size.
      expect(parseCssLength('0.625rem', remPx: 20), 12.5);
      final surface = JhinTokenSurface.defaults();
      expect(
        jhinSurfaceRadius(surface, 'xl2', remPx: 16)!.bottomRight.x,
        18,
      );
    });

    test('dialog and menu glass recipes resolve (index.css:376-419)', () {
      final surface = JhinTokenSurface.defaults();
      const background = Color(0xFF16161E);
      const foreground = Color(0xFFE0E0E0);
      final dialog = JhinDialogGlassRecipe.of(
        surface,
        Brightness.dark,
        background: background,
        foreground: foreground,
      );
      expect(dialog.fill.a, closeTo(background.a * 0.8, 1e-6));
      expect(dialog.borderColor.a, closeTo(foreground.a * 0.10, 1e-6));
      expect(dialog.shadows.single.spreadRadius, -20);
      expect(dialog.insetTop, isNotNull);
      final menu = JhinMenuGlassRecipe.of(
        surface,
        Brightness.light,
        popover: background,
        foreground: foreground,
      );
      // color-mix(popover 18%, popover@80%) → alpha 0.18 + 0.82·0.8.
      expect(menu.fill.a, closeTo(0.836, 1e-3));
    });
  });

  group('T87 — the safe-area helpers (index.css:1031-1042)', () {
    testWidgets('the four sides read MediaQuery.padding with max(…, 0)',
        (tester) async {
      late EdgeInsets full;
      late EdgeInsets bottom;
      await tester.pumpWidget(MediaQuery(
        data: const MediaQueryData(
          padding: EdgeInsets.fromLTRB(12, 24, 20, 34),
        ),
        child: Builder(builder: (context) {
          full = jhinSafeAreaPadding(
            context,
            top: true,
            bottom: true,
            left: true,
            right: true,
          );
          bottom = jhinSafeAreaPadding(context, bottom: true);
          return const SizedBox.shrink();
        }),
      ));
      expect(full, const EdgeInsets.fromLTRB(12, 24, 20, 34));
      expect(bottom, const EdgeInsets.only(bottom: 34));
    });
  });

  group('T87 — the skeleton widget runs the stepped pulse', () {
    testWidgets('the rendered opacity takes 8 discrete values per cycle',
        (tester) async {
      final harness = _SkeletonHarness();
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: JhinDesignScope(
            design: JhinTheme.fallback(),
            child: SizedBox(width: 100, child: harness),
          ),
        ),
      ));
      await tester.pump();
      // One 2.4s cycle pumped in 240 frames of 10ms: the rendered opacity
      // changes exactly 8 times — the stepped curve, not one update per
      // vsync.
      final values = <double>[];
      const frame = Duration(milliseconds: 10);
      for (var i = 0; i < 240; i++) {
        await tester.pump(frame);
        final opacity = tester.widget<Opacity>(find.byType(Opacity).first);
        if (values.isEmpty || values.last != opacity.opacity) {
          values.add(opacity.opacity);
        }
      }
      expect(values.length - 1, 8);
      // The pulse endpoints: full opacity at the cycle start, 0.55 at the
      // midpoint.
      expect(values.first, 1.0);
      expect(values, contains(0.55));
    });
  });
}

/// Renders one `skeleton` node through the registry (the server-shaped
/// entry point).
class _SkeletonHarness extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final ctx = RenderContext(
      state: UiState(),
      registry: UiRegistry.standard(),
      patches: const {},
      setState: (_, __) {},
      patch: (_, __) {},
      navigate: (_) {},
      dispatch: (_) async {},
      openStream: (_, {onStatus}) => const Stream.empty(),
      runDirectives: (_) async {},
      confirm: (_, __) {},
    );
    return ctx.build(
      context,
      UiNode.fromJson(const {
        'type': 'skeleton',
        'variant': 'rect',
        'width': 100,
        'height': 16,
      }),
    );
  }
}
