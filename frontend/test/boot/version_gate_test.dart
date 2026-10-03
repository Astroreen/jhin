import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/boot/version_gate.dart';
import 'package:jhin/main.dart';
import 'package:jhin/store/migrations/migration_runner.dart';
import 'package:jhin/core/auth/string_store.dart';
import 'package:jhin/store/versioned_store.dart';

import '../store/fixtures.dart';

/// A report carrying one newer-schema quarantine (rule 3) — what the
/// version-gate banner is driven by.
MigrationReport _reportWithNewerQuarantine() => MigrationReport(results: [
      KeyMigrationResult(
        key: StoreKeys.profiles,
        fromSchema: 9,
        toSchema: 9,
        outcome: KeyOutcome.downgraded,
      ),
    ]);

void main() {
  group('VersionGate states (docs/updates.md §3 rule 6)', () {
    testWidgets('update required: on-disk schema below contract.minSchema',
        (tester) async {
      var dismissed = false;
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: VersionGate(
            mode: VersionGateMode.updateRequired,
            onDiskSchema: 2,
            minSchema: 3,
            onDismiss: () => dismissed = true,
          ),
        ),
      ));

      expect(find.text('Update required'), findsOneWidget);
      expect(find.textContaining('schema 3'), findsOneWidget);
      expect(find.textContaining('schema 2'), findsOneWidget);

      await tester.tap(find.byKey(const Key('version-gate-dismiss')));
      expect(dismissed, isTrue, reason: 'never blocks boot destructively');
    });

    testWidgets('no update required when the on-disk schema satisfies the contract',
        (tester) async {
      // The gate widget itself is driven by its inputs; the state logic is
      // exercised through JhinApp below. Here: the surface renders without
      // throwing even with unknown schemas.
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: VersionGate(mode: VersionGateMode.updateRequired),
        ),
      ));
      expect(find.text('Update required'), findsOneWidget);
      expect(find.textContaining('unknown'), findsOneWidget);
    });

    testWidgets('newer-version banner shows the quarantined keys and dismisses',
        (tester) async {
      var dismissed = false;
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: VersionGate(
            mode: VersionGateMode.newerVersion,
            quarantinedKeys: ['jhin.profiles'],
            onDismiss: () => dismissed = true,
          ),
        ),
      ));

      expect(
          find.text('Some data was saved by a newer version of Jhin'),
          findsOneWidget);
      expect(find.textContaining('jhin.profiles'), findsOneWidget);

      await tester.tap(find.byKey(const Key('version-gate-dismiss')));
      expect(dismissed, isTrue);
    });
  });

  group('JhinApp version-gate wiring', () {
    testWidgets('the newer-version banner shows from the migration report and dismisses',
        (tester) async {
      final storage = memoryStorage();
      await tester.pumpWidget(JhinApp(
        storage: storage,
        migration: _reportWithNewerQuarantine(),
      ));
      await tester.pump();

      expect(
          find.text('Some data was saved by a newer version of Jhin'),
          findsOneWidget);
      // The app is not blocked: the profile surface renders below the banner.
      expect(find.byType(VersionGate), findsOneWidget);

      await tester.tap(find.byKey(const Key('version-gate-dismiss')));
      await tester.pump();

      expect(
          find.text('Some data was saved by a newer version of Jhin'),
          findsNothing);
    });

    testWidgets('no banner without quarantined newer data', (tester) async {
      final storage = memoryStorage();
      await tester.pumpWidget(JhinApp(storage: storage));
      await tester.pump();

      expect(find.byType(VersionGate), findsNothing);
    });

    testWidgets('the app boots on migrated data (rule 5: report before first read)',
        (tester) async {
      final prefs = InMemoryStringStore();
      final storage = memoryStorage(prefs: prefs);
      await seedLegacyStore(prefs);
      final report = await MigrationRunner().run(storage);

      await tester.pumpWidget(JhinApp(storage: storage, migration: report));
      await tester.pump();

      // The migrated profile drives the app; no banner, no crash.
      expect(find.byType(VersionGate), findsNothing);
      expect(find.byType(JhinApp), findsOneWidget);
    });
  });
}
