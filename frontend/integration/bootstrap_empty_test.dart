import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';
import 'package:jhin/main.dart';

import '../test/test_fakes.dart';

/// Integration: a fixture answering like a bare kernel (D-7) —
/// `/_jhin/bootstrap` with `empty:true` — must land the client on the
/// built-in empty state (acceptance 1 of T21).
void main() {
  testWidgets('bare kernel fixture renders the built-in empty state',
      (tester) async {
    // The widget-test binding stubs HTTP; these tests talk to a real
    // in-process fixture instead.
    HttpOverrides.global = null;

    late JhinFixture fixture;
    late AppStorage storage;
    late ServerProfile profile;

    await tester.runAsync(() async {
      fixture = await JhinFixture.start(bootstrap: kernelBootstrap());
      storage = AppStorage(
        prefs: InMemoryStringStore(),
        secrets: InMemoryStringStore(),
      );
      profile = await storage.addProfile(
        label: 'bare kernel',
        url: fixture.baseUrl,
      );
      await storage.setActiveProfileId(profile.id);
    });

    await tester.pumpWidget(JhinApp(storage: storage));

    await pumpUntilFound(
        tester, find.text('This server has no UI plugin installed'));
    expect(find.text('Kernel version: 0.2.0'), findsOneWidget);
    expect(find.text('Plugins installed: 0'), findsOneWidget);
    expect(find.text('Change server'), findsOneWidget);
    expect(find.byType(JhinApp), findsOneWidget);

    await flushConnectionTimers(tester);
    await tester.runAsync(fixture.close);
  });
}
