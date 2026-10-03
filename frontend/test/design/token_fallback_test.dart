import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T53 failure-path evidence (scripts/qa/t53.sh --fail): an unknown token
/// degrades to the literal and the node still renders; a malformed theme
/// (accent not hex) falls back to the defaults without throwing.
void main() {
  RenderContext ctx(UiRegistry registry) => RenderContext(
        state: UiState(),
        registry: registry,
        patches: {},
        setState: (id, value) {},
        patch: (id, props) {},
        navigate: (screen) {},
        dispatch: (action) async {},
        openStream: (topic, {onStatus}) => const Stream.empty(),
        runDirectives: (directives) async {},
        confirm: (message, onConfirm) {},
      );

  testWidgets('unknown token \$spacing.nope: the literal is used and the '
      'node renders', (tester) async {
    final node = UiNode.fromJson({
      'type': 'text',
      'text': 'fallback-proof',
      'padding': '\$spacing.nope',
      'color': '\$color.nope',
    });
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: Builder(builder: (context) {
        return ctx(UiRegistry.standard()).build(context, node);
      })),
    ));
    await tester.pump();

    // The node renders.
    expect(find.text('fallback-proof'), findsOneWidget);
    // The unknown tokens kept their literal values: no padding was built
    // from '\$spacing.nope' and no decoration from '\$color.nope'.
    expect(
      find.ancestor(
          of: find.text('fallback-proof'), matching: find.byType(Padding)),
      findsNothing,
    );
    expect(find.byType(DecoratedBox), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('malformed theme (accent not hex) falls back to the defaults '
      'without throwing', (tester) async {
    final theme = JhinTheme.from(accent: 'definitely-not-hex');
    expect(theme.light.colorScheme.primary, JhinTheme.defaultAccent);
    expect(theme.dark.colorScheme.primary, JhinTheme.defaultAccent);
    expect(theme.themeMode, ThemeMode.system);

    // The generated pair still drives a MaterialApp.
    await tester.pumpWidget(MaterialApp(
      theme: theme.light,
      darkTheme: theme.dark,
      themeMode: theme.themeMode,
      home: Scaffold(body: Builder(builder: (context) {
        return Text('styled');
      })),
    ));
    expect(find.text('styled'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
