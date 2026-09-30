import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/api/jhin_transport.dart';
import 'package:jhin/core/sse/sse_stream.dart';
import 'package:jhin/sdui/primitives/chart_bar.dart';
import 'package:jhin/sdui/primitives/chart_line.dart';
import 'package:jhin/sdui/primitives/chart_pie.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

import 'sdui_fakes.dart';
import 'test_fakes.dart';

/// One in-process SSE fixture: a raw [HttpServer] writing
/// `text/event-stream` frames, one scripted behavior per connection.
class SseFixture {
  SseFixture._(this._server, this._script);

  /// Starts the fixture. The per-connection script writes frames and
  /// returns to drop the connection mid-stream, or holds to keep it open.
  static Future<SseFixture> start(
    Future<void> Function(int connection, HttpResponse response) script,
  ) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final fixture = SseFixture._(server, script);
    server.listen(fixture._handle);
    return fixture;
  }

  final HttpServer _server;
  final Future<void> Function(int, HttpResponse) _script;

  /// Request URIs so far — a reconnect must re-request the same URL.
  final List<String> requestUris = [];

  int connections = 0;

  String get baseUrl => 'http://127.0.0.1:${_server.port}';

  Future<void> _handle(HttpRequest request) async {
    final connection = connections++;
    requestUris.add('${request.uri}');
    final response = request.response;
    response.headers.contentType = ContentType('text', 'event-stream');
    response.headers.set('Cache-Control', 'no-cache');
    // Frames must hit the socket as they are written: under the widget-test
    // binding buffered output is not pushed by `flush()` alone.
    response.bufferOutput = false;
    await _script(connection, response);
    await response.close();
  }

  Future<void> close() => _server.close(force: true);
}

/// Writes one `text/event-stream` frame and flushes it to the client.
Future<void> sendSse(
  HttpResponse response,
  Map<String, dynamic> data, {
  String? id,
}) async {
  if (id != null) response.write('id: $id\n');
  response.write('data: ${jsonEncode(data)}\n\n');
  await response.flush();
}

Map<String, dynamic> textNode(String id, String text) =>
    {'type': 'text', 'id': id, 'text': text};

/// Registry-level harness: one [RenderContext] over a real [JhinTransport]
/// (SSE only), recording client directives and screen-level patches.
class _Harness {
  _Harness(this.transport);

  final JhinTransport transport;
  final state = UiState();
  final directives = <List<dynamic>>[];
  final patches = <String, Map<String, dynamic>>{};
  UiNode node = UiNode(type: 'text', props: const {});

  late final RenderContext ctx = RenderContext(
    state: state,
    registry: UiRegistry.standard(),
    patches: patches,
    setState: (id, value) => state.setValue(id, value),
    patch: (id, props) => patches[id] = {...?patches[id], ...props},
    navigate: (screen) {},
    dispatch: (action) async {},
    openStream: (topic, {onStatus}) => transport.sse(topic, onStatus: onStatus),
    runDirectives: (list) async => directives.add(list),
    confirm: (message, onConfirm) {},
  );
}

/// Pumps [node] (a `stream_view`) against a fresh fixture; tears the tree,
/// the pending timers and the fixture down after the test.
Future<({SseFixture fixture, _Harness harness})> _pumpStreamView(
  WidgetTester tester,
  Map<String, dynamic> node,
  Future<void> Function(int, HttpResponse) script,
) async {
  // The widget-test binding stubs HTTP; these tests talk to real sockets.
  HttpOverrides.global = null;
  final fixture = (await tester.runAsync(() => SseFixture.start(script)))!;
  final transport = JhinTransport(
    baseUrl: Uri.parse(fixture.baseUrl),
    retryPolicy:
        const SseRetryPolicy(base: Duration(milliseconds: 300), jitterRatio: 0),
  );
  final harness = _Harness(transport);
  harness.node = UiNode.fromJson(node);
  addTearDown(() async {
    await tester.pumpWidget(const MaterialApp(home: SizedBox()));
    await flushConnectionTimers(tester);
    await tester.runAsync(fixture.close);
    transport.close();
  });
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(body: Builder(builder: (context) {
      return harness.ctx.build(context, harness.node);
    })),
  ));
  return (fixture: fixture, harness: harness);
}

