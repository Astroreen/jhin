import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/boot/add_server_screen.dart';
import 'package:jhin/boot/server_profiles_screen.dart';
import 'package:jhin/core/api/jhin_transport.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';

Widget wrap(Widget child) => MaterialApp(home: child);

Future<ProbeResult> okProbe(String url) async => ProbeResult(
      health: const HealthInfo(
        status: 'ok',
        kernel: '0.2.0',
        api: 1,
        plugins: [],
        failed: [],
      ),
      certFingerprint: 'AA:BB',
    );

void main() {
  late InMemoryStringStore prefs;
  late InMemoryStringStore secrets;
  late AppStorage storage;

  setUp(() {
    prefs = InMemoryStringStore();
    secrets = InMemoryStringStore();
    storage = AppStorage(prefs: prefs, secrets: secrets);
  });

  group('ServerProfilesScreenTest', () {
    testWidgets('add-first mode auto-opens the add screen when empty',
        (tester) async {
      await tester.pumpWidget(wrap(ServerProfilesScreen(
        storage: storage,
        probe: okProbe,
        addFirst: true,
      )));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('url-field')), findsOneWidget);
      expect(find.byType(ServerProfilesScreen, skipOffstage: false),
          findsOneWidget);
    });

    testWidgets('lists stored profiles with label and url', (tester) async {
      await storage.addProfile(label: 'home', url: 'https://home.example:8443');
      await storage.addProfile(label: 'lab', url: 'http://lab.example:8080');

      await tester.pumpWidget(wrap(ServerProfilesScreen(
        storage: storage,
        probe: okProbe,
      )));
      await tester.pumpAndSettle();

      expect(find.text('home'), findsOneWidget);
      expect(find.text('https://home.example:8443'), findsOneWidget);
      expect(find.text('lab'), findsOneWidget);
      expect(find.text('http://lab.example:8080'), findsOneWidget);
    });

    testWidgets('tap switches the active profile and notifies the host',
        (tester) async {
      final first = await storage.addProfile(label: 'a', url: 'https://a');
      final second = await storage.addProfile(label: 'b', url: 'https://b');
      ServerProfile? switched;

      await tester.pumpWidget(wrap(ServerProfilesScreen(
        storage: storage,
        probe: okProbe,
        onSwitch: (profile) => switched = profile,
      )));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(Key('profile-tile-${second.id}')));
      await tester.pumpAndSettle();

      expect(switched?.id, second.id);
      expect(await storage.readActiveProfileId(), second.id);

      await tester.tap(find.byKey(Key('profile-tile-${first.id}')));
      await tester.pumpAndSettle();

      expect(switched?.id, first.id);
      expect(await storage.readActiveProfileId(), first.id);
    });

    testWidgets('add action opens the add screen', (tester) async {
      await tester.pumpWidget(wrap(ServerProfilesScreen(
        storage: storage,
        probe: okProbe,
      )));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('add-server-button')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('url-field')), findsOneWidget);
      expect(find.byKey(const Key('connect-button')), findsOneWidget);
    });

    testWidgets('edit action opens the add screen prefilled in edit mode',
        (tester) async {
      final profile =
          await storage.addProfile(label: 'home', url: 'https://home.example');

      await tester.pumpWidget(wrap(ServerProfilesScreen(
        storage: storage,
        probe: okProbe,
      )));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(Key('profile-edit-${profile.id}')));
      await tester.pumpAndSettle();

      final urlField =
          tester.widget<TextField>(find.byKey(const Key('url-field')));
      final labelField =
          tester.widget<TextField>(find.byKey(const Key('label-field')));
      expect(urlField.controller!.text, 'https://home.example');
      expect(labelField.controller!.text, 'home');
      expect(find.text('Save'), findsOneWidget);
    });

    testWidgets('remove action deletes the profile from storage',
        (tester) async {
      final keep = await storage.addProfile(label: 'keep', url: 'https://keep');
      final drop = await storage.addProfile(label: 'drop', url: 'https://drop');
      var changed = 0;

      await tester.pumpWidget(wrap(ServerProfilesScreen(
        storage: storage,
        probe: okProbe,
        onProfilesChanged: () => changed++,
      )));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(Key('profile-remove-${drop.id}')));
      await tester.pumpAndSettle();

      final profiles = await storage.readProfiles();
      expect(profiles, hasLength(1));
      expect(profiles.single.id, keep.id);
      expect(find.text('drop'), findsNothing);
      expect(changed, greaterThan(0));
    });
  });
}
