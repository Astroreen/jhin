import 'package:flutter/material.dart' hide ActionDispatcher;
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/sdui/action_dispatcher.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/sdui_runtime.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

import 'sdui_fakes.dart';

/// Registry-level test harness: one [UiState], one [ActionDispatcher] over
/// [ScriptedTransport], and recording side channels so tests can assert
/// state writes, dispatched actions and navigations.
class _Harness {
  final state = UiState();
  final transport = ScriptedTransport();
  final navigated = <String>[];
  final dispatched = <Map<String, dynamic>>[];
  UiNode root = UiNode(type: 'text', props: const {});
  late final ActionDispatcher dispatcher;
  late final RenderContext ctx;
  void Function()? notify;

  _Harness() {
    dispatcher = ActionDispatcher(
      transport: transport,
      state: state,
      root: () => root,
      onChanged: _wake,
      runDirectives: (directives) async {},
    );
    ctx = RenderContext(
      state: state,
      registry: UiRegistry.standard(),
      patches: {},
      setState: (id, value) {
        state.setValue(id, value);
        _wake();
      },
      patch: (id, props) {},
      navigate: navigated.add,
      dispatch: (action) {
        dispatched.add(Map<String, dynamic>.from(action));
        return dispatcher.dispatch(action);
      },
      openStream: (topic, {onStatus}) => const Stream.empty(),
      runDirectives: (directives) async {},
      confirm: (message, onConfirm) => _wake(),
    );
  }

  void _wake() => notify?.call();
}

class _Host extends StatefulWidget {
  const _Host(this.harness, this.node);

  final _Harness harness;
  final UiNode node;

  @override
  State<_Host> createState() => _HostState();
}

class _HostState extends State<_Host> {
  @override
  void initState() {
    super.initState();
    widget.harness.notify = () {
      if (mounted) setState(() {});
    };
  }

  @override
  Widget build(BuildContext context) =>
      widget.harness.ctx.build(context, widget.node);
}

Future<_Harness> _pumpNode(WidgetTester tester, Object? json) async {
  final harness = _Harness();
  harness.root = UiNode.fromJson(json);
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(body: _Host(harness, harness.root)),
  ));
  await tester.pump();
  return harness;
}

Finder _sizedBox({double? height, double? width}) => find.byWidgetPredicate(
    (widget) =>
        widget is SizedBox &&
        widget.height == height &&
        widget.width == width &&
        widget.child == null);

Widget _host(SduiRuntime runtime, Map<String, dynamic> payload) => MaterialApp(
      home: Builder(builder: (context) => runtime.buildScreen(context, payload)),
    );