Map<String, dynamic> streamView({
  String topic = '/stream',
  String mode = 'append',
  int? itemLimit,
  bool? autoScroll,
  Map<String, dynamic>? empty,
}) =>
    {
      'type': 'stream_view',
      'id': 'sv',
      'topic': topic,
      'mode': mode,
      'itemLimit': ?itemLimit,
      'autoScroll': ?autoScroll,
      'empty': ?empty,
    };

/// Polls the real event loop and fake time until [condition] holds or
/// [budget] wall time is spent; returns the elapsed time.
Future<Duration> _waitUntil(
  WidgetTester tester,
  bool Function() condition, {
  Duration budget = const Duration(seconds: 5),
}) async {
  final watch = Stopwatch()..start();
  while (!condition() && watch.elapsed < budget) {
    await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 20)));
    await tester.pump(const Duration(milliseconds: 50));
  }
  watch.stop();
  return watch.elapsed;
}

class _NodeHost extends StatelessWidget {
  const _NodeHost(this.node);

  final UiNode node;

  @override
  Widget build(BuildContext context) {
    final ctx = testRenderContext(UiState());
    return ctx.build(context, node);
  }
}

void main() {
  group('StreamViewTest', () {
    testWidgets('append mode receives three nodes in order', (tester) async {
      final hold = Completer<void>();
      final result = await _pumpStreamView(
        tester,
        streamView(),
        (connection, response) async {
          await sendSse(response, {'node': textNode('a', 'A')});
          await sendSse(response, {'node': textNode('b', 'B')});
          await sendSse(response, {'node': textNode('c', 'C')});
          await hold.future;
        },
      );

      await _waitUntil(tester, () => find.text('C').evaluate().isNotEmpty);
      final texts = tester
          .widgetList<Text>(find.textContaining(RegExp(r'^[ABC]$')))
          .map((widget) => widget.data)
          .toList();
      expect(texts, ['A', 'B', 'C']);
      expect(result.fixture.connections, 1);
    });

    testWidgets('empty prop shows while nothing has arrived', (tester) async {
      final hold = Completer<void>();
      await _pumpStreamView(
        tester,
        streamView(empty: {'type': 'text', 'text': 'no-items'}),
        (connection, response) => hold.future,
      );

      expect(find.text('no-items'), findsOneWidget);
    });

    testWidgets('patch mutates one node props', (tester) async {
      final hold = Completer<void>();
      await _pumpStreamView(
        tester,
        streamView(),
        (connection, response) async {
          await sendSse(response, {'node': textNode('a', 'A')});
          await sendSse(response, {'node': textNode('b', 'before')});
          await sendSse(response, {
            'patch': {
              'id': 'b',
              'props': {'text': 'after'},
            },
          });
          await hold.future;
        },
      );

      await _waitUntil(tester, () => find.text('after').evaluate().isNotEmpty);
      expect(find.text('before'), findsNothing);
      expect(find.text('A'), findsOneWidget);
    });

    testWidgets('remove deletes one node', (tester) async {
      final hold = Completer<void>();
      await _pumpStreamView(
        tester,
        streamView(),
        (connection, response) async {
          await sendSse(response, {'node': textNode('a', 'A')});
          await sendSse(response, {'node': textNode('b', 'B')});
          await sendSse(response, {'remove': 'b'});
          await hold.future;
        },
      );

      await _waitUntil(tester, () => find.text('A').evaluate().isNotEmpty);
      expect(find.text('B'), findsNothing);
      expect(find.text('A'), findsOneWidget);
    });

    testWidgets('itemLimit 2 keeps the last two nodes and drops the oldest',
        (tester) async {
      final hold = Completer<void>();
      await _pumpStreamView(
        tester,
        streamView(itemLimit: 2),
        (connection, response) async {
          await sendSse(response, {'node': textNode('a', 'A')});
          await sendSse(response, {'node': textNode('b', 'B')});
          await sendSse(response, {'node': textNode('c', 'C')});
          await hold.future;
        },
      );

      await _waitUntil(tester, () => find.text('C').evaluate().isNotEmpty);
      expect(find.text('A'), findsNothing);
      expect(find.text('B'), findsOneWidget);
      expect(find.text('C'), findsOneWidget);
    });

    testWidgets('replace mode swaps the content for each node event',
        (tester) async {
      final hold = Completer<void>();
      await _pumpStreamView(
        tester,
        streamView(mode: 'replace'),
        (connection, response) async {
          await sendSse(response, {'node': textNode('a', 'A')});
          await sendSse(response, {'node': textNode('b', 'B')});
          await hold.future;
        },
      );

      await _waitUntil(tester, () => find.text('B').evaluate().isNotEmpty);
      expect(find.text('A'), findsNothing);
      expect(find.text('B'), findsOneWidget);
    });

    testWidgets('autoScroll pins the view to the newest item', (tester) async {
      final hold = Completer<void>();
      await _pumpStreamView(
        tester,
        streamView(autoScroll: true),
        (connection, response) async {
          for (var i = 1; i <= 30; i++) {
            await sendSse(response, {'node': textNode('n$i', 'item-$i')});
          }
          await hold.future;
        },
      );

      await _waitUntil(tester, () => find.text('item-30').evaluate().isNotEmpty);
      final state = tester.state<ScrollableState>(find.byType(Scrollable).first);
      expect(state.position.pixels, greaterThan(0));
      expect(
          state.position.pixels, closeTo(state.position.maxScrollExtent, 1.0));
    });

    testWidgets('client events run through the directive executor',
        (tester) async {
      final hold = Completer<void>();
      final result = await _pumpStreamView(
        tester,
        streamView(),
        (connection, response) async {
          await sendSse(response, {
            'client': [
              {'op': 'toast', 'text': 'from-stream'},
            ],
          });
          await hold.future;
        },
      );

      await _waitUntil(tester, () => result.harness.directives.isNotEmpty);
      expect(result.harness.directives, [
        [
          {'op': 'toast', 'text': 'from-stream'},
        ],
      ]);
    });

    testWidgets('malformed events degrade without killing the view',
        (tester) async {
      final hold = Completer<void>();
      await _pumpStreamView(
        tester,
        streamView(),
        (connection, response) async {
          await sendSse(response, {'node': 'not-a-node'});
          await sendSse(response, {
            'patch': {'id': 42, 'props': 'not-a-map'},
          });
          await sendSse(response, {'remove': 42});
          await sendSse(response, {'unknown-shape': true});
          await sendSse(response, {'node': textNode('a', 'A')});
          await hold.future;
        },
      );

      await _waitUntil(tester, () => find.text('A').evaluate().isNotEmpty);
      expect(tester.takeException(), isNull);
    });
  });

  group('StreamViewChartTest', () {
    // A 3-series fixture shared by the three chart types (§8.3).
    final seriesFixture = [
      {
        'label': 'S1',
        'points': [1, 2, 3],
      },
      {
        'label': 'S2',
        'points': [3, 1, 2],
      },
      {
        'label': 'S3',
        'points': [2, 3, 1],
      },
    ];

    testWidgets('chart_line paints three series with a rendered legend',
        (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: _NodeHost(UiNode.fromJson({
          'type': 'chart_line',
          'series': seriesFixture,
        }))),
      ));

      expect(tester.takeException(), isNull);
      expect(find.text('S1'), findsOneWidget);
      expect(find.text('S2'), findsOneWidget);
      expect(find.text('S3'), findsOneWidget);
      expect(
          find.byWidgetPredicate((widget) =>
              widget is CustomPaint && widget.painter is LineChartPainter),
          findsOneWidget);
    });

    testWidgets('chart_bar paints three grouped series with labels',
        (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: _NodeHost(UiNode.fromJson({
          'type': 'chart_bar',
          'series': [
            {
              'label': 'S1',
              'values': [
                {'label': 'A', 'value': 1},
                {'label': 'B', 'value': 2},
              ],
            },
            {
              'label': 'S2',
              'values': [
                {'label': 'A', 'value': 2},
                {'label': 'B', 'value': 1},
              ],
            },
            {
              'label': 'S3',
              'values': [
                {'label': 'A', 'value': 3},
                {'label': 'B', 'value': 2},
              ],
            },
          ],
        }))),
      ));

      expect(tester.takeException(), isNull);
      expect(find.text('S1'), findsOneWidget);
      expect(find.text('S2'), findsOneWidget);
      expect(find.text('S3'), findsOneWidget);
      expect(find.text('A'), findsOneWidget);
      expect(find.text('B'), findsOneWidget);
      expect(
          find.byWidgetPredicate((widget) =>
              widget is CustomPaint && widget.painter is BarChartPainter),
          findsOneWidget);
    });

    testWidgets('chart_pie paints three slices with a rendered legend',
        (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: _NodeHost(UiNode.fromJson({
          'type': 'chart_pie',
          'items': [
            {'label': 'A', 'value': 1},
            {'label': 'B', 'value': 2},
            {'label': 'C', 'value': 3},
          ],
        }))),
      ));

      expect(tester.takeException(), isNull);
      expect(find.text('A'), findsOneWidget);
      expect(find.text('B'), findsOneWidget);
      expect(find.text('C'), findsOneWidget);
      expect(
          find.byWidgetPredicate((widget) =>
              widget is CustomPaint && widget.painter is PieChartPainter),
          findsOneWidget);
    });
  });

  group('StreamViewFailureTest', () {
    testWidgets('survives a mid-stream restart: reconnects within 5 s and '
        'de-duplicates the replayed nodes', (tester) async {
      final hold = Completer<void>();
      final replay = [
        {'node': textNode('a', 'A')},
        {'node': textNode('b', 'B')},
        {'node': textNode('c', 'C')},
      ];
      final result = await _pumpStreamView(
        tester,
        streamView(),
        (connection, response) async {
          for (var i = 0; i < replay.length; i++) {
            await sendSse(response, replay[i], id: '${i + 1}');
          }
          if (connection == 0) {
            return; // mid-stream drop: the fixture closes the connection
          }
          // Server-side replay on resume (§8.6) plus one new node.
          for (var i = 0; i < replay.length; i++) {
            await sendSse(response, replay[i], id: '${i + 1}');
          }
          await sendSse(response, {'node': textNode('d', 'D')}, id: '4');
          await hold.future;
        },
      );

      await _waitUntil(tester, () => find.text('C').evaluate().isNotEmpty);
      final elapsed =
          await _waitUntil(tester, () => find.text('D').evaluate().isNotEmpty);

      expect(elapsed, lessThan(const Duration(seconds: 5)),
          reason: 'the stream must reconnect within 5 s');
      expect(find.text('D'), findsOneWidget);
      expect(result.fixture.connections, 2);
      expect(result.fixture.requestUris, ['/stream', '/stream']);
      // The replay must not duplicate widgets.
      expect(find.text('A'), findsOneWidget);
      expect(find.text('B'), findsOneWidget);
      expect(find.text('C'), findsOneWidget);
    });

    testWidgets('a replayed remove target stays gone', (tester) async {
      final hold = Completer<void>();
      final result = await _pumpStreamView(
        tester,
        streamView(),
        (connection, response) async {
          await sendSse(response, {'node': textNode('a', 'A')}, id: '1');
          await sendSse(response, {'node': textNode('b', 'B')}, id: '2');
          await sendSse(response, {'remove': 'b'}, id: '3');
          if (connection == 0) {
            return; // mid-stream drop
          }
          // Replay: the server re-sends everything, including the removed
          // node — the view must not resurrect it.
          await sendSse(response, {'node': textNode('a', 'A')}, id: '1');
          await sendSse(response, {'node': textNode('b', 'B')}, id: '2');
          await sendSse(response, {'remove': 'b'}, id: '3');
          await sendSse(response, {'node': textNode('c', 'C')}, id: '4');
          await hold.future;
        },
      );

      await _waitUntil(tester, () => find.text('C').evaluate().isNotEmpty);
      expect(find.text('A'), findsOneWidget);
      expect(find.text('B'), findsNothing);
      expect(result.fixture.connections, 2);
    });

    testWidgets('shows the reconnect indicator while the connection is down',
        (tester) async {
      final hold = Completer<void>();
      await _pumpStreamView(
        tester,
        streamView(),
        (connection, response) async {
          await sendSse(response, {'node': textNode('a', 'A')}, id: '1');
          if (connection == 0) {
            return; // mid-stream drop
          }
          // Stay silent before answering: the view keeps showing the
          // reconnect indicator until the first replayed frame.
          await Future<void>.delayed(const Duration(seconds: 2));
          await sendSse(response, {'node': textNode('a', 'A')}, id: '1');
          await sendSse(response, {'node': textNode('b', 'B')}, id: '2');
          await hold.future;
        },
      );

      await _waitUntil(tester, () => find.text('A').evaluate().isNotEmpty);
      final indicator = find.byKey(const Key('stream-view-reconnecting'));
      var indicatorSeen = false;
      await _waitUntil(tester, () {
        if (indicator.evaluate().isNotEmpty) indicatorSeen = true;
        return find.text('B').evaluate().isNotEmpty;
      });

      expect(indicatorSeen, isTrue,
          reason: 'the reconnect indicator must show while the stream is down');
      expect(find.text('A'), findsOneWidget);
      expect(find.text('B'), findsOneWidget);
    });
  });
}
