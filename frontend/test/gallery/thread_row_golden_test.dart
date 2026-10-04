// Golden for the T63 acceptance 8: a `list_row` composed like a session
// thread row — avatar leading, title, subtitle, badge and a trailing menu
// icon. The baseline is `goldens/thread-row.png`; regenerate with
//   scripts/qa/flutter-test.sh test/gallery --update-goldens
import 'package:flutter/material.dart' hide ActionDispatcher;
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

const _surfaceSize = Size(400, 200);

const _threadRow = {
  'type': 'list_row',
  'leading': {
    'type': 'avatar',
    'initials': 'JD',
    'size': 40,
  },
  'title': 'Fix the plugin loader',
  'subtitle': 'you: pushing the patch now',
  'badge': {
    'type': 'badge',
    'count': 3,
  },
  'trailing': {
    'type': 'icon',
    'icon': 'more_vert',
  },
};

class _Harness {
  final state = UiState();

  late final RenderContext ctx = RenderContext(
    state: state,
    registry: UiRegistry.standard(),
    patches: {},
    setState: (id, value) => state.setValue(id, value),
    patch: (id, props) {},
    navigate: (screen) {},
    dispatch: (action) async {},
    openStream: (topic, {onStatus}) => const Stream.empty(),
    runDirectives: (directives) async {},
    confirm: (message, onConfirm) {},
  );
}

class _Host extends StatelessWidget {
  const _Host(this.harness, this.node);

  final _Harness harness;
  final UiNode node;

  @override
  Widget build(BuildContext context) => harness.ctx.build(context, node);
}

Future<void> _pumpRow(WidgetTester tester) async {
  final harness = _Harness();
  final design = JhinTheme.from(density: 'comfortable');
  await tester.pumpWidget(MaterialApp(
    theme: design.light,
    darkTheme: design.dark,
    themeMode: ThemeMode.light,
    home: Scaffold(
      body: JhinDesignScope(
        design: design,
        child: Material(child: _Host(harness, UiNode.fromJson(_threadRow))),
      ),
    ),
  ));
  await tester.pump();
}

void main() {
  testWidgets('thread-row golden', (tester) async {
    tester.view.physicalSize = _surfaceSize;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    await _pumpRow(tester);
    expect(tester.takeException(), isNull);
    expect(find.text('Fix the plugin loader'), findsOneWidget);

    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/thread-row.png'),
    );
  });
}
