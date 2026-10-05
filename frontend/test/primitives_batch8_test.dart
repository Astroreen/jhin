import 'package:flutter/material.dart' hide ActionDispatcher;
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T63 acceptance: `list_row`, `badge`, `chip`, `avatar`, `skeleton` and the
/// `list` v2 `sections`/`onReorder`/`empty` surface (docs/sdui.md §2.6).
class _Harness {
  final state = UiState();
  final dispatched = <Map<String, dynamic>>[];
  final confirms = <String>[];
  VoidCallback? onConfirmAccept;

  late final RenderContext ctx = RenderContext(
    state: state,
    registry: UiRegistry.standard(),
    patches: {},
    setState: (id, value) => state.setValue(id, value),
    patch: (id, props) {},
    navigate: (screen) {},
    dispatch: (action) async =>
        dispatched.add(Map<String, dynamic>.from(action)),
    openStream: (topic, {onStatus}) => const Stream.empty(),
    runDirectives: (directives) async {},
    confirm: (message, onConfirm) {
      confirms.add(message);
      onConfirmAccept = onConfirm;
    },
  );
}

class _Host extends StatelessWidget {
  const _Host(this.harness, this.node);

  final _Harness harness;
  final UiNode node;

  @override
  Widget build(BuildContext context) => harness.ctx.build(context, node);
}

Future<_Harness> _pumpNode(
  WidgetTester tester,
  Object? json, {
  bool disableAnimations = false,
}) async {
  final harness = _Harness();
  final node = UiNode.fromJson(json);
  await tester.pumpWidget(MaterialApp(
    home: MediaQuery(
      data: MediaQueryData(disableAnimations: disableAnimations),
      child: Scaffold(
        body: JhinDesignScope(
          design: JhinTheme.fallback(),
          child: Material(
            child: _Host(harness, node),
          ),
        ),
      ),
    ),
  ));
  await tester.pump();
  return harness;
}

/// The grey skeleton bones of the pumped `skeleton` node (§2.6 `variant`).
Finder _bones(WidgetTester tester) {
  final base = Theme.of(tester.element(find.byType(Scaffold)))
      .colorScheme
      .surfaceContainerHighest;
  return find.byWidgetPredicate(
    (w) =>
        w is Container &&
        w.decoration is BoxDecoration &&
        (w.decoration as BoxDecoration).color == base,
  );
}

const _onePixelPng =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

