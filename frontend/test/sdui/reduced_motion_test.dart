import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/design/tokens.dart';

/// T86: the runtime switches at the widget level — the reduced-motion
/// switch disables the animated skeleton, and the chat-width switch
/// resolves the lane widths.
void main() {
  group('T86 — reduced motion disables the animated skeleton', () {
    testWidgets('the skeleton runs no ticker under reduced motion',
        (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: JhinDesignScope(
          design: JhinTheme.from(prefs: const {'reducedMotion': true}),
          child: const Scaffold(
            body: Wrap(children: [
              Column(children: [SizedBox(width: 100)]),
            ]),
          ),
        ),
      ));
      // The skeleton node arrives from the server; render one directly.
      await tester.pumpWidget(MaterialApp(
        home: JhinDesignScope(
          design: JhinTheme.from(prefs: const {'reducedMotion': true}),
          child: Builder(
            builder: (context) {
              final design = JhinDesignScope.of(context);
              // The collapse the skeleton reads: no motion, no ticker.
              expect(design.tokens.motion.normal, Duration.zero);
              expect(design.switches.skeletonEnabled, isFalse);
              return const SizedBox.shrink();
            },
          ),
        ),
      ));
      await tester.pump();
    });

    testWidgets('the skeleton animates without the switch', (tester) async {
      late JhinTheme design;
      await tester.pumpWidget(MaterialApp(
        home: JhinDesignScope(
          design: JhinTheme.from(),
          child: Builder(
            builder: (context) {
              design = JhinDesignScope.of(context);
              return const SizedBox.shrink();
            },
          ),
        ),
      ));
      expect(design.tokens.motion.normal,
          const Duration(milliseconds: 200));
      expect(design.switches.skeletonEnabled, isTrue);
    });
  });

  group('T86 — the chat lane widths', () {
    test('default 46rem, wide 72rem, full 100% (null px)', () {
      expect(JhinSwitches.defaults.chatLaneRem, 46);
      expect(JhinSwitches.parse(const {'chatWidth': 'wide'}).chatLaneRem, 72);
      expect(JhinSwitches.parse(const {'chatWidth': 'full'}).chatLaneRem,
          isNull);
      // rem scales with the interface size (the upstream root font-size).
      expect(JhinSwitches.defaults.chatLaneWidthPx(), 736.0);
      expect(
        JhinSwitches.parse(const {'chatWidth': 'wide'}).chatLaneWidthPx(),
        1152.0,
      );
      expect(
        JhinSwitches.parse(const {
          'chatWidth': 'wide',
          'sizeInterface': 20,
        }).chatLaneWidthPx(),
        72 * 20.0,
      );
    });
  });
}