void main() {
  group('PrimitivesBatch1Test', () {
    testWidgets('screen renders title, body and floating action',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'screen',
        'title': 'My screen',
        'body': {'type': 'text', 'text': 'content'},
        'floatingAction': {'type': 'button', 'label': 'Fab'},
      });

      expect(find.text('My screen'), findsOneWidget);
      expect(find.text('content'), findsOneWidget);
      expect(find.widgetWithText(ElevatedButton, 'Fab'), findsOneWidget);
    });

    testWidgets('nav taps navigate by screen id for tabs, bottom and drawer',
        (tester) async {
      final h = await _pumpNode(tester, {
        'type': 'container',
        'children': [
          {
            'type': 'nav',
            'kind': 'tabs',
            'items': [
              {'label': 'Home', 'screen': 'home'},
              {'label': 'Settings', 'icon': 'settings', 'screen': 'settings'},
            ],
          },
          {
            'type': 'nav',
            'kind': 'bottom',
            'items': [
              {'label': 'Files', 'icon': 'list', 'screen': 'files'},
              {'label': 'Chat', 'icon': 'chat', 'screen': 'chat'},
            ],
          },
          {
            'type': 'nav',
            'kind': 'drawer',
            'items': [
              {'label': 'Profile', 'icon': 'person', 'screen': 'profile'},
            ],
          },
        ],
      });

      await tester.tap(find.text('Home'));
      await tester.tap(find.text('Files'));
      await tester.tap(find.text('Profile'));
      expect(h.navigated, ['home', 'files', 'profile']);
    });

    testWidgets('container lays out children with direction, gap and flex',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'container',
        'direction': 'row',
        'gap': 8,
        'align': 'center',
        'scroll': true,
        'children': [
          {'type': 'text', 'text': 'A'},
          {'type': 'text', 'text': 'B', 'flex': 1},
        ],
      });

      expect(find.text('A'), findsOneWidget);
      expect(find.text('B'), findsOneWidget);
      expect(find.byType(SingleChildScrollView), findsOneWidget);
      expect(find.byType(Expanded), findsOneWidget);
      expect(_sizedBox(width: 8), findsOneWidget);
    });

    testWidgets('card renders its title and children', (tester) async {
      await _pumpNode(tester, {
        'type': 'card',
        'title': 'Card title',
        'children': [
          {'type': 'text', 'text': 'body'},
        ],
      });

      expect(find.byType(Card), findsOneWidget);
      expect(find.text('Card title'), findsOneWidget);
      expect(find.text('body'), findsOneWidget);
    });

    testWidgets('text styles, bold and all color formats render',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'container',
        'children': [
          {
            'type': 'text',
            'text': 'Heading',
            'style': 'h1',
            'bold': true,
            'color': '#FF0000',
          },
          {
            'type': 'text',
            'text': 'Mono',
            'style': 'mono',
            'color': '0xFF00FF00',
          },
          {
            'type': 'text',
            'text': 'Cap',
            'style': 'caption',
            'color': 0xFF0000FF,
          },
          {'type': 'text', 'text': 'Plain'},
        ],
      });

      final theme = Theme.of(tester.element(find.text('Plain')));
      final heading = tester.widget<Text>(find.text('Heading'));
      expect(heading.style?.fontSize, theme.textTheme.headlineMedium?.fontSize);
      expect(heading.style?.fontWeight, FontWeight.bold);
      expect(heading.style?.color, const Color(0xFFFF0000));

      final mono = tester.widget<Text>(find.text('Mono'));
      expect(mono.style?.fontFamily, 'monospace');
      expect(mono.style?.color, const Color(0xFF00FF00));

      final cap = tester.widget<Text>(find.text('Cap'));
      expect(cap.style?.fontSize, theme.textTheme.bodySmall?.fontSize);
      expect(cap.style?.color, const Color(0xFF0000FF));

      final plain = tester.widget<Text>(find.text('Plain'));
      expect(plain.style?.fontSize, theme.textTheme.bodyMedium?.fontSize);
    });

    testWidgets('markdown renders inline markup as rich text spans',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'markdown',
        'text': '**bold** _it_',
      });

      expect(find.text('**bold** _it_'), findsNothing);
      final rich = tester.widget<Text>(
          find.byWidgetPredicate((w) => w is Text && w.textSpan != null));
      final spans = (rich.textSpan! as TextSpan).children!.cast<TextSpan>();
      expect(spans.map((s) => s.text), ['bold', ' ', 'it']);
      expect(spans[0].style?.fontWeight, FontWeight.w700);
      expect(spans[2].style?.fontStyle, FontStyle.italic);
    });

    testWidgets('divider renders a rule', (tester) async {
      await _pumpNode(tester, {'type': 'divider'});

      expect(find.byType(Divider), findsOneWidget);
    });

    testWidgets('spacer reserves its size', (tester) async {
      await _pumpNode(tester, {'type': 'spacer', 'size': 24});

      expect(_sizedBox(height: 24), findsOneWidget);
    });

    testWidgets('button is disabled without action and confirm gates '
        'dispatch behind a dialog', (tester) async {
      final transport = ScriptedTransport();
      final runtime = SduiRuntime(transport: transport);
      addTearDown(runtime.dispose);
      await tester.pumpWidget(_host(
        runtime,
        sduiPayload(entry: 'home', screens: {
          'home': {
            'type': 'container',
            'children': [
              {'type': 'button', 'label': 'No action'},
              {
                'type': 'button',
                'label': 'Sure thing',
                'confirm': 'Are you sure?',
                'action': {
                  'path': '/ui/action/send',
                  'name': 'send',
                  'payload': {'x': 1},
                },
              },
            ],
          },
        }),
      ));
      await tester.pump();

      final disabled =
          tester.widget<ElevatedButton>(find.widgetWithText(ElevatedButton, 'No action'));
      expect(disabled.onPressed, isNull);

      await tester.tap(find.text('Sure thing'));
      await tester.pumpAndSettle();
      expect(find.text('Are you sure?'), findsOneWidget);
      expect(find.text('OK'), findsOneWidget);
      expect(find.text('Cancel'), findsOneWidget);
      expect(transport.calls, isEmpty);

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(find.text('Are you sure?'), findsNothing);
      expect(transport.calls, isEmpty);

      await tester.tap(find.text('Sure thing'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();
      expect(transport.calls, hasLength(1));
      expect(transport.calls.single.method, 'POST');
      expect(transport.calls.single.path, '/ui/action/send');
      expect(transport.calls.single.body, {
        'action': 'send',
        'payload': {'x': 1},
      });
    });

    testWidgets('input writes UiState and validation blocks bad values',
        (tester) async {
      final h = await _pumpNode(tester, {
        'type': 'input',
        'id': 'msg',
        'label': 'Msg',
        'required': true,
        'pattern': r'^\d+$',
        'errorText': 'Digits only',
      });

      await tester.enterText(find.byType(TextField), 'abc');
      await tester.pump();
      expect(h.state['msg'], 'abc');

      await h.dispatcher.dispatch({
        'path': '/ui/action/send',
        'name': 'send',
        'include': ['msg'],
      });
      await tester.pump();
      expect(h.transport.calls, isEmpty);
      expect(h.state.errorFor('msg'), 'Digits only');
      expect(find.text('Digits only'), findsOneWidget);

      await tester.enterText(find.byType(TextField), '123');
      await tester.pump();
      expect(h.state['msg'], '123');
      expect(h.state.errorFor('msg'), isNull);

      await h.dispatcher.dispatch({
        'path': '/ui/action/send',
        'name': 'send',
        'include': ['msg'],
      });
      expect(h.transport.calls, hasLength(1));
      expect(h.transport.calls.single.body, {
        'action': 'send',
        'payload': {'msg': '123'},
      });
    });

    testWidgets('dropdown writes the item value and dispatches its action',
        (tester) async {
      final h = await _pumpNode(tester, {
        'type': 'dropdown',
        'id': 'model',
        'label': 'Model',
        'items': [
          {'label': 'GPT', 'value': 'gpt'},
          {'label': 'Num', 'value': 7},
        ],
        'value': 'gpt',
        'action': {'path': '/ui/action/pick', 'name': 'pick'},
      });
      expect(find.text('GPT'), findsOneWidget);

      await tester.tap(find.text('GPT'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Num'));
      await tester.pumpAndSettle();

      expect(h.state['model'], 7);
      expect(h.transport.calls, hasLength(1));
      expect(h.transport.calls.single.path, '/ui/action/pick');
    });

    testWidgets('checkbox honours its value and writes UiState on toggle',
        (tester) async {
      final h = await _pumpNode(tester, {
        'type': 'checkbox',
        'id': 'c',
        'label': 'Enable',
        'value': true,
      });

      expect(tester.widget<CheckboxListTile>(find.byType(CheckboxListTile)).value,
          isTrue);

      await tester.tap(find.text('Enable'));
      await tester.pump();
      expect(h.state['c'], isFalse);

      await tester.tap(find.text('Enable'));
      await tester.pump();
      expect(h.state['c'], isTrue);
    });

    testWidgets('switch honours its value and writes UiState on toggle',
        (tester) async {
      final h = await _pumpNode(tester, {
        'type': 'switch',
        'id': 's',
        'label': 'Stream',
        'value': false,
      });

      expect(tester.widget<SwitchListTile>(find.byType(SwitchListTile)).value,
          isFalse);

      await tester.tap(find.text('Stream'));
      await tester.pump();
      expect(h.state['s'], isTrue);

      await tester.tap(find.text('Stream'));
      await tester.pump();
      expect(h.state['s'], isFalse);
    });

    testWidgets('slider honours min, max, step and writes a double',
        (tester) async {
      final h = await _pumpNode(tester, {
        'type': 'slider',
        'id': 'temp',
        'label': 'Temp',
        'min': 0,
        'max': 2,
        'step': 0.5,
        'value': 1,
      });

      final slider = tester.widget<Slider>(find.byType(Slider));
      expect(slider.value, 1);
      expect(slider.min, 0);
      expect(slider.max, 2);
      expect(slider.divisions, 4);

      slider.onChanged!(1.5);
      await tester.pump();
      expect(h.state['temp'], 1.5);
    });

    testWidgets('a row keeps field primitives bounded (no unbounded-width '
        'assertion)', (tester) async {
      await _pumpNode(tester, {
        'type': 'container',
        'direction': 'row',
        'gap': 8,
        'align': 'center',
        'children': [
          {'type': 'input', 'id': 'messageInput', 'label': 'Message'},
          {
            'type': 'dropdown',
            'id': 'model',
            'items': [
              {'label': 'A', 'value': 'a'},
            ],
            'value': 'a',
          },
          {
            'type': 'button',
            'label': 'Send',
            'action': {'path': '/ui/action/send', 'name': 'send'},
          },
        ],
      });
      await tester.pump();

      expect(tester.takeException(), isNull);
      expect(find.byType(TextField), findsOneWidget);
      // input + dropdown are wrapped in Expanded; the button is not.
      expect(find.byType(Expanded), findsNWidgets(2));
    });

    testWidgets('form collects its fields into the merged submit payload and '
        'blocks submit on a failing field', (tester) async {
      final h = await _pumpNode(tester, {
        'type': 'form',
        'fields': [
          {
            'type': 'input',
            'id': 'name',
            'label': 'Name',
            'value': 'jhin',
            'required': true,
            'errorText': 'Name required',
          },
          {
            'type': 'checkbox',
            'id': 'ok',
            'label': 'OK',
            'value': true,
          },
        ],
        'submit': {
          'label': 'Send',
          'action': {
            'path': '/ui/action/send',
            'name': 'send',
            'payload': {'sessionId': 's1'},
          },
        },
      });

      await tester.tap(find.text('Send'));
      await tester.pumpAndSettle();
      expect(h.transport.calls, hasLength(1));
      expect(h.transport.calls.single.method, 'POST');
      expect(h.transport.calls.single.path, '/ui/action/send');
      expect(h.transport.calls.single.body, {
        'action': 'send',
        'payload': {'sessionId': 's1', 'name': 'jhin', 'ok': true},
      });

      await tester.enterText(find.byType(TextField), '');
      await tester.pump();
      await tester.tap(find.text('Send'));
      await tester.pumpAndSettle();
      expect(h.transport.calls, hasLength(1));
      expect(h.state.errorFor('name'), 'Name required');
      expect(find.text('Name required'), findsOneWidget);
    });
  });

  group('PrimitivesBatch1FailureTest', () {
    // Per-type visible fallbacks for `{}` props (the node degrade rule).
    final fallbacks = <String, Finder Function()>{
      'screen': () => find.text('Missing body'),
      'nav': () => find.text('Missing items'),
      'container': () => find.text('Missing children'),
      'card': () => find.text('Missing children'),
      'text': () => find.text('Missing text'),
      'markdown': () => find.text('Missing text'),
      'divider': () => find.byType(Divider),
      'spacer': () => _sizedBox(height: 8),
      'button': () => find.text('Missing label'),
      'input': () => find.text('Missing id'),
      'dropdown': () => find.text('Missing id'),
      'checkbox': () => find.text('Missing id'),
      'switch': () => find.text('Missing id'),
      'slider': () => find.text('Missing id'),
      'form': () => find.text('Missing fields'),
    };

    for (final entry in fallbacks.entries) {
      testWidgets('${entry.key} with empty props degrades to a visible '
          'fallback without throwing', (tester) async {
        await _pumpNode(tester, {'type': entry.key});

        expect(tester.takeException(), isNull);
        expect(entry.value(), findsOneWidget);
      });
    }
  });
}