void main() {
  group('list_row', () {
    testWidgets('renders leading/title/subtitle/trailing/badge', (tester) async {
      await _pumpNode(tester, {
        'type': 'list_row',
        'leading': {'type': 'icon', 'icon': 'settings'},
        'title': 'Fix the plugin loader',
        'subtitle': 'you: pushing the patch',
        'trailing': {'type': 'text', 'text': 'now'},
        'badge': {'type': 'badge', 'count': 3},
      });
      expect(find.byIcon(iconFor('settings')!), findsOneWidget);
      expect(find.text('Fix the plugin loader'), findsOneWidget);
      expect(find.text('you: pushing the patch'), findsOneWidget);
      expect(find.text('now'), findsOneWidget);
      expect(find.text('3'), findsOneWidget);
    });

    testWidgets('tap dispatches action exactly once', (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'list_row',
        'title': 'Row',
        'action': {'name': 'open', 'method': 'POST', 'path': '/ui/action/open'},
      });
      await tester.tap(find.byType(InkWell));
      await tester.pump();
      expect(harness.dispatched, hasLength(1));
      expect(harness.dispatched.single['name'], 'open');
    });

    testWidgets('long-press dispatches onLongPress only', (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'list_row',
        'title': 'Row',
        'action': {'name': 'open', 'method': 'POST', 'path': '/ui/action/open'},
        'onLongPress': {
          'name': 'menu',
          'method': 'POST',
          'path': '/ui/action/menu',
        },
      });
      await tester.longPress(find.byType(InkWell));
      await tester.pump();
      expect(harness.dispatched, hasLength(1));
      expect(harness.dispatched.single['name'], 'menu');
    });

    testWidgets('selected:true shows the selected tint', (tester) async {
      await _pumpNode(tester, {
        'type': 'list_row',
        'title': 'Row',
        'selected': true,
      });
      final expected = Theme.of(tester.element(find.byType(Scaffold)))
          .colorScheme
          .secondaryContainer;
      expect(
        find.byWidgetPredicate((w) => w is ColoredBox && w.color == expected),
        findsOneWidget,
      );

      await _pumpNode(tester, {'type': 'list_row', 'title': 'Row'});
      expect(
        find.byWidgetPredicate((w) => w is ColoredBox && w.color == expected),
        findsNothing,
      );
    });

    testWidgets('dragHandle:true renders the handle widget', (tester) async {
      await _pumpNode(tester, {
        'type': 'list_row',
        'title': 'Row',
        'dragHandle': true,
      });
      expect(find.byIcon(Icons.drag_handle), findsOneWidget);
    });
  });

  group('badge', () {
    testWidgets('count above max renders the capped form', (tester) async {
      await _pumpNode(tester, {
        'type': 'badge',
        'count': 150,
        'max': 99,
      });
      expect(find.text('99+'), findsOneWidget);
    });

    testWidgets('dot:true renders a dot without a label', (tester) async {
      await _pumpNode(tester, {
        'type': 'badge',
        'label': 'hidden',
        'dot': true,
      });
      expect(find.text('hidden'), findsNothing);
      expect(
        find.byWidgetPredicate(
          (w) =>
              w is Container &&
              w.decoration is BoxDecoration &&
              (w.decoration as BoxDecoration).shape == BoxShape.circle,
        ),
        findsOneWidget,
      );
    });
  });

  group('chip', () {
    testWidgets('every variant renders', (tester) async {
      await _pumpNode(tester, {'type': 'chip', 'label': 'Assist'});
      expect(find.byType(Chip), findsOneWidget);
      expect(find.text('Assist'), findsOneWidget);

      await _pumpNode(tester, {
        'type': 'chip',
        'label': 'Filter',
        'variant': 'filter',
      });
      expect(find.byType(FilterChip), findsOneWidget);

      await _pumpNode(tester, {
        'type': 'chip',
        'label': 'Input',
        'variant': 'input',
      });
      expect(find.byType(InputChip), findsOneWidget);

      await _pumpNode(tester, {
        'type': 'chip',
        'label': 'Action',
        'variant': 'action',
      });
      expect(find.byType(ActionChip), findsOneWidget);
    });

    testWidgets('tap on a filter chip toggles selected', (tester) async {
      await _pumpNode(tester, {
        'type': 'chip',
        'label': 'Filter',
        'variant': 'filter',
      });
      expect(tester.widget<FilterChip>(find.byType(FilterChip)).selected, isFalse);
      await tester.tap(find.byType(FilterChip));
      await tester.pump();
      expect(tester.widget<FilterChip>(find.byType(FilterChip)).selected, isTrue);
    });

    testWidgets('onDeleted with an action dispatches from the delete icon',
        (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'chip',
        'label': 'Input',
        'variant': 'input',
        'onDeleted': {
          'name': 'remove',
          'method': 'POST',
          'path': '/ui/action/remove',
        },
      });
      expect(find.byIcon(Icons.delete), findsOneWidget);
      await tester.tap(find.byIcon(Icons.delete));
      await tester.pump();
      expect(harness.dispatched, hasLength(1));
      expect(harness.dispatched.single['name'], 'remove');
    });

    testWidgets('onDeleted without an action shows no delete affordance',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'chip',
        'label': 'Input',
        'variant': 'input',
      });
      expect(find.byIcon(Icons.delete), findsNothing);

      await _pumpNode(tester, {
        'type': 'chip',
        'label': 'Input',
        'variant': 'input',
        'onDeleted': 'not-an-action',
      });
      expect(find.byIcon(Icons.delete), findsNothing);
      debugPrint('T63_CHIP_HIDDEN affordance=absent (no onDeleted action)');
    });
  });

  group('avatar', () {
    testWidgets('renders image/initials/icon variants', (tester) async {
      await _pumpNode(tester, {'type': 'avatar', 'initials': 'JD'});
      expect(find.text('JD'), findsOneWidget);

      await _pumpNode(tester, {'type': 'avatar', 'icon': 'settings'});
      expect(find.byIcon(iconFor('settings')!), findsOneWidget);

      await _pumpNode(tester, {'type': 'avatar', 'image': _onePixelPng});
      expect(find.byType(Image), findsOneWidget);
    });

    testWidgets('unknown shape degrades without throwing', (tester) async {
      await _pumpNode(tester, {
        'type': 'avatar',
        'initials': 'ZZ',
        'shape': 'triangle',
      });
      expect(tester.takeException(), isNull);
      expect(find.text('ZZ'), findsOneWidget);
    });
  });

  group('skeleton', () {
    testWidgets('every variant renders', (tester) async {
      await _pumpNode(tester, {
        'type': 'skeleton',
        'variant': 'text',
        'lines': 2,
        'shimmer': false,
      });
      expect(tester.takeException(), isNull);
      expect(_bones(tester), findsNWidgets(2));

      await _pumpNode(tester, {
        'type': 'skeleton',
        'variant': 'circle',
        'shimmer': false,
      });
      expect(_bones(tester), findsOneWidget);

      await _pumpNode(tester, {
        'type': 'skeleton',
        'variant': 'rect',
        'shimmer': false,
      });
      expect(_bones(tester), findsOneWidget);

      await _pumpNode(tester, {
        'type': 'skeleton',
        'variant': 'list',
        'lines': 1,
        'shimmer': false,
      });
      expect(_bones(tester), findsNWidgets(3));
    });

    testWidgets('disableAnimations collapses the pulse to static',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'skeleton',
        'variant': 'text',
        'lines': 2,
      }, disableAnimations: true);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      // The T87 duty-cycle pulse rides an Opacity; no ticker under reduced
      // motion, so no Opacity wrapper is mounted and nothing animates.
      expect(find.byType(Opacity), findsNothing);
      expect(tester.binding.transientCallbackCount, 0);
    });

    testWidgets('the duty-cycle pulse runs when motion is allowed',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'skeleton',
        'variant': 'rect',
      });
      // The stepped opacity pulse (T87): the Opacity wrapper over the bones
      // driven by the repeating AnimationController.
      expect(find.byType(Opacity), findsOneWidget);
      expect(tester.binding.transientCallbackCount, greaterThan(0));
    });
  });

  group('list sections', () {
    const sectionsList = {
      'type': 'list',
      'empty': {'type': 'text', 'text': 'Nothing here'},
      'sections': [
        {
          'label': 'Section A',
          'collapsible': true,
          'items': [
            {'type': 'text', 'text': 'A1'},
          ],
        },
        {
          'label': 'Section B',
          'collapsible': true,
          'items': [
            {'type': 'text', 'text': 'B1'},
            {'type': 'text', 'text': 'B2'},
          ],
        },
        {
          'label': 'Section C',
          'collapsible': true,
          'items': <Object>[],
        },
      ],
    };

    testWidgets('3 sections collapse and expand on header tap', (tester) async {
      await _pumpNode(tester, sectionsList);
      expect(find.text('A1'), findsOneWidget);
      expect(find.text('B1'), findsOneWidget);
      expect(find.text('B2'), findsOneWidget);

      await tester.tap(find.text('Section A'));
      await tester.pump();
      expect(find.text('A1'), findsNothing);
      expect(find.text('B1'), findsOneWidget);

      await tester.tap(find.text('Section A'));
      await tester.pump();
      expect(find.text('A1'), findsOneWidget);

      await tester.tap(find.text('Section B'));
      await tester.pump();
      expect(find.text('B1'), findsNothing);
      expect(find.text('B2'), findsNothing);
    });

    testWidgets('empty section shows its label and the empty node',
        (tester) async {
      await _pumpNode(tester, sectionsList);
      expect(find.text('Section C'), findsOneWidget);
      expect(find.text('Nothing here'), findsOneWidget);
      debugPrint(
          'T63_EMPTY_SECTION label=Section-C-shown empty-node=Nothing-here-shown');
    });
  });

  group('list onReorder', () {
    testWidgets('reordering reports the new order', (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'list',
        'onReorder': {
          'name': 'reorder',
          'method': 'POST',
          'path': '/ui/action/reorder',
        },
        'items': [
          {'type': 'text', 'id': 'a', 'text': 'A'},
          {'type': 'text', 'id': 'b', 'text': 'B'},
          {'type': 'text', 'id': 'c', 'text': 'C'},
        ],
      });
      final list = tester.widget<ReorderableListView>(
        find.byType(ReorderableListView),
      );
      // The first entry moves to the tail: post-removal index 2.
      list.onReorderItem!(0, 2);
      await tester.pump();
      expect(harness.dispatched, hasLength(1));
      expect(harness.dispatched.single['name'], 'reorder');
      expect(harness.dispatched.single['order'], ['b', 'c', 'a']);
      debugPrint('T63_REORDER order=b,c,a dispatched=1');
    });
  });
}
