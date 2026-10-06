import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T110 tests: the `settings:appearance` panel — the FoldedSettingsSection
/// collapsible cards, the upstream font-size clamps and the decorative
/// (`demo: true`) controls.
///
/// Upstream anchors (t3code `apps/web/src`, commit 37de6cb):
/// `components/settings/SettingsPanels.tsx:1143-1509` (the Appearance panel),
/// `components/settings/FoldedSettingsSection.tsx:14-98` (the folded card) and
/// `packages/contracts/src/settings.ts:100-141` (the clamps).
///
/// The tree below mirrors the server output of `SettingsScreen.appearancePanel`
/// (the same node ids and props), so the client-side rendering contract is
/// asserted without a live kernel.
/// The pixel golden lands in `String.fromEnvironment('T110_GOLDEN_DIR')`
/// (absolute path) when the QA harness provides it: the appearance panel with
/// every folded section open, in light. The QA writes it with
/// `flutter test --update-goldens` and re-runs without the flag to verify.
const String _goldenDir = String.fromEnvironment('T110_GOLDEN_DIR');

final GlobalKey _goldenKey = GlobalKey();

Map<String, dynamic> _appearancePanel() => {
      'type': 'screen',
      'title': 'Settings',
      'body': {
        'type': 'container',
        'direction': 'column',
        'children': [
          {
            'type': 'card',
            'id': 'section-appearance',
            'title': 'Appearance',
            'children': [
              {
                'type': 'switch',
                'id': 'fold_appearance',
                'label': 'Appearance',
                'value': false,
                'visible': false,
              },
              {
                'type': 'row',
                'id': 'section-appearance-toggle',
                'when': 'fold_appearance != true',
                'onTap': {'op': 'setState', 'id': 'fold_appearance', 'value': true},
                'children': [
                  {'type': 'icon', 'icon': 'chevron_right', 'size': 16},
                  {'type': 'text', 'text': 'Theme, mode and seed colors', 'style': 'caption'},
                ],
              },
              {
                'type': 'row',
                'id': 'section-appearance-toggle-open',
                'when': 'fold_appearance == true',
                'onTap': {'op': 'setState', 'id': 'fold_appearance', 'value': false},
                'children': [
                  {'type': 'icon', 'icon': 'expand_more', 'size': 16},
                  {'type': 'text', 'text': 'Theme, mode and seed colors', 'style': 'caption'},
                ],
              },
              {
                'type': 'container',
                'id': 'section-appearance-body',
                'when': 'fold_appearance == true',
                'direction': 'column',
                'children': [
                  {
                    'type': 'segmented',
                    'id': 'appearance',
                    'value': 'system',
                    'segments': [
                      {'label': 'System', 'value': 'system'},
                      {'label': 'Light', 'value': 'light'},
                      {'label': 'Dark', 'value': 'dark'},
                    ],
                  },
                ],
              },
            ],
          },
          {
            'type': 'card',
            'id': 'section-interface',
            'title': 'Interface',
            'children': [
              {
                'type': 'switch',
                'id': 'fold_interface',
                'label': 'Interface',
                'value': false,
                'visible': false,
              },
              {
                'type': 'container',
                'id': 'section-interface-body',
                'when': 'fold_interface == true',
                'direction': 'column',
                'children': [
                  {
                    'type': 'slider',
                    'id': 'contrastBoost',
                    'label': 'Contrast boost',
                    'min': 0,
                    'max': 100,
                    'step': 5,
                    'value': 100,
                    'demo': true,
                  },
                  {
                    'type': 'segmented',
                    'id': 'chatWidth',
                    'value': 'default',
                    'demo': true,
                    'segments': [
                      {'label': 'Default', 'value': 'default'},
                      {'label': 'Wide', 'value': 'wide'},
                      {'label': 'Full', 'value': 'full'},
                    ],
                  },
                  {
                    'type': 'switch',
                    'id': 'diffColorScheme',
                    'label': 'Blue & orange diff colors',
                    'value': false,
                    'demo': true,
                  },
                ],
              },
            ],
          },
          {
            'type': 'card',
            'id': 'section-typography',
            'title': 'Typography',
            'children': [
              {
                'type': 'switch',
                'id': 'fold_typography',
                'label': 'Typography',
                'value': false,
                'visible': false,
              },
              {
                'type': 'container',
                'id': 'section-typography-body',
                'when': 'fold_typography == true',
                'direction': 'column',
                'children': [
                  {
                    'type': 'slider',
                    'id': 'fontSizeInterface',
                    'label': 'Interface font size',
                    'min': 12,
                    'max': 20,
                    'step': 1,
                    'value': 16,
                    'demo': true,
                  },
                  {
                    'type': 'slider',
                    'id': 'fontSizePrompt',
                    'label': 'Prompt font size',
                    'min': 12,
                    'max': 20,
                    'step': 1,
                    'value': 14,
                    'demo': true,
                  },
                  {
                    'type': 'slider',
                    'id': 'fontSizeCode',
                    'label': 'Code font size',
                    'min': 10,
                    'max': 18,
                    'step': 1,
                    'value': 13,
                    'demo': true,
                  },
                ],
              },
            ],
          },
          {
            'type': 'card',
            'id': 'section-motion',
            'title': 'Motion',
            'children': [
              {
                'type': 'switch',
                'id': 'fold_motion',
                'label': 'Motion',
                'value': false,
                'visible': false,
              },
              {
                'type': 'container',
                'id': 'section-motion-body',
                'when': 'fold_motion == true',
                'direction': 'column',
                'children': [
                  {
                    'type': 'slider',
                    'id': 'panelMotionMs',
                    'label': 'Panel animations',
                    'min': 0,
                    'max': 400,
                    'step': 20,
                    'value': 0,
                  },
                ],
              },
            ],
          },
        ],
      },
    };

