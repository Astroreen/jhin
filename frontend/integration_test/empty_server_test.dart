import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/boot/empty_state.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';
import 'package:jhin/main.dart';

import '../test/test_fakes.dart';

/// Integration (T45): an empty server — a bare kernel answering the fallback
/// bootstrap with `empty:true` — must land the client on the built-in empty
/// state and on nothing product-shaped.
///
/// Runs against a live empty server when compiled with
/// `--dart-define=E2E_BASE_URL=<url>` (the kernel of `scripts/qa/e2e-empty.sh`)
/// and against an in-process fixture emitting the kernel fallback bootstrap
/// otherwise.
void main() {
  const liveBase = String.fromEnvironment('E2E_BASE_URL');

  testWidgets('empty server renders the empty state and no product screen',
      (tester) async {
    // The widget-test binding stubs HTTP; these tests talk to a real
    // server (in-process fixture or the live empty kernel) instead.
    HttpOverrides.global = null;

    JhinFixture? fixture;
    late AppStorage storage;

    await tester.runAsync(() async {
      String baseUrl;
      if (liveBase.isEmpty) {
        fixture = await JhinFixture.start(bootstrap: kernelBootstrap());
        baseUrl = fixture!.baseUrl;
      } else {
        baseUrl = liveBase;
      }
      storage = AppStorage(
        prefs: InMemoryStringStore(),
        secrets: InMemoryStringStore(),
      );
      final profile =
          await storage.addProfile(label: 'empty server', url: baseUrl);
      await storage.setActiveProfileId(profile.id);
    });

    await tester.pumpWidget(JhinApp(storage: storage));

    await pumpUntilFound(
        tester, find.text('This server has no UI plugin installed'));
    expect(find.text('Kernel version: 0.2.0'), findsOneWidget);
    expect(find.text('Plugins installed: 0'), findsOneWidget);
    expect(find.text('Change server'), findsOneWidget);
    expect(find.byType(EmptyState), findsOneWidget);

    // No product screen may render against an empty server.
    expect(
        find.textContaining(RegExp(r'Chat|Sessions|Settings|Enroll|Providers')),
        findsNothing);

    await flushConnectionTimers(tester);
    final runningFixture = fixture;
    if (runningFixture != null) {
      await tester.runAsync(runningFixture.close);
    }
  });
}
