import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';
import 'package:jhin/main.dart';

import '../test/test_fakes.dart';

/// Integration: two in-process fixture servers serving different `entry`
/// screens (§8.2). Switching profiles must tear down the current tree and
/// render the other server's tree through the screen renderer seam —
/// without restarting the app (acceptance 3 of T21).
void main() {
  testWidgets(
      'switching between two fixture servers renders two different trees '
      'without restarting the app', (tester) async {
    // The widget-test binding stubs HTTP; these tests talk to real
    // in-process fixtures instead.
    HttpOverrides.global = null;

    late JhinFixture alpha;
    late JhinFixture beta;
    late AppStorage storage;
    late ServerProfile profileA;
    late ServerProfile profileB;

    await tester.runAsync(() async {
      alpha = await JhinFixture.start(
        bootstrap: bootstrapPayload(
          entry: 'alpha',
          marker: 'alpha-tree',
          title: 'Alpha home',
          offline: offlineFallback(marker: 'alpha-offline'),
        ),
      );
      beta = await JhinFixture.start(
        bootstrap: bootstrapPayload(
          entry: 'beta',
          marker: 'beta-tree',
          title: 'Beta home',
          offline: offlineFallback(marker: 'beta-offline'),
        ),
      );
      storage = AppStorage(
        prefs: InMemoryStringStore(),
        secrets: InMemoryStringStore(),
      );
      profileA =
          await storage.addProfile(label: 'Alpha server', url: alpha.baseUrl);
      profileB =
          await storage.addProfile(label: 'Beta server', url: beta.baseUrl);
      await storage.setActiveProfileId(profileA.id);
    });

    await tester.pumpWidget(JhinApp(storage: storage));
    await pumpUntilFound(tester, find.text('alpha-tree'));
    expect(find.text('beta-tree'), findsNothing);
    expect(find.byType(JhinApp), findsOneWidget);

    // The overlay button opens the client-owned profile surface.
    await tester.tap(find.byKey(const Key('sdui-host-overlay')));
    await tester.pumpAndSettle();
    expect(find.byKey(Key('profile-tile-${profileA.id}')), findsOneWidget);
    expect(find.byKey(Key('profile-tile-${profileB.id}')), findsOneWidget);

    // Switch: the tree tears down and the other server's bootstrap runs.
    await tester.tap(find.byKey(Key('profile-tile-${profileB.id}')));
    await pumpUntilFound(tester, find.text('beta-tree'));
    await pumpUntilGone(tester, find.text('alpha-tree'));
    expect(find.byType(JhinApp), findsOneWidget);

    // Both payloads are cached per profile (§8.7).
    await tester.runAsync(() async {
      final profiles = {
        for (final profile in await storage.readProfiles()) profile.id: profile
      };
      expect(profiles[profileA.id]!.cachedBootstrap?['entry'], 'alpha');
      expect(profiles[profileB.id]!.cachedBootstrap?['entry'], 'beta');
      expect(profiles[profileB.id]!.fallbacks?['offline'], isNotNull);
    });

    await flushConnectionTimers(tester);
    await tester.runAsync(() async {
      await alpha.close();
      await beta.close();
    });
  });
}
