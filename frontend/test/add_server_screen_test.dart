import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/boot/add_server_screen.dart';
import 'package:jhin/core/api/jhin_transport.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';

Widget wrap(Widget child) => MaterialApp(home: child);

const okHealth = HealthInfo(
  status: 'ok',
  kernel: '0.2.0',
  api: 1,
  plugins: [],
  failed: [],
);

void main() {
  late InMemoryStringStore prefs;
  late InMemoryStringStore secrets;
  late AppStorage storage;
  late List<String> probed;

  setUp(() {
    prefs = InMemoryStringStore();
    secrets = InMemoryStringStore();
    storage = AppStorage(prefs: prefs, secrets: secrets);
    probed = [];
  });

  group('AddServerScreenTest', () {
    testWidgets('url field defaults to https://', (tester) async {
      await tester.pumpWidget(wrap(AddServerScreen(storage: storage)));

      final urlField =
          tester.widget<TextField>(find.byKey(const Key('url-field')));
      final labelField =
          tester.widget<TextField>(find.byKey(const Key('label-field')));
      expect(urlField.controller!.text, 'https://');
      expect(labelField.controller!.text, '');
      expect(find.text('Connect'), findsOneWidget);
    });

    testWidgets('connect stores the profile with the TOFU fingerprint and '
        'makes it active', (tester) async {
      ServerProfile? done;
      await tester.pumpWidget(wrap(AddServerScreen(
        storage: storage,
        probe: (url) async {
          probed.add(url);
          return ProbeResult(health: okHealth, certFingerprint: 'AA:BB');
        },
        onDone: (profile) => done = profile,
      )));
      await tester.pumpAndSettle();

      await tester.enterText(
          find.byKey(const Key('url-field')), 'https://home.example:8443');
      await tester.enterText(find.byKey(const Key('label-field')), 'home');
      await tester.tap(find.byKey(const Key('connect-button')));
      await tester.pumpAndSettle();

      expect(probed, ['https://home.example:8443']);
      expect(done, isNotNull);
      final profiles = await storage.readProfiles();
      expect(profiles, hasLength(1));
      expect(profiles.single.label, 'home');
      expect(profiles.single.url, 'https://home.example:8443');
      expect(profiles.single.certFingerprint, 'AA:BB');
      expect(await storage.readActiveProfileId(), profiles.single.id);
      expect(done!.id, profiles.single.id);
    });

    testWidgets('probe failure shows the transport error verbatim and stores '
        'nothing', (tester) async {
      var done = false;
      await tester.pumpWidget(wrap(AddServerScreen(
        storage: storage,
        probe: (url) async {
          probed.add(url);
          throw Exception('connection refused');
        },
        onDone: (_) => done = true,
      )));
      await tester.pumpAndSettle();

      await tester.enterText(
          find.byKey(const Key('url-field')), 'https://down.example:8443');
      await tester.tap(find.byKey(const Key('connect-button')));
      await tester.pumpAndSettle();

      expect(probed,
          ['https://down.example:8443', 'http://down.example:8443']);
      expect(done, isFalse);
      final errorText =
          tester.widget<Text>(find.byKey(const Key('connect-error'))).data;
      expect(errorText, contains('connection refused'));
      expect(await storage.readProfiles(), isEmpty);
      expect(await storage.readActiveProfileId(), isNull);
    });

    testWidgets('https failure falls back to http and asks before storing an '
        'insecure profile', (tester) async {
      ServerProfile? done;
      await tester.pumpWidget(wrap(AddServerScreen(
        storage: storage,
        probe: (url) async {
          probed.add(url);
          if (url.startsWith('https://')) {
            throw Exception('HandshakeException: WRONG_VERSION_NUMBER');
          }
          return ProbeResult(health: okHealth, certFingerprint: null);
        },
        onDone: (profile) => done = profile,
      )));
      await tester.pumpAndSettle();

      await tester.enterText(
          find.byKey(const Key('url-field')), 'https://home.example:8444');
      await tester.tap(find.byKey(const Key('connect-button')));
      await tester.pumpAndSettle();

      expect(probed, ['https://home.example:8444', 'http://home.example:8444']);
      expect(find.text('Insecure connection'), findsOneWidget);
      expect(await storage.readProfiles(), isEmpty);

      await tester.tap(find.byKey(const Key('insecure-continue')));
      await tester.pumpAndSettle();

      expect(done, isNotNull);
      final profiles = await storage.readProfiles();
      expect(profiles, hasLength(1));
      expect(profiles.single.url, 'http://home.example:8444');
      expect(profiles.single.certFingerprint, isNull);
      expect(await storage.readActiveProfileId(), profiles.single.id);
    });

    testWidgets('cancelling the insecure prompt stores nothing', (tester) async {
      await tester.pumpWidget(wrap(AddServerScreen(
        storage: storage,
        probe: (url) async {
          probed.add(url);
          if (url.startsWith('https://')) {
            throw Exception('HandshakeException: WRONG_VERSION_NUMBER');
          }
          return ProbeResult(health: okHealth, certFingerprint: null);
        },
      )));
      await tester.pumpAndSettle();

      await tester.enterText(
          find.byKey(const Key('url-field')), 'https://home.example:8444');
      await tester.tap(find.byKey(const Key('connect-button')));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('insecure-cancel')));
      await tester.pumpAndSettle();

      expect(await storage.readProfiles(), isEmpty);
      expect(await storage.readActiveProfileId(), isNull);
    });

    testWidgets('http failure falls back to https without prompting',
        (tester) async {
      ServerProfile? done;
      await tester.pumpWidget(wrap(AddServerScreen(
        storage: storage,
        probe: (url) async {
          probed.add(url);
          if (url.startsWith('http://')) {
            throw Exception('connection closed');
          }
          return ProbeResult(health: okHealth, certFingerprint: 'EE:FF');
        },
        onDone: (profile) => done = profile,
      )));
      await tester.pumpAndSettle();

      await tester.enterText(
          find.byKey(const Key('url-field')), 'http://home.example:8444');
      await tester.tap(find.byKey(const Key('connect-button')));
      await tester.pumpAndSettle();

      expect(probed, ['http://home.example:8444', 'https://home.example:8444']);
      expect(find.text('Insecure connection'), findsNothing);
      expect(done, isNotNull);
      final profiles = await storage.readProfiles();
      expect(profiles.single.url, 'https://home.example:8444');
      expect(profiles.single.certFingerprint, 'EE:FF');
    });

    testWidgets('both schemes failing shows a TLS hint', (tester) async {
      await tester.pumpWidget(wrap(AddServerScreen(
        storage: storage,
        probe: (url) async {
          probed.add(url);
          throw Exception('HandshakeException: WRONG_VERSION_NUMBER');
        },
      )));
      await tester.pumpAndSettle();

      await tester.enterText(
          find.byKey(const Key('url-field')), 'https://down.example:8444');
      await tester.tap(find.byKey(const Key('connect-button')));
      await tester.pumpAndSettle();

      expect(probed, hasLength(2));
      final errorText =
          tester.widget<Text>(find.byKey(const Key('connect-error'))).data;
      expect(errorText, contains('TLS handshake failed'));
      expect(await storage.readProfiles(), isEmpty);
    });

    testWidgets('invalid url is rejected inline without probing',
        (tester) async {
      await tester.pumpWidget(wrap(AddServerScreen(
        storage: storage,
        probe: (url) async {
          probed.add(url);
          return ProbeResult(health: okHealth, certFingerprint: null);
        },
      )));
      await tester.pumpAndSettle();

      await tester.enterText(find.byKey(const Key('url-field')), 'not a url');
      await tester.tap(find.byKey(const Key('connect-button')));
      await tester.pumpAndSettle();

      expect(probed, isEmpty);
      expect(find.text('Enter a valid http(s) URL'), findsOneWidget);
      expect(await storage.readProfiles(), isEmpty);
    });

    testWidgets('edit mode prefills fields and saves without probing',
        (tester) async {
      final existing = await storage.addProfile(
        label: 'old',
        url: 'https://old.example',
        certFingerprint: 'CC:DD',
      );
      ServerProfile? done;

      await tester.pumpWidget(wrap(AddServerScreen(
        storage: storage,
        probe: (url) async {
          probed.add(url);
          return ProbeResult(health: okHealth, certFingerprint: null);
        },
        existing: existing,
        onDone: (profile) => done = profile,
      )));
      await tester.pumpAndSettle();

      final urlField =
          tester.widget<TextField>(find.byKey(const Key('url-field')));
      expect(urlField.controller!.text, 'https://old.example');

      await tester.enterText(find.byKey(const Key('label-field')), 'renamed');
      await tester.tap(find.byKey(const Key('connect-button')));
      await tester.pumpAndSettle();

      expect(probed, isEmpty);
      expect(done?.label, 'renamed');
      final updated = (await storage.readProfiles()).single;
      expect(updated.id, existing.id);
      expect(updated.label, 'renamed');
      expect(updated.url, 'https://old.example');
      expect(updated.certFingerprint, 'CC:DD');
    });
  });
}
