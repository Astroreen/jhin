import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T98 tests: the `menu` submenu extensions — the nested `children` popup,
/// the `checked` radio marks, the `separatorBefore` dividers and the sheet
/// presentation of all three.
///
/// Upstream anchors (t3code `apps/web/src`, commit 37de6cb): the snooze
/// submenu with the separator-prefixed `Custom…`
/// (`components/threadActionMenu.logic.ts:147-154`) and the checked
/// `Auto-settle behavior` entries (`:190-201`).
RenderContext _ctx(UiState state, _Spy spy) => RenderContext(
      state: state,
      registry: UiRegistry.standard(),
      patches: {},
      setState: (id, value) => state.setValue(id, value),
      patch: (id, props) {},
      navigate: (screen) {},
      dispatch: (action) async {
        spy.dispatched.add(action);
      },
      openStream: (topic, {onStatus}) => const Stream.empty(),
      runDirectives: (directives) async {},
      confirm: (message, onConfirm) {},
    );

class _Spy {
  final List<Map<String, dynamic>> dispatched = [];
}

final Map<String, dynamic> _menu = {
  'type': 'menu',
  'id': 'probe-menu',
  'trigger': {'type': 'text', 'text': 'open'},
  'items': [
    {
      'label': 'Snooze',
      'icon': 'schedule',
      'children': [
        {'label': 'In 1 hour (9:00 AM)'},
        {'label': 'Tomorrow (9:00 AM)'},
        {
          'label': 'Custom…',
          'separatorBefore': true,
          'action': {'op': 'setState', 'id': 'custom', 'value': true},
        },
      ],
    },
    {
      'label': 'Auto-settle behavior',
      'icon': 'timer',
      'children': [
        {
          'label': 'Enabled',
          'checked': true,
          'action': {'op': 'setState', 'id': 'auto', 'value': true},
        },
        {
          'label': 'Disabled',
          'checked': false,
          'action': {'op': 'setState', 'id': 'auto', 'value': false},
        },
      ],
    },
    {
      'label': 'Archive thread',
      'separatorBefore': true,
      'action': {'op': 'setState', 'id': 'archive', 'value': true},
    },
  ],
};

Future<void> _pump(
  WidgetTester tester,
  Map<String, dynamic> node, {
  _Spy? spy,
  Size size = const Size(800, 600),
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  final d = JhinTheme.from();
  await tester.pumpWidget(
    MaterialApp(
      theme: d.light,
      home: JhinDesignScope(
        design: d,
        child: Scaffold(
          body: Builder(
            builder: (context) =>
                _ctx(UiState(), spy ?? _Spy()).build(context, UiNode.fromJson(node)),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  testWidgets('a children item opens the nested submenu popup and a child '
      'dispatches', (tester) async {
    final spy = _Spy();
    await _pump(tester, _menu, spy: spy, size: const Size(1000, 600));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('Snooze'), findsOneWidget);

    // The submenu opens over the popup; the child dispatches and both
    // routes close.
    await tester.tap(find.text('Snooze'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Custom…'));
    await tester.pumpAndSettle();
    expect(spy.dispatched, hasLength(1));
    expect(spy.dispatched.single['op'], 'setState');
    expect(spy.dispatched.single['id'], 'custom');
    expect(find.text('Snooze'), findsNothing,
        reason: 'the parent popup closed with the child selection');
  });

  testWidgets('checked entries render the check mark and dispatch',
      (tester) async {
    final spy = _Spy();
    await _pump(tester, _menu, spy: spy, size: const Size(1000, 600));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Auto-settle behavior'));
    await tester.pumpAndSettle();
    expect(find.text('Enabled'), findsOneWidget);
    expect(find.text('Disabled'), findsOneWidget);
    expect(find.byIcon(Icons.check), findsOneWidget,
        reason: 'only the checked entry carries the mark');

    await tester.tap(find.text('Disabled'));
    await tester.pumpAndSettle();
    expect(spy.dispatched.single['id'], 'auto');
    expect(spy.dispatched.single['value'], false);
  });

  testWidgets('separatorBefore renders a divider above the entry',
      (tester) async {
    await _pump(tester, _menu, size: const Size(1000, 600));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    // Two dividers: the Custom… separator inside the closed submenu is not
    // built; the Archive thread separator is.
    expect(find.byType(PopupMenuDivider), findsOneWidget);
  });

  testWidgets('the sheet presentation renders children as an indented group '
      'with the checked marks', (tester) async {
    final spy = _Spy();
    await _pump(tester, _menu, spy: spy, size: const Size(500, 600));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    // The submenu children render inline (indented), the parent as a
    // header.
    expect(find.text('In 1 hour (9:00 AM)'), findsOneWidget);
    expect(find.text('Custom…'), findsOneWidget);
    expect(find.byIcon(Icons.check), findsOneWidget);

    await tester.tap(find.text('Custom…'));
    await tester.pumpAndSettle();
    expect(spy.dispatched.single['id'], 'custom');
  });
}
