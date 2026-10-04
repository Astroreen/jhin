import 'package:flutter/material.dart' hide ActionDispatcher;
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/icon_registry.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T61 — the full icon registry and the `icon`/`icon_button` primitives over
/// the harness pattern of `design/universal_props_test.dart`: a recording
/// [RenderContext] over a fresh [UiState], [UiNode.fromJson], `ctx.build`.
///
/// Client rule (§2.4/§9): an unknown icon name renders an empty icon and
/// logs — never a crash; out-of-range variable-font values and malformed
/// specs degrade to the widget default. None of these tests may throw on
/// server content.

class _Harness {
  final state = UiState();
  final dispatched = <Map<String, dynamic>>[];
  final confirms = <String>[];

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
      onConfirm();
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

Future<_Harness> _pumpNode(WidgetTester tester, Object? json) async {
  final harness = _Harness();
  final node = UiNode.fromJson(json);
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      body: JhinDesignScope(
        design: JhinTheme.fallback(),
        child: Material(
          child: _Host(harness, node),
        ),
      ),
    ),
  ));
  await tester.pump();
  return harness;
}

/// Runs [body] with [debugPrint] captured into the returned log list. The
/// override is restored before the test body ends — flutter_test asserts
/// every foundation debug variable is back to its default at that point.
Future<List<String>> _captureDebugPrint(Future<void> Function() body) async {
  final logs = <String>[];
  final original = debugPrint;
  debugPrint = (String? message, {int? wrapWidth}) {
    logs.add(message ?? '');
  };
  try {
    await body();
  } finally {
    debugPrint = original;
  }
  return logs;
}

/// The 20 sampled registry names of the T61 evidence: evenly spread over the
/// alphabetically sorted registry.
List<String> _sampledNames() {
  final names = kIconRegistry.keys.toList();
  return [
    for (var i = 0; i < 20; i++) names[i * (names.length - 1) ~/ 19],
  ];
}

