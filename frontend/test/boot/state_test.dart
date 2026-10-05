import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/boot/empty_state.dart';
import 'package:jhin/boot/loading_frame.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/main.dart';
import 'package:jhin/sdui/sdui_runtime.dart';

import '../sdui_fakes.dart';
import '../test_fakes.dart';
import 'state_fixtures.dart';

/// Runtime host over one payload (mirrors sdui_runtime_test.dart).
Widget host(SduiRuntime runtime, Map<String, dynamic> payload) => MaterialApp(
      home: Builder(builder: (context) => runtime.buildScreen(context, payload)),
    );

void main() {
  final design = JhinTheme.from(density: 'comfortable');

  group('T79 fallback compositions render card + skeleton + button', () {
    testWidgets('the offline art renders its card, skeleton and retry button',
        (tester) async {
      await tester
          .pumpWidget(harnessHost(design, child: nodeView(offlineArt())));
      await tester.pump();
      expect(tester.takeException(), isNull);

      expect(find.text('Offline'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      // The skeleton bones run the stepped pulse while motion is allowed.
      expect(find.byType(Opacity), findsWidgets);
    });

    testWidgets('the error art renders its card, skeleton and both buttons',
        (tester) async {
      await tester.pumpWidget(harnessHost(design, child: nodeView(errorArt())));
      await tester.pump();
      expect(tester.takeException(), isNull);

      expect(find.text('Something went wrong'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      expect(find.text('Change server'), findsOneWidget);
      expect(find.byType(Opacity), findsWidgets);
    });

    test('the compositions carry the card/skeleton/button node kinds', () {
      expect(typesOf(offlineArt()), containsAll(<String>['card', 'skeleton', 'button']));
      expect(typesOf(errorArt()), containsAll(<String>['card', 'skeleton', 'button']));
    });
  });

  group('T79 token references resolve against the lattice', () {
    testWidgets('the fallback art padding, radius and border come from '
        r'$token references', (tester) async {
      final custom = JhinTheme.from(
        density: 'comfortable',
        tokens: {
          'spacing': {'md': 30, 'lg': 40},
          'radius': {'md': 22},
        },
      );
      await tester.pumpWidget(harnessHost(custom, child: nodeView(offlineArt())));
      await tester.pump();
      expect(tester.takeException(), isNull);

      // `padding: "$spacing.lg"` (card) and `"$spacing.md"` (frame box; the
      // card primitive also pads itself with `$spacing.md`).
      expect(
        find.byWidgetPredicate(
            (w) => w is Padding && w.padding == const EdgeInsets.all(40.0)),
        findsOneWidget,
      );
      expect(
        find.byWidgetPredicate(
            (w) => w is Padding && w.padding == const EdgeInsets.all(30.0)),
        findsNWidgets(2),
      );

      // `borderRadius: "$radius.md"` and `border: "$color.accent"`.
      final accent = custom.tokens.colors['accent'];
      BoxDecoration? frameBox(WidgetTester tester) {
        for (final w in tester.widgetList<DecoratedBox>(find.byType(DecoratedBox))) {
          final d = w.decoration;
          if (d is BoxDecoration && d.border != null) return d;
        }
        return null;
      }

      final box = frameBox(tester);
      expect(box, isNotNull);
      expect(box!.borderRadius, BorderRadius.circular(22));
      expect(box.border!.top.color, accent);
    });

    testWidgets('the loading frame resolves its token references too',
        (tester) async {
      final custom = JhinTheme.from(
        density: 'comfortable',
        tokens: {
          'spacing': {'md': 30, 'lg': 40},
        },
      );
      await tester.pumpWidget(
          harnessHost(custom, child: nodeView(loadingFrameJson)));
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(
        find.byWidgetPredicate(
            (w) => w is Padding && w.padding == const EdgeInsets.all(40.0)),
        findsOneWidget,
      );
    });
  });

  group('T79 loading frame (stale-while-revalidate)', () {
    testWidgets('a screen fetch in flight shows the skeleton frame, not a '
        'spinner', (tester) async {
      final transport = ScriptedTransport();
      final gate = Completer<Map<String, dynamic>>();
      transport.gates['/ui/screen/next'] = gate;
      final runtime = SduiRuntime(transport: transport);
      addTearDown(runtime.dispose);

      await tester.pumpWidget(host(
        runtime,
        sduiPayload(entry: 'home', screens: {
          'home': {'type': 'text', 'text': 'home-screen'},
        }),
      ));
      await tester.pump();
      expect(find.text('home-screen'), findsOneWidget);

      // The fetch is gated: navigation returns while it is still in flight.
      unawaited(runtime.navigate('next'));
      await tester.pump();
      expect(find.byType(Opacity), findsWidgets);
      expect(find.byType(CircularProgressIndicator), findsNothing);

      gate.complete({'type': 'text', 'text': 'next-screen'});
      await tester.pumpAndSettle();
      expect(find.text('next-screen'), findsOneWidget);
    });

    testWidgets('a previous screen stays visible while the fetch revalidates',
        (tester) async {
      final transport = ScriptedTransport();
      transport.routes['/ui/screen/details'] = {'type': 'text', 'text': 'details-v1'};
      final runtime = SduiRuntime(transport: transport);
      addTearDown(runtime.dispose);

      await tester.pumpWidget(host(
        runtime,
        sduiPayload(entry: 'home', screens: {
          'home': {'type': 'text', 'text': 'home-screen'},
        }),
      ));
      await tester.pump();
      await runtime.navigate('details');
      await tester.pump();
      expect(find.text('details-v1'), findsOneWidget);

      // Network cut mid-revalidate: the stale screen stays, no skeleton.
      final gate = Completer<Map<String, dynamic>>();
      transport.gates['/ui/screen/details'] = gate;
      unawaited(runtime.refresh());
      await tester.pump();
      expect(find.text('details-v1'), findsOneWidget);
      expect(find.byType(Opacity), findsNothing);

      gate.complete({'type': 'text', 'text': 'details-v2'});
      await tester.pumpAndSettle();
      expect(find.text('details-v2'), findsOneWidget);
    });

    testWidgets('the loading frame skeleton has no pulse under '
        'disableAnimations', (tester) async {
      await tester.pumpWidget(harnessHost(
        design,
        child: nodeView(loadingFrameJson),
        disableAnimations: true,
      ));
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(find.byType(Opacity), findsNothing);
    });
  });

  group('T79 client fallbacks over missing server art', () {
    testWidgets('a missing fallbacks key falls back to the built-in '
        'EmptyState', (tester) async {
      final transport = ScriptedTransport();
      transport.routes['/ui/screen/home'] = Exception('screen fetch failed');
      final runtime = SduiRuntime(transport: transport);
      addTearDown(runtime.dispose);

      // The payload carries no `fallbacks` key at all.
      await tester
          .pumpWidget(host(runtime, sduiPayload(entry: 'home', screens: {})));
      await tester.pumpAndSettle();

      expect(find.byType(EmptyState), findsOneWidget);
    });

    testWidgets('an unparseable theme never blocks boot (falls back to '
        'defaults)', (tester) async {
      final storage = AppStorage(
        prefs: InMemoryStringStore(),
        secrets: InMemoryStringStore(),
      );
      final profile = await storage.addProfile(label: 'home', url: 'http://fake');
      await storage.setActiveProfileId(profile.id);

      final transport = FakeTransport(bootstrap: {
        'api': 2,
        'empty': false,
        'title': 'Jhin',
        'theme': 'garbage',
        'tokens': 'garbage',
        'density': 42,
        'entry': 'home',
        'screens': [
          {
            'id': 'home',
            'node': {
              'type': 'screen',
              'title': 'Home',
              'body': {
                'type': 'container',
                'children': [
                  {'type': 'text', 'text': 'theme-corrupt-marker'},
                ],
              },
            },
          },
        ],
      });

      await tester.pumpWidget(JhinApp(
        storage: storage,
        createTransport: (_) => transport,
      ));
      // Profile read → host init → bootstrap fetch → theme applied
      // post-frame (the T53 wiring pump count).
      await tester.pump();
      await tester.pump();
      await tester.pump();
      await tester.pump();

      // The tree booted and the theme fell back to the built-in defaults.
      expect(find.text('theme-corrupt-marker'), findsOneWidget);
      final app = tester.widget<MaterialApp>(find.byType(MaterialApp));
      expect(app.theme, isNotNull);
      expect(app.darkTheme, isNotNull);
      expect(app.themeMode, ThemeMode.system);
      expect(tester.takeException(), isNull);
    });
  });
}
