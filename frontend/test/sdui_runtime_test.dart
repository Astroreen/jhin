import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';
import 'package:jhin/sdui/sdui_runtime.dart';
import 'package:jhin/sdui/ui_registry.dart';

import 'sdui_fakes.dart';

Widget host(SduiRuntime runtime, Map<String, dynamic> payload) => MaterialApp(
      home: Builder(builder: (context) => runtime.buildScreen(context, payload)),
    );

void main() {
  group('SduiRuntimeTest', () {
    testWidgets('navigate, back and replace manage the screen stack',
        (tester) async {
      final transport = ScriptedTransport();
      final runtime = SduiRuntime(transport: transport);
      addTearDown(runtime.dispose);
      await tester.pumpWidget(host(
        runtime,
        sduiPayload(entry: 'home', screens: {
          'home': {'type': 'text', 'text': 'home-screen'},
          'details': {'type': 'text', 'text': 'details-screen'},
          'settings': {'type': 'text', 'text': 'settings-screen'},
        }),
      ));
      await tester.pump();
      expect(find.text('home-screen'), findsOneWidget);

      await runtime.navigate('details');
      await tester.pump();
      expect(find.text('details-screen'), findsOneWidget);
      expect(find.text('home-screen'), findsNothing);

      await runtime.navigate('settings');
      await tester.pump();
      expect(find.text('settings-screen'), findsOneWidget);

      await runtime.back();
      await tester.pump();
      expect(find.text('details-screen'), findsOneWidget);

      await runtime.back();
      await tester.pump();
      expect(find.text('home-screen'), findsOneWidget);

      await runtime.back();
      await tester.pump();
      expect(find.text('home-screen'), findsOneWidget);

      // replace swaps the top entry: it must not grow the stack.
      await runtime.navigate('details');
      await runtime.replace('settings');
      await tester.pump();
      expect(find.text('settings-screen'), findsOneWidget);

      await runtime.back();
      await tester.pump();
      expect(find.text('home-screen'), findsOneWidget);

      // Inline screens (§8.2) are never lazily fetched.
      expect(transport.calls, isEmpty);
    });

    testWidgets('non-inline screens fetch from screenEndpoint and cache',
        (tester) async {
      final transport = ScriptedTransport();
      transport.routes['/ui/screen/details'] = {
        'type': 'text',
        'text': 'details-v1',
      };
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
      expect(
          transport.calls.where((c) => c.path == '/ui/screen/details'),
          hasLength(1));
    });

    testWidgets(
        'cached screens render immediately and revalidate in the background',
        (tester) async {
      final transport = ScriptedTransport();
      transport.routes['/ui/screen/details'] = {
        'type': 'text',
        'text': 'details-v1',
      };
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
      await runtime.back();

      // Newer server content, gated so the revalidation stays in flight.
      final gate = Completer<Map<String, dynamic>>();
      transport.gates['/ui/screen/details'] = gate;

      await runtime.navigate('details');
      await tester.pump();
      expect(find.text('details-v1'), findsOneWidget);
      expect(
          transport.calls.where((c) => c.path == '/ui/screen/details'),
          hasLength(2));

      gate.complete({'type': 'text', 'text': 'details-v2'});
      await tester.pumpAndSettle();
      expect(find.text('details-v2'), findsOneWidget);
    });

    testWidgets('refresh force re-fetches the current screen', (tester) async {
      final transport = ScriptedTransport();
      transport.routes['/ui/screen/details'] = {
        'type': 'text',
        'text': 'details-v1',
      };
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

      transport.routes['/ui/screen/details'] = {
        'type': 'text',
        'text': 'details-v2',
      };
      await runtime.refresh();
      await tester.pump();
      expect(find.text('details-v2'), findsOneWidget);
    });

    testWidgets('setState re-renders interpolation and patch re-renders props',
        (tester) async {
      final transport = ScriptedTransport();
      final runtime = SduiRuntime(transport: transport);
      addTearDown(runtime.dispose);
      await tester.pumpWidget(host(
        runtime,
        sduiPayload(entry: 'home', screens: {
          'home': {
            'type': 'container',
            'children': [
              {'type': 'text', 'text': 'hello \${name}'},
              {'type': 'button', 'id': 'act', 'label': 'Go'},
            ],
          },
        }),
      ));
      await tester.pump();
      expect(find.text('hello \${name}'), findsOneWidget);

      await runtime.runDirectives([
        {'op': 'setState', 'id': 'name', 'value': 'world'},
      ]);
      await tester.pump();
      expect(find.text('hello world'), findsOneWidget);

      await runtime.runDirectives([
        {'op': 'patch', 'id': 'act', 'props': {'label': 'Stop'}},
      ]);
      await tester.pump();
      expect(find.text('Stop'), findsOneWidget);
      expect(find.text('Go'), findsNothing);
    });

    test('setToken stores the profile token and clearToken removes it',
        () async {
      final storage = AppStorage(
        prefs: InMemoryStringStore(),
        secrets: InMemoryStringStore(),
      );
      final profile = await storage.addProfile(
          label: 'home', url: 'https://home.example');
      final transport = ScriptedTransport();
      final runtime = SduiRuntime(
          transport: transport, storage: storage, profile: profile);
      addTearDown(runtime.dispose);

      await runtime.runDirectives([
        {'op': 'setToken', 'value': 'device-token'},
      ]);
      expect((await storage.readProfiles()).single.token, 'device-token');
      expect(transport.token, 'device-token');

      await runtime.runDirectives([
        {'op': 'clearToken'},
      ]);
      expect((await storage.readProfiles()).single.token, isNull);
      expect(transport.token, isNull);
    });

    testWidgets(
        'setServerUrl rewrites the active profile url and reboots to the '
        'bootstrap host', (tester) async {
      final storage = AppStorage(
        prefs: InMemoryStringStore(),
        secrets: InMemoryStringStore(),
      );
      final profile = await storage.addProfile(
          label: 'home', url: 'https://old.example');
      final transportA = ScriptedTransport();
      final transportB = ScriptedTransport();
      transportB.routes['/_jhin/bootstrap'] = sduiPayload(entry: 'new-home', screens: {
        'new-home': {'type': 'text', 'text': 'new-tree'},
      });
      String? rebuiltUrl;
      final runtime = SduiRuntime(
        transport: transportA,
        storage: storage,
        profile: profile,
        createTransport: (p) {
          rebuiltUrl = p.url;
          return transportB;
        },
      );
      addTearDown(runtime.dispose);
      await tester.pumpWidget(host(
        runtime,
        sduiPayload(entry: 'home', screens: {
          'home': {'type': 'text', 'text': 'tree-marker'},
        }),
      ));
      await tester.pump();
      expect(find.text('tree-marker'), findsOneWidget);

      await runtime.runDirectives([
        {'op': 'setServerUrl', 'value': 'https://new.example'},
      ]);
      await tester.pumpAndSettle();

      expect((await storage.readProfiles()).single.url, 'https://new.example');
      expect(rebuiltUrl, 'https://new.example');
      expect(transportB.calls.any((c) => c.path == '/_jhin/bootstrap'), isTrue);
      expect(find.text('new-tree'), findsOneWidget);
    });

    test('openProfiles opens the profile surface', () async {
      var opened = 0;
      final transport = ScriptedTransport();
      final runtime =
          SduiRuntime(transport: transport, onOpenProfiles: () => opened++);
      addTearDown(runtime.dispose);

      await runtime.runDirectives([
        {'op': 'openProfiles'},
      ]);
      expect(opened, 1);
    });

    test('openUrl calls the pluggable handler and degrades without one',
        () async {
      final opened = <String>[];
      final transport = ScriptedTransport();
      final runtime = SduiRuntime(transport: transport, onOpenUrl: opened.add);
      addTearDown(runtime.dispose);

      await runtime.runDirectives([
        {'op': 'openUrl', 'value': 'https://docs.example'},
      ]);
      expect(opened, ['https://docs.example']);

      final bare = SduiRuntime(transport: transport);
      addTearDown(bare.dispose);
      await bare.runDirectives([
        {'op': 'openUrl', 'value': 'https://docs.example'},
      ]);
    });

    testWidgets('toast shows a message and dismisses itself', (tester) async {
      final transport = ScriptedTransport();
      final runtime = SduiRuntime(transport: transport);
      addTearDown(runtime.dispose);
      await tester.pumpWidget(host(
        runtime,
        sduiPayload(entry: 'home', screens: {
          'home': {'type': 'text', 'text': 'home-screen'},
        }),
      ));
      await tester.pump();

      await runtime.runDirectives([
        {'op': 'toast', 'text': 'saved', 'style': 'success'},
      ]);
      await tester.pump();
      expect(find.text('saved'), findsOneWidget);

      await tester.pump(const Duration(seconds: 4));
      expect(find.text('saved'), findsNothing);
    });

    testWidgets('dialog shows a node and dismissDialog closes it',
        (tester) async {
      final transport = ScriptedTransport();
      final runtime = SduiRuntime(transport: transport);
      addTearDown(runtime.dispose);
      await tester.pumpWidget(host(
        runtime,
        sduiPayload(entry: 'home', screens: {
          'home': {'type': 'text', 'text': 'home-screen'},
        }),
      ));
      await tester.pump();

      await runtime.runDirectives([
        {
          'op': 'dialog',
          'node': {'type': 'text', 'text': 'dialog-body'},
        },
      ]);
      await tester.pump();
      expect(find.text('dialog-body'), findsOneWidget);

      await runtime.runDirectives([
        {'op': 'dismissDialog'},
      ]);
      await tester.pump();
      expect(find.text('dialog-body'), findsNothing);
    });

    testWidgets('setScreen installs an in-memory screen without fetching',
        (tester) async {
      final transport = ScriptedTransport();
      final runtime = SduiRuntime(transport: transport);
      addTearDown(runtime.dispose);
      await tester.pumpWidget(host(
        runtime,
        sduiPayload(entry: 'home', screens: {
          'home': {'type': 'text', 'text': 'home-screen'},
        }),
      ));
      await tester.pump();

      await runtime.runDirectives([
        {
          'op': 'setScreen',
          'id': 'custom',
          'node': {'type': 'text', 'text': 'custom-screen'},
        },
      ]);
      await runtime.navigate('custom');
      await tester.pump();
      expect(find.text('custom-screen'), findsOneWidget);
      expect(transport.calls, isEmpty);
    });

    testWidgets('reloadBootstrap drops the screen cache wholesale',
        (tester) async {
      final storage = AppStorage(
        prefs: InMemoryStringStore(),
        secrets: InMemoryStringStore(),
      );
      final profile = await storage.addProfile(
          label: 'home', url: 'https://home.example');
      final transport = ScriptedTransport();
      transport.routes['/ui/screen/details'] = {
        'type': 'text',
        'text': 'details-v1',
      };
      transport.routes['/_jhin/bootstrap'] =
          sduiPayload(entry: 'home2', screens: {
        'home2': {'type': 'text', 'text': 'home2-screen'},
      });
      final runtime = SduiRuntime(
          transport: transport, storage: storage, profile: profile);
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

      final before = (await storage.readProfiles()).single.cachedScreens;
      expect(before!.containsKey('details'), isTrue);

      await runtime.runDirectives([
        {'op': 'reloadBootstrap'},
      ]);
      await tester.pump();

      expect(find.text('home2-screen'), findsOneWidget);
      final after = (await storage.readProfiles()).single.cachedScreens;
      expect(after!.containsKey('details'), isFalse);
    });

    testWidgets('the screen cache is LRU-bounded at 50 screens',
        (tester) async {
      final storage = AppStorage(
        prefs: InMemoryStringStore(),
        secrets: InMemoryStringStore(),
      );
      final profile = await storage.addProfile(
          label: 'home', url: 'https://home.example');
      final transport = ScriptedTransport();
      final runtime = SduiRuntime(
          transport: transport, storage: storage, profile: profile);
      addTearDown(runtime.dispose);
      await tester.pumpWidget(host(
        runtime,
        sduiPayload(entry: 'home', screens: {
          'home': {'type': 'text', 'text': 'home-screen'},
        }),
      ));
      await tester.pump();

      for (var i = 0; i < 55; i++) {
        transport.routes['/ui/screen/s$i'] = {
          'type': 'text',
          'text': 'screen-$i',
        };
        await runtime.navigate('s$i');
        await runtime.back();
      }

      final cached = (await storage.readProfiles()).single.cachedScreens!;
      expect(cached.length, 50);
      expect(cached.containsKey('s0'), isFalse);
      expect(cached.containsKey('s54'), isTrue);
    });

    testWidgets('an unknown directive op still executes the known ones',
        (tester) async {
      final transport = ScriptedTransport();
      final runtime = SduiRuntime(transport: transport);
      addTearDown(runtime.dispose);
      await tester.pumpWidget(host(
        runtime,
        sduiPayload(entry: 'home', screens: {
          'home': {'type': 'text', 'text': 'hello \${name}'},
        }),
      ));
      await tester.pump();

      await runtime.runDirectives([
        {'op': 'definitelyNotAnOp', 'x': 1},
        {'op': 'setState', 'id': 'name', 'value': 'world'},
      ]);
      await tester.pump();
      expect(find.text('hello world'), findsOneWidget);
    });

    testWidgets('unknown node types render the unsupported card, never throw',
        (tester) async {
      final transport = ScriptedTransport();
      final runtime = SduiRuntime(transport: transport);
      addTearDown(runtime.dispose);
      await tester.pumpWidget(host(
        runtime,
        sduiPayload(entry: 'home', screens: {
          'home': {
            'type': 'container',
            'children': [
              {'type': 'nope'},
              {'type': 'text', 'text': 'survivor'},
            ],
          },
        }),
      ));
      await tester.pump();
      expect(find.text('Unsupported UI element: nope'), findsOneWidget);
      expect(find.text('survivor'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('malformed nodes render the unsupported card, never throw',
        (tester) async {
      final transport = ScriptedTransport();
      final runtime = SduiRuntime(transport: transport);
      addTearDown(runtime.dispose);
      await tester.pumpWidget(host(
        runtime,
        sduiPayload(entry: 'home', screens: {
          'home': {
            'type': 'container',
            'children': [
              {'type': 42},
              17,
              {'type': 'text', 'text': 'survivor'},
            ],
          },
        }),
      ));
      await tester.pump();
      expect(find.text('Unsupported UI element: 42'), findsOneWidget);
      expect(find.text('Unsupported UI element: unknown'), findsOneWidget);
      expect(find.text('survivor'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('string children become text nodes', (tester) async {
      final transport = ScriptedTransport();
      final runtime = SduiRuntime(transport: transport);
      addTearDown(runtime.dispose);
      await tester.pumpWidget(host(
        runtime,
        sduiPayload(entry: 'home', screens: {
          'home': {
            'type': 'container',
            'children': [
              'plain string',
              {'type': 'text', 'text': 'sibling'},
            ],
          },
        }),
      ));
      await tester.pump();
      expect(find.text('plain string'), findsOneWidget);
      expect(find.text('sibling'), findsOneWidget);
    });

    testWidgets('one failing node never kills the screen', (tester) async {
      final registry = UiRegistry.standard()
        ..register(
            'bad', (context, node, ctx) => throw StateError('boom'));
      final transport = ScriptedTransport();
      final runtime =
          SduiRuntime(transport: transport, registry: registry);
      addTearDown(runtime.dispose);
      await tester.pumpWidget(host(
        runtime,
        sduiPayload(entry: 'home', screens: {
          'home': {
            'type': 'container',
            'children': [
              {'type': 'bad'},
              {'type': 'text', 'text': 'survivor'},
            ],
          },
        }),
      ));
      await tester.pump();
      expect(find.text('Unsupported UI element: bad'), findsOneWidget);
      expect(find.text('survivor'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('stream_view renders SSE nodes and routes client directives',
        (tester) async {
      final transport = ScriptedTransport();
      final runtime = SduiRuntime(transport: transport);
      addTearDown(runtime.dispose);
      await tester.pumpWidget(host(
        runtime,
        sduiPayload(entry: 'home', screens: {
          'home': {
            'type': 'stream_view',
            'id': 'sv',
            'topic': '/ui/stream/t',
            'mode': 'append',
            'empty': {'type': 'text', 'text': 'no-items'},
          },
        }),
      ));
      await tester.pump();
      expect(find.text('no-items'), findsOneWidget);

      final stream = transport.streamFor('/ui/stream/t');
      stream.add({'node': {'type': 'text', 'text': 'item-1'}});
      await tester.pumpAndSettle();
      expect(find.text('item-1'), findsOneWidget);

      stream.add({
        'client': [
          {'op': 'toast', 'text': 'from-stream'},
        ],
      });
      await tester.pumpAndSettle();
      expect(find.text('from-stream'), findsOneWidget);

      await tester.pump(const Duration(seconds: 4));
      stream.close();
    });

    testWidgets('unparsable when and dollar-brace degrade in the tree',
        (tester) async {
      final transport = ScriptedTransport();
      final runtime = SduiRuntime(transport: transport);
      addTearDown(runtime.dispose);
      await tester.pumpWidget(host(
        runtime,
        sduiPayload(entry: 'home', screens: {
          'home': {
            'type': 'container',
            'children': [
              {
                'type': 'text',
                'text': 'kept \${1 + 2}',
                'when': 'count + 1',
              },
            ],
          },
        }),
      ));
      await tester.pump();
      expect(find.text('kept \${1 + 2}'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
