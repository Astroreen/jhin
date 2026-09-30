import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/boot/boot_error.dart';
import 'package:jhin/boot/empty_state.dart';
import 'package:jhin/boot/sdui_host.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';

import 'test_fakes.dart';

Widget wrap(Widget child) => MaterialApp(home: child);

void main() {
  late InMemoryStringStore prefs;
  late InMemoryStringStore secrets;
  late AppStorage storage;
  late ServerProfile profile;

  setUp(() async {
    prefs = InMemoryStringStore();
    secrets = InMemoryStringStore();
    storage = AppStorage(prefs: prefs, secrets: secrets);
    profile = await storage.addProfile(label: 'home', url: 'https://home');
    await storage.setActiveProfileId(profile.id);
  });

  group('SduiHostTest', () {
    testWidgets('non-empty bootstrap renders the tree through the screen '
        'renderer seam', (tester) async {
      final transport = FakeTransport(
        bootstrap: bootstrapPayload(entry: 'home', marker: 'tree-marker'),
      );

      await tester.pumpWidget(wrap(SduiHost(
        profile: profile,
        storage: storage,
        transport: transport,
      )));
      await tester.pumpAndSettle();

      expect(find.text('tree-marker'), findsOneWidget);
      expect(find.text('Fixture'), findsOneWidget);
      expect(transport.calls, ['getJson:/_jhin/bootstrap']);
    });

    testWidgets('empty bootstrap renders the built-in empty state',
        (tester) async {
      final transport = FakeTransport(bootstrap: kernelBootstrap());

      await tester.pumpWidget(wrap(SduiHost(
        profile: profile,
        storage: storage,
        transport: transport,
        onOpenProfiles: () {},
      )));
      await tester.pumpAndSettle();

      expect(find.byType(EmptyState), findsOneWidget);
      expect(find.text('This server has no UI plugin installed'), findsOneWidget);
      expect(find.text('Kernel version: 0.2.0'), findsOneWidget);
      expect(find.text('Plugins installed: 0'), findsOneWidget);
      expect(find.text('Change server'), findsOneWidget);
    });

    testWidgets('successful bootstrap caches payload and fallbacks on the '
        'profile', (tester) async {
      final transport = FakeTransport(
        bootstrap: bootstrapPayload(
          entry: 'home',
          marker: 'tree-marker',
          offline: offlineFallback(marker: 'offline-art'),
        ),
      );

      await tester.pumpWidget(wrap(SduiHost(
        profile: profile,
        storage: storage,
        transport: transport,
      )));
      await tester.pumpAndSettle();

      final cached = (await storage.readProfiles()).single;
      expect(cached.cachedBootstrap, isNotNull);
      expect(cached.cachedBootstrap!['entry'], 'home');
      expect(cached.fallbacks, isNotNull);
      expect(cached.fallbacks!['offline'], isNotNull);
    });

    testWidgets('poisoned transport renders the cached fallbacks offline node',
        (tester) async {
      final withFallbacks = profile.copyWith(
        fallbacks: {
          'offline': offlineFallback(marker: 'offline-art'),
        },
      );
      await storage.updateProfile(withFallbacks);
      final transport = FakeTransport(
        error: const SocketException('connection refused'),
      );

      await tester.pumpWidget(wrap(SduiHost(
        profile: withFallbacks,
        storage: storage,
        transport: transport,
      )));
      await tester.pumpAndSettle();

      expect(find.text('offline-art'), findsOneWidget);
      expect(find.byType(BootError), findsNothing);
    });

    testWidgets('poisoned transport with no cache renders boot error with '
        'retry and change server', (tester) async {
      final transport = FakeTransport(
        error: const SocketException('connection refused'),
      );
      var opened = 0;

      await tester.pumpWidget(wrap(SduiHost(
        profile: profile,
        storage: storage,
        transport: transport,
        onOpenProfiles: () => opened++,
      )));
      await tester.pumpAndSettle();

      expect(find.byType(BootError), findsOneWidget);
      expect(find.text('Could not reach this server'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      expect(find.text('Change server'), findsOneWidget);

      await tester.tap(find.byKey(const Key('change-server')));
      await tester.pumpAndSettle();
      expect(opened, 1);
    });

    testWidgets('retry re-runs the bootstrap fetch', (tester) async {
      final transport = FakeTransport(
        error: const SocketException('connection refused'),
      );

      await tester.pumpWidget(wrap(SduiHost(
        profile: profile,
        storage: storage,
        transport: transport,
      )));
      await tester.pumpAndSettle();
      expect(find.byType(BootError), findsOneWidget);

      transport.error = null;
      transport.bootstrap = bootstrapPayload(entry: 'home', marker: 'after-retry');

      await tester.tap(find.byKey(const Key('boot-retry')));
      await tester.pumpAndSettle();

      expect(find.text('after-retry'), findsOneWidget);
      expect(find.byType(BootError), findsNothing);
      expect(transport.calls, [
        'getJson:/_jhin/bootstrap',
        'getJson:/_jhin/bootstrap',
      ]);
    });

    testWidgets('overlay button opens the server profile surface',
        (tester) async {
      final transport = FakeTransport(
        bootstrap: bootstrapPayload(entry: 'home', marker: 'tree-marker'),
      );
      var opened = 0;

      await tester.pumpWidget(wrap(SduiHost(
        profile: profile,
        storage: storage,
        transport: transport,
        onOpenProfiles: () => opened++,
      )));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('sdui-host-overlay')));
      await tester.pumpAndSettle();

      expect(opened, 1);
    });

    testWidgets('fallbacks cached by a previous run render on the next mount '
        'failure', (tester) async {
      final transport = FakeTransport(
        bootstrap: bootstrapPayload(
          entry: 'home',
          marker: 'tree-marker',
          offline: offlineFallback(marker: 'offline-art'),
        ),
      );

      await tester.pumpWidget(wrap(SduiHost(
        profile: profile,
        storage: storage,
        transport: transport,
      )));
      await tester.pumpAndSettle();
      expect(find.text('tree-marker'), findsOneWidget);

      final reloaded = (await storage.readProfiles()).single;
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(wrap(SduiHost(
        profile: reloaded,
        storage: storage,
        transport: FakeTransport(
          error: const SocketException('connection refused'),
        ),
      )));
      await tester.pumpAndSettle();

      expect(find.text('offline-art'), findsOneWidget);
    });
  });
}