class _Harness {
  final List<String> navigated = [];

  RenderContext ctx(UiState state) => RenderContext(
        state: state,
        registry: UiRegistry.standard(),
        patches: {},
        setState: (id, value) => state.setValue(id, value),
        patch: (id, props) {},
        navigate: navigated.add,
        dispatch: (action) async {},
        openStream: (topic, {onStatus}) => const Stream.empty(),
        runDirectives: (directives) async {},
        confirm: (message, onConfirm) {},
      );
}

Future<_Harness> _pump(WidgetTester tester, UiState state) async {
  final harness = _Harness();
  const size = Size(1200, 3000);
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
  final design = JhinTheme.from();
  await tester.pumpWidget(MaterialApp(
    theme: design.light,
    darkTheme: design.dark,
    home: MediaQuery(
      data: const MediaQueryData(size: size),
      child: Scaffold(
        body: JhinDesignScope(
          design: design,
          child: Material(
            child: RepaintBoundary(
              key: _goldenKey,
              child: Builder(
                builder: (context) => harness
                    .ctx(state)
                    .build(context, UiNode.fromJson(_appearancePanel())),
              ),
            ),
          ),
        ),
      ),
    ),
  ));
  await tester.pump();
  return harness;
}

Future<void> _golden(WidgetTester tester, String name) async {
  if (_goldenDir.isEmpty) return;
  await expectLater(
      find.byKey(_goldenKey), matchesGoldenFile(Uri.file('$_goldenDir/$name')));
}

void main() {
  testWidgets('a folded section starts closed and opens on the fold state',
      (tester) async {
    final closed = UiState()..setValue('fold_appearance', false);
    await _pump(tester, closed);
    expect(find.text('System'), findsNothing);
    expect(find.text('Theme, mode and seed colors'), findsOneWidget);

    final open = UiState()..setValue('fold_appearance', true);
    await _pump(tester, open);
    expect(find.text('System'), findsOneWidget);
    expect(find.text('Light'), findsOneWidget);
    expect(find.text('Dark'), findsOneWidget);
  });

  testWidgets('the contrast slider carries the 0-100 bounds', (tester) async {
    final state = UiState()
      ..setValue('fold_interface', true)
      ..setValue('fold_typography', true)
      ..setValue('fold_motion', true);
    await _pump(tester, state);

    final ranges = tester
        .widgetList<Slider>(find.byType(Slider))
        .map((slider) => '${slider.min}-${slider.max}')
        .toSet();
    expect(ranges, containsAll(<String>['0.0-100.0', '0.0-400.0']));
  });

  testWidgets('the font-size sliders carry the upstream clamps', (tester) async {
    final state = UiState()
      ..setValue('fold_interface', true)
      ..setValue('fold_typography', true)
      ..setValue('fold_motion', true);
    await _pump(tester, state);

    final ranges = tester
        .widgetList<Slider>(find.byType(Slider))
        .map((slider) => '${slider.min}-${slider.max}')
        .toSet();
    expect(ranges, containsAll(<String>['12.0-20.0', '10.0-18.0']));
  });

  testWidgets('the chat-width segmented offers Default, Wide and Full',
      (tester) async {
    final state = UiState()..setValue('fold_interface', true);
    await _pump(tester, state);

    expect(find.text('Default'), findsOneWidget);
    expect(find.text('Wide'), findsOneWidget);
    expect(find.text('Full'), findsOneWidget);
  });

  test('the decorative controls carry the demo marker and the real ones do not',
      () {
    final tree = UiNode.fromJson(_appearancePanel());
    for (final id in <String>[
      'contrastBoost',
      'chatWidth',
      'diffColorScheme',
      'fontSizeInterface',
      'fontSizePrompt',
      'fontSizeCode',
    ]) {
      expect(tree.findById(id)!.props['demo'], isTrue, reason: id);
    }
    for (final id in <String>['appearance', 'panelMotionMs']) {
      expect(tree.findById(id)!.props.containsKey('demo'), isFalse, reason: id);
    }
  });

  testWidgets('the appearance panel golden (all sections open, light)',
      (tester) async {
    final state = UiState()
      ..setValue('fold_appearance', true)
      ..setValue('fold_interface', true)
      ..setValue('fold_typography', true)
      ..setValue('fold_motion', true);
    await _pump(tester, state);
    await _golden(tester, 'settings-appearance-light.png');
  });
}
