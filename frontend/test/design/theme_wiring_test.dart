import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';
import 'package:jhin/main.dart';

import '../test_fakes.dart';

/// T53 wiring: the bootstrap payload's `theme`/`tokens` regenerate the
/// MaterialApp theme pair; the MaterialApp ends up with non-null
/// `theme`/`darkTheme`/`themeMode` even before any payload arrives.
void main() {
  testWidgets('MaterialApp carries the generated theme pair from the '
      'bootstrap payload', (tester) async {
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
      'theme': {
        'appearance': 'dark',
        'canvas': '#16161e',
        'accent': '#7e57c2',
      },
      'tokens': {
        'spacing': {'md': 20},
      },
      'density': 'comfortable',
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
                {'type': 'text', 'text': 'themed-marker'},
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
    // post-frame.
    await tester.pump();
    await tester.pump();
    await tester.pump();
    await tester.pump();

    final app = tester.widget<MaterialApp>(find.byType(MaterialApp));
    expect(app.theme, isNotNull);
    expect(app.darkTheme, isNotNull);
    expect(app.themeMode, ThemeMode.dark);
    // The payload theme regenerated the pair: dark canvas surface, token
    // spacing override visible through the scope.
    expect(app.darkTheme!.colorScheme.surface, const Color(0xFF16161E));
    expect(find.text('themed-marker'), findsOneWidget);
  });

  testWidgets('without a payload the MaterialApp still carries the built-in '
      'defaults', (tester) async {
    final storage = AppStorage(
      prefs: InMemoryStringStore(),
      secrets: InMemoryStringStore(),
    );
    await tester.pumpWidget(JhinApp(
      storage: storage,
      createTransport: (_) => FakeTransport(bootstrap: {}),
    ));
    await tester.pump();

    final app = tester.widget<MaterialApp>(find.byType(MaterialApp));
    expect(app.theme, isNotNull);
    expect(app.darkTheme, isNotNull);
    expect(app.themeMode, ThemeMode.system);
  });
}
