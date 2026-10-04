import 'package:flutter/material.dart' hide ActionDispatcher;
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/action_dispatcher.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

import 'sdui_fakes.dart';

/// T66 acceptance: form-control parity, `table` v2 and the `tree` primitive
/// (docs/sdui.md §2.5–§2.6). The form/table goldens live beside the T57
/// gallery baselines at `gallery/goldens/form.png` and
/// `gallery/goldens/table.png`.
class _Harness {
  final state = UiState();
  final transport = ScriptedTransport();
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
      navigate: (screen) {},
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

Future<_Harness> _pumpNode(
  WidgetTester tester,
  Object? json, {
  Size? surfaceSize,
}) async {
  if (surfaceSize != null) {
    tester.view.physicalSize = surfaceSize;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
  }
  final harness = _Harness();
  harness.root = UiNode.fromJson(json);
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      body: JhinDesignScope(
        design: JhinTheme.fallback(),
        child: Material(
          child: _Host(harness, harness.root),
        ),
      ),
    ),
  ));
  await tester.pump();
  return harness;
}

Map<String, Object> _action(String name) => {
      'path': '/ui/action/$name',
      'name': name,
      'method': 'POST',
    };

void main() {
  group('PrimitivesBatch11Test', () {
    testWidgets('input decoration group renders and errorText shows',
        (tester) async {
      final h = await _pumpNode(tester, {
        'type': 'input',
        'id': 'email',
        'labelText': 'Email',
        'hintText': 'you@example.com',
        'prefixIcon': 'mail',
        'suffix': '@jhin',
        'helperText': 'Never shared',
        'counterText': '0/20',
        'required': true,
        'errorText': 'Required field',
      });

      expect(find.text('Email'), findsOneWidget);
      expect(find.text('you@example.com'), findsOneWidget);
      expect(find.byIcon(iconFor('mail')!), findsOneWidget);
      expect(find.text('@jhin'), findsOneWidget);
      expect(find.text('Never shared'), findsOneWidget);
      expect(find.text('0/20'), findsOneWidget);
      expect(find.text('Required field'), findsNothing);

      await h.dispatcher.dispatch({
        'path': '/ui/action/send',
        'name': 'send',
        'include': ['email'],
      });
      await tester.pump();
      expect(h.state.errorFor('email'), 'Required field');
      expect(find.text('Required field'), findsOneWidget);
    });

    testWidgets('decorated form composition golden', (tester) async {
      await _pumpNode(tester, {
        'type': 'form',
        'fields': [
          {
            'type': 'input',
            'id': 'email',
            'labelText': 'Email',
            'hintText': 'you@example.com',
            'prefixIcon': 'mail',
            'suffix': '@jhin',
            'helperText': 'Never shared',
            'counterText': '0/20',
            'filled': true,
            'fillColor': '#F5F5F5',
            'border': 'outline',
          },
          {
            'type': 'textarea',
            'id': 'notes',
            'labelText': 'Notes',
            'hintText': 'Write here',
            'minLines': 1,
            'maxLines': 8,
          },
          {
            'type': 'dropdown',
            'id': 'plan',
            'label': 'Plan',
            'items': [
              {'label': 'Basic', 'value': 'basic'},
              {'label': 'Pro', 'value': 'pro'},
            ],
            'value': 'pro',
          },
          {
            'type': 'checkbox',
            'id': 'terms',
            'label': 'Accept terms',
            'value': true,
          },
        ],
        'submit': {
          'label': 'Create',
          'action': _action('create'),
        },
        'autovalidateMode': 'onUserInteraction',
      });

      await expectLater(
        find.byType(Form),
        matchesGoldenFile('gallery/goldens/form.png'),
      );
    });

    testWidgets('input maxLength blocks typing past the limit', (tester) async {
      final h = await _pumpNode(tester, {
        'type': 'input',
        'id': 'code',
        'maxLength': 3,
        'maxLengthEnforcement': 'enforced',
      });

      await tester.enterText(find.byType(TextField), 'abcdefgh');
      await tester.pump();
      final field = tester.widget<TextField>(find.byType(TextField));
      expect(field.maxLength, 3);
      expect(field.controller!.text.length, 3);
      expect(field.controller!.text, 'abc');
      expect(h.state['code'], 'abc');
    });

    testWidgets('input unknown enum literals degrade to defaults',
        (tester) async {
      final h = await _pumpNode(tester, {
        'type': 'input',
        'id': 'f',
        'keyboardType': 'nope',
        'textInputAction': 'zzz',
        'textAlign': 'sideways',
        'textCapitalization': 'shouty',
        'maxLengthEnforcement': 'whenever',
        'floatingLabelBehavior': 'sometimes',
      });

      final field = tester.widget<TextField>(find.byType(TextField));
      expect(field.keyboardType, TextInputType.text);
      expect(field.textInputAction, isNull);
      expect(field.textAlign, TextAlign.start);
      expect(field.textCapitalization, TextCapitalization.none);
      expect(field.maxLengthEnforcement, isNull);
      expect(find.byType(TextField), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'ok');
      expect(h.state['f'], 'ok');
    });

    testWidgets('textarea respects minLines/maxLines and typing works',
        (tester) async {
      final h = await _pumpNode(tester, {
        'type': 'textarea',
        'id': 'notes',
        'minLines': 1,
        'maxLines': 8,
      });

      final field = tester.widget<TextField>(find.byType(TextField));
      expect(field.minLines, 1);
      expect(field.maxLines, 8);
      expect(field.keyboardType, TextInputType.multiline);

      await tester.enterText(find.byType(TextField), 'first line');
      await tester.pump();
      expect(h.state['notes'], 'first line');
    });

    testWidgets('textarea defaults to multiline', (tester) async {
      await _pumpNode(tester, {
        'type': 'textarea',
        'id': 'notes',
      });
      final field = tester.widget<TextField>(find.byType(TextField));
      expect(field.maxLines, greaterThan(1));
    });

    testWidgets('checkbox tristate renders the null state', (tester) async {
      await _pumpNode(tester, {
        'type': 'checkbox',
        'id': 'tri',
        'label': 'Tri',
        'tristate': true,
      });
      final box = tester.widget<CheckboxListTile>(find.byType(CheckboxListTile));
      expect(box.tristate, isTrue);
      expect(box.value, isNull);
    });

    testWidgets('switch track colors land on the tile', (tester) async {
      await _pumpNode(tester, {
        'type': 'switch',
        'id': 's',
        'label': 'Toggle',
        'activeColor': '#112233',
        'trackOutline': '#445566',
      });
      final tile = tester.widget<SwitchListTile>(find.byType(SwitchListTile));
      expect(tile.activeThumbColor, const Color(0xFF112233));
      expect(
        tile.trackOutlineColor!.resolve(const <WidgetState>{}),
        const Color(0xFF445566),
      );
    });

    testWidgets('slider divisions and label land on the widget',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'slider',
        'id': 'r',
        'min': 0,
        'max': 10,
        'step': 2,
        'label': 'Level',
        'value': 6,
      });
      final slider = tester.widget<Slider>(find.byType(Slider));
      expect(slider.divisions, 5);
      expect(slider.label, 'Level');
    });

    testWidgets('dropdown isExpanded lands on the widget', (tester) async {
      await _pumpNode(tester, {
        'type': 'dropdown',
        'id': 'd',
        'items': [
          {'label': 'a', 'value': 1},
        ],
        'isExpanded': true,
        'isDense': true,
        'elevation': 4,
        'hint': 'Pick one',
      });
      final dropdown = tester.widget<DropdownButton<Object?>>(
          find.byType(DropdownButton<Object?>));
      expect(dropdown.isExpanded, isTrue);
      expect(dropdown.isDense, isTrue);
      expect(find.text('Pick one'), findsOneWidget);
    });

    testWidgets('form include submits field values and wires autovalidateMode',
        (tester) async {
      final h = await _pumpNode(tester, {
        'type': 'form',
        'fields': [
          {'type': 'input', 'id': 'name', 'label': 'Name'},
          {'type': 'textarea', 'id': 'bio', 'label': 'Bio'},
        ],
        'submit': {
          'label': 'Save',
          'action': _action('save'),
        },
        'autovalidateMode': 'always',
      });

      final form = tester.widget<Form>(find.byType(Form));
      expect(form.autovalidateMode, AutovalidateMode.always);

      await tester.enterText(find.byType(TextField).at(0), 'Ada');
      await tester.enterText(find.byType(TextField).at(1), 'Hi');
      await tester.pump();
      await tester.tap(find.text('Save'));
      await tester.pump();
      expect(h.transport.calls, hasLength(1));
      expect(h.transport.calls.single.body, {
        'action': 'save',
        'payload': {'name': 'Ada', 'bio': 'Hi'},
      });
    });

    testWidgets('form onChanged fires on a field change', (tester) async {
      final h = await _pumpNode(tester, {
        'type': 'form',
        'fields': [
          {'type': 'input', 'id': 'name', 'label': 'Name'},
        ],
        'submit': {
          'label': 'Save',
          'action': _action('save'),
        },
        'onChanged': _action('form-changed'),
      });

      await tester.enterText(find.byType(TextField), 'Ada');
      await tester.pump();
      expect(h.dispatched, hasLength(1));
      expect(h.dispatched.single['name'], 'form-changed');
    });

    testWidgets('table v2 sortable header, zebra, onRowTap and empty rows',
        (tester) async {
      final h = await _pumpNode(tester, {
        'type': 'table',
        'columns': [
          {'label': 'Name', 'sortable': true},
          {'label': 'Role'},
        ],
        'rows': [
          ['Ada', 'Dev'],
          ['Bob', 'Ops'],
          ['Cy', 'QA'],
        ],
        'zebra': true,
        'hoverable': true,
        'onRowTap': _action('row'),
        'onSort': _action('sort'),
        'sort': {'column': 'Name', 'ascending': true},
      });

      // Sortable header tap dispatches the sort action once.
      await tester.tap(find.text('Name'));
      await tester.pump();
      expect(h.dispatched, hasLength(1));
      expect(h.dispatched.single['name'], 'sort');
      expect(h.dispatched.single['payload'], {'column': 'Name', 'ascending': false});

      // A row tap dispatches onRowTap exactly once.
      await tester.tap(find.text('Bob'));
      await tester.pump();
      expect(h.dispatched, hasLength(2));
      expect(h.dispatched.last['name'], 'row');

      // Zebra: alternating rows carry the theme hover tint.
      final hover = Theme.of(tester.element(find.text('Name'))).hoverColor;
      final tinted = find.byWidgetPredicate(
          (w) => w is Container && w.color == hover);
      expect(tinted, findsNWidgets(1));
    });

    testWidgets('table stickyHeader keeps the header outside the rows',
        (tester) async {
      await _pumpNode(
        tester,
        {
          'type': 'table',
          'columns': [
            {'label': 'Name'},
          ],
          'rows': [
            ['Ada'],
            ['Bob'],
          ],
          'stickyHeader': true,
        },
        surfaceSize: const Size(400, 200),
      );

      final scroll = find.descendant(
        of: find.byType(SingleChildScrollView),
        matching: find.byType(Text),
      );
      expect(find.text('Name'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(SingleChildScrollView),
          matching: find.text('Name'),
        ),
        findsNothing,
      );
      expect(scroll, findsWidgets);
    });

    testWidgets('table missing rows renders the header plus the empty node',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'table',
        'columns': [
          {'label': 'Name'},
          {'label': 'Role'},
        ],
        'empty': {'type': 'text', 'text': 'No rows yet'},
      });

      expect(find.text('Name'), findsOneWidget);
      expect(find.text('Role'), findsOneWidget);
      expect(find.text('No rows yet'), findsOneWidget);
    });

    testWidgets('table v2 golden', (tester) async {
      await _pumpNode(tester, {
        'type': 'table',
        'columns': [
          {'label': 'Name', 'sortable': true, 'align': 'left'},
          {'label': 'Role', 'align': 'center'},
          {'label': 'Age', 'sortable': true, 'align': 'right', 'width': 1},
        ],
        'rows': [
          ['Ada', 'Dev', '36'],
          ['Bob', 'Ops', '29'],
          ['Cy', 'QA', '41'],
          ['Dee', 'Dev', '33'],
        ],
        'zebra': true,
        'hoverable': true,
        'stickyHeader': true,
        'sort': {'column': 'Age', 'ascending': false},
        'onRowTap': _action('row'),
        'onSort': _action('sort'),
      });

      await expectLater(
        find.byType(Column).first,
        matchesGoldenFile('gallery/goldens/table.png'),
      );
    });

    testWidgets('tree renders nested items and toggles expansion',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'tree',
        'items': [
          {
            'label': 'Root',
            'expanded': true,
            'items': [
              {
                'label': 'Child',
                'items': [
                  {'label': 'Grandchild'},
                ],
              },
            ],
          },
          {'label': 'Sibling'},
        ],
      });

      expect(find.text('Root'), findsOneWidget);
      expect(find.text('Child'), findsOneWidget);
      expect(find.text('Sibling'), findsOneWidget);
      // Grandchild is collapsed under `Child`.
      expect(find.text('Grandchild'), findsNothing);

      // Collapse `Root` — its children disappear.
      await tester.tap(find.byType(Icon).first);
      await tester.pump();
      expect(find.text('Child'), findsNothing);
      // Expand again — they come back.
      await tester.tap(find.byType(Icon).first);
      await tester.pump();
      expect(find.text('Child'), findsOneWidget);
    });

    testWidgets('tree onSelect dispatches once with the selected item',
        (tester) async {
      final h = await _pumpNode(tester, {
        'type': 'tree',
        'onSelect': _action('select'),
        'items': [
          {
            'label': 'Root',
            'items': [
              {'label': 'Child'},
            ],
          },
        ],
      });

      await tester.tap(find.text('Root'));
      await tester.pump();
      expect(h.dispatched, hasLength(1));
      expect(h.dispatched.single['name'], 'select');
      final payload =
          Map<String, dynamic>.from(h.dispatched.single['payload'] as Map);
      expect((payload['item'] as Map)['label'], 'Root');
    });

    testWidgets('tree degrades on malformed items without crashing',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'tree',
        'items': [
          'oops',
          {'label': 42},
          {'label': 'Ok', 'items': 'nope', 'expanded': 'yes'},
          {'unknown': true},
        ],
      });
      expect(find.text('Ok'), findsOneWidget);
      expect(find.byType(Text), findsWidgets);
    });
  });
}