void main() {
  group('icon registry lookup (§2.6)', () {
    testWidgets('icon resolves its name through kIconRegistry', (tester) async {
      await _pumpNode(tester, {'type': 'icon', 'icon': 'settings'});
      final icon = tester.widget<Icon>(find.byType(Icon));
      expect(icon.icon, kIconRegistry['settings']);
      expect(icon.icon!.codePoint, kIconRegistry['settings']!.codePoint);
      expect(icon.icon!.fontFamily, 'MaterialIcons');
    });

    testWidgets(
        '20 sampled registry names render as icons with their codePoints',
        (tester) async {
      final sampled = _sampledNames();
      await _pumpNode(tester, {
        'type': 'column',
        'children': [for (final name in sampled) {'type': 'icon', 'icon': name}],
      });
      expect(tester.takeException(), isNull);
      final icons = tester.widgetList<Icon>(find.byType(Icon)).toList();
      expect(icons, hasLength(20));
      for (var i = 0; i < sampled.length; i++) {
        final expected = kIconRegistry[sampled[i]]!;
        expect(icons[i].icon, expected, reason: sampled[i]);
        expect(icons[i].icon!.codePoint, expected.codePoint,
            reason: sampled[i]);
      }

      // The recorded render dump for .sisyphus/evidence/T61/sampled.txt.
      debugPrint('T61_SAMPLED_BEGIN');
      for (var i = 0; i < sampled.length; i++) {
        final data = kIconRegistry[sampled[i]]!;
        debugPrint('${sampled[i]} -> IconData(0x${data.codePoint.toRadixString(16)}, '
            'fontFamily: ${data.fontFamily}) rendered as Icon');
      }
      debugPrint('T61_SAMPLED_END');
    });

    test('the registry holds every generated name (>= 1800)', () {
      expect(kIconRegistry.length, greaterThanOrEqualTo(1800));
      expect(kIconRegistry.keys.toList(), equals(kIconRegistry.keys.toList()..sort()));
    });
  });

  group('icon (§2.6)', () {
    testWidgets('the icon props land on the Icon widget', (tester) async {
      await _pumpNode(tester, {
        'type': 'icon',
        'icon': 'settings',
        'size': 32,
        'color': '#FF0000',
        'semanticLabel': 'Settings',
        'fill': 0.5,
        'weight': 600,
        'grade': 100,
        'opticalSize': 48,
        'shadows': [
          {'color': '#000000', 'blur': 2, 'offset': [0, 1]},
        ],
        'textDirection': 'rtl',
        'blendMode': 'srcOver',
      });
      final icon = tester.widget<Icon>(find.byType(Icon));
      expect(icon.size, 32);
      expect(icon.color, const Color(0xFFFF0000));
      expect(icon.semanticLabel, 'Settings');
      expect(icon.fill, 0.5);
      expect(icon.weight, 600);
      expect(icon.grade, 100);
      expect(icon.opticalSize, 48);
      expect(icon.shadows, hasLength(1));
      expect(icon.shadows!.single.blurRadius, 2);
      expect(icon.shadows!.single.offset, const Offset(0, 1));
      expect(icon.textDirection, TextDirection.rtl);
      expect(icon.blendMode, BlendMode.srcOver);
    });

    testWidgets('color is the icon color, not a painted background',
        (tester) async {
      await _pumpNode(tester, {'type': 'icon', 'icon': 'settings', 'color': '#FF0000'});
      expect(find.byType(DecoratedBox), findsNothing);
      expect(tester.widget<Icon>(find.byType(Icon)).color,
          const Color(0xFFFF0000));
    });

    testWidgets('out-of-range variable-font values and size drop instead of '
        'asserting', (tester) async {
      await _pumpNode(tester, {
        'type': 'icon',
        'icon': 'settings',
        'size': -10,
        'fill': 5,
        'weight': -1,
        'opticalSize': 0,
      });
      expect(tester.takeException(), isNull);
      final icon = tester.widget<Icon>(find.byType(Icon));
      expect(icon.size, isNull);
      expect(icon.fill, isNull);
      expect(icon.weight, isNull);
      expect(icon.opticalSize, isNull);
    });

    testWidgets('an unknown blendMode and malformed shadows degrade cleanly',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'icon',
        'icon': 'settings',
        'blendMode': 'nope',
        'shadows': ['not-a-shadow', 4],
      });
      expect(tester.takeException(), isNull);
      final icon = tester.widget<Icon>(find.byType(Icon));
      expect(icon.blendMode, isNull);
      expect(icon.shadows, hasLength(1));
      expect(icon.shadows!.single.blurRadius, 4);
    });

    testWidgets('a missing icon name renders an empty icon and logs',
        (tester) async {
      final logs = await _captureDebugPrint(() async {
        await _pumpNode(tester, {'type': 'icon', 'size': 24});
      });
      expect(tester.takeException(), isNull);
      final icon = tester.widget<Icon>(find.byType(Icon));
      expect(icon.icon, isNull);
      expect(icon.size, 24);
      expect(logs, contains('Jhin SDUI: icon node without an "icon" name'));
    });
  });

  group('unknown icon name degrade (§2.4)', () {
    testWidgets('an unknown name renders an empty icon and logs, no exception',
        (tester) async {
      final logs = await _captureDebugPrint(() async {
        await _pumpNode(tester, {
          'type': 'icon',
          'icon': 'definitely_not_an_icon',
          'size': 24,
        });
      });
      expect(tester.takeException(), isNull);
      final icon = tester.widget<Icon>(find.byType(Icon));
      expect(icon.icon, isNull);
      expect(icon.size, 24);
      expect(
        logs,
        contains('Jhin SDUI: unknown icon name "definitely_not_an_icon"'),
      );

      // The recorded degrade dump for .sisyphus/evidence/T61/unknown-icon.txt.
      debugPrint('T61_UNKNOWN_ICON_BEGIN');
      debugPrint('node: {type: icon, icon: definitely_not_an_icon, size: 24}');
      debugPrint('rendered: Icon(icon: null, size: 24) — empty icon, no exception');
      for (final line in logs) {
        debugPrint('debugPrint: $line');
      }
      debugPrint('T61_UNKNOWN_ICON_END');
    });

    testWidgets('an unknown icon_button icon name degrades the same way',
        (tester) async {
      final logs = await _captureDebugPrint(() async {
        await _pumpNode(tester, {
          'type': 'icon_button',
          'icon': 'definitely_not_an_icon',
        });
      });
      expect(tester.takeException(), isNull);
      final icon = tester.widget<Icon>(find.descendant(
          of: find.byType(IconButton), matching: find.byType(Icon)));
      expect(icon.icon, isNull);
      expect(
        logs,
        contains('Jhin SDUI: unknown icon name "definitely_not_an_icon"'),
      );
    });
  });

  group('icon_button (§2.6)', () {
    testWidgets('an action dispatches on tap', (tester) async {
      final h = await _pumpNode(tester, {
        'type': 'icon_button',
        'icon': 'settings',
        'action': {'name': 'save', 'method': 'POST', 'path': '/ui/action/save'},
      });
      await tester.tap(find.byType(IconButton));
      await tester.pump();
      expect(h.dispatched, hasLength(1));
      expect(h.dispatched.single['name'], 'save');
    });

    testWidgets('without action the button is disabled and dispatches nothing',
        (tester) async {
      final h = await _pumpNode(tester, {
        'type': 'icon_button',
        'icon': 'settings',
      });
      final button = tester.widget<IconButton>(find.byType(IconButton));
      expect(button.onPressed, isNull);
      await tester.tap(find.byType(IconButton));
      await tester.pump();
      expect(h.dispatched, isEmpty);
    });

    testWidgets('confirm gates the dispatch', (tester) async {
      final h = await _pumpNode(tester, {
        'type': 'icon_button',
        'icon': 'settings',
        'action': {'name': 'delete'},
        'confirm': 'Delete it?',
      });
      await tester.tap(find.byType(IconButton));
      await tester.pump();
      expect(h.confirms, ['Delete it?']);
      expect(h.dispatched, hasLength(1));
    });

    testWidgets('the icon_button props land on the IconButton', (tester) async {
      await _pumpNode(tester, {
        'type': 'icon_button',
        'icon': 'settings',
        'iconSize': 20,
        'color': '#112233',
        'disabledColor': '#445566',
        'highlightColor': '#778899',
        'splashColor': '#AABBCC',
        'focusColor': '#DDEEFF',
        'hoverColor': '#010203',
        'alignment': 'topLeft',
        'autofocus': true,
        'isSelected': true,
        'selectedIcon': 'home',
        'mouseCursor': 'click',
        'visualDensity': 'compact',
        'enableFeedback': false,
        'splashRadius': 24,
        'constraints': {'minWidth': 40, 'minHeight': 40},
        'style': {
          'backgroundColor': '#FFEEDD',
          'elevation': 2,
        },
      });
      final button = tester.widget<IconButton>(find.byType(IconButton));
      expect(button.iconSize, 20);
      expect(button.color, const Color(0xFF112233));
      expect(button.disabledColor, const Color(0xFF445566));
      expect(button.highlightColor, const Color(0xFF778899));
      expect(button.splashColor, const Color(0xFFAABBCC));
      expect(button.focusColor, const Color(0xFFDDEEFF));
      expect(button.hoverColor, const Color(0xFF010203));
      expect(button.alignment, Alignment.topLeft);
      expect(button.autofocus, isTrue);
      expect(button.isSelected, isTrue);
      expect(button.mouseCursor, SystemMouseCursors.click);
      expect(button.visualDensity, VisualDensity.compact);
      expect(button.enableFeedback, isFalse);
      expect(button.splashRadius, 24);
      expect(button.constraints,
          const BoxConstraints(minWidth: 40, minHeight: 40));
      expect(button.style!.backgroundColor!
          .resolve(const <WidgetState>{}), const Color(0xFFFFEEDD));
      expect(button.style!.elevation!.resolve(const <WidgetState>{}), 2);
      final selected = tester.widget<Icon>(find.descendant(
          of: find.byType(IconButton), matching: find.byType(Icon)));
      expect(selected.icon, kIconRegistry['home']);
    });

    testWidgets('padding is the button own param, not an outer wrap',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'icon_button',
        'icon': 'settings',
        'padding': 8,
      });
      final button = tester.widget<IconButton>(find.byType(IconButton));
      expect(button.padding, const EdgeInsets.all(8));
      expect(
        find.ancestor(of: find.byType(IconButton), matching: find.byType(Padding)),
        findsNothing,
      );
    });

    testWidgets('an inline icon node is accepted for icon/selectedIcon',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'icon_button',
        'icon': {'type': 'icon', 'icon': 'settings', 'size': 18},
        'selectedIcon': {'type': 'icon', 'icon': 'home', 'size': 22},
        'isSelected': false,
      });
      final icon = tester.widget<Icon>(find.descendant(
          of: find.byType(IconButton), matching: find.byType(Icon)));
      expect(icon.size, 18);
      expect(icon.icon, kIconRegistry['settings']);

      await _pumpNode(tester, {
        'type': 'icon_button',
        'icon': {'type': 'icon', 'icon': 'settings', 'size': 18},
        'selectedIcon': {'type': 'icon', 'icon': 'home', 'size': 22},
        'isSelected': true,
      });
      final selected = tester.widget<Icon>(find.descendant(
          of: find.byType(IconButton), matching: find.byType(Icon)));
      expect(selected.size, 22);
      expect(selected.icon, kIconRegistry['home']);
    });

    testWidgets('malformed icon_button props degrade to the widget defaults',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'icon_button',
        'icon': 'settings',
        'splashRadius': -1,
        'visualDensity': 'nope',
        'alignment': 'middle',
        'mouseCursor': 'nope',
        'constraints': {'minWidth': 50, 'maxWidth': 10},
        'style': 'not-a-map',
      });
      expect(tester.takeException(), isNull);
      final button = tester.widget<IconButton>(find.byType(IconButton));
      expect(button.splashRadius, isNull);
      expect(button.visualDensity, isNull);
      expect(button.alignment, isNull);
      expect(button.mouseCursor, isNull);
      expect(button.constraints, isNull);
      expect(button.style, isNull);
    });
  });
}