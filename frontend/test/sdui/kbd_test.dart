import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';
import 'package:jhin/sdui/primitives/kbd.dart';

/// T91 tests: the `kbd` primitive — the chord-to-pill rendering with the
/// per-platform modifier mapping, the canonical modifier order, the key
/// labels, the token-driven pill geometry and the unknown-token degrade.
///
/// Upstream anchors (t3code `apps/web/src`, commit 37de6cb):
/// `components/ui/kbd.tsx:5-26` (the pill: `h-5 min-w-5 rounded bg-muted
/// px-1 font-medium text-xs text-muted-foreground`, the group `gap-1`),
/// `lib/snapShotShortcut.ts:62-77` (the per-platform modifier labels: shift
/// ⇧ everywhere, Apple ⌘/⌃/⌥, Windows ⊞, `Super` elsewhere; `mod` → ⌘ on
/// the Apple platforms, Ctrl elsewhere) and `keybindings.ts:255-265` (the
/// key labels: Space, uppercased single chars, Esc, the arrow
/// abbreviations).
const String _goldenDir = String.fromEnvironment('T91_GOLDEN_DIR');

final GlobalKey _shot = GlobalKey();

RenderContext _ctx(UiState state) => RenderContext(
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

Map<String, dynamic> _kbd([Map<String, dynamic>? overrides]) => {
      'type': 'kbd',
      'id': 'probe-kbd',
      'chord': 'mod+shift+m',
      ...?overrides,
    };

Future<void> _pump(
  WidgetTester tester,
  Map<String, dynamic> node, {
  TargetPlatform platform = TargetPlatform.linux,
  JhinTheme? design,
  ThemeMode mode = ThemeMode.light,
}) async {
  final d = design ?? JhinTheme.from();
  tester.view.physicalSize = const Size(400, 300);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    RepaintBoundary(
      key: _shot,
      child: MaterialApp(
        theme: d.light.copyWith(platform: platform),
        darkTheme: d.dark.copyWith(platform: platform),
        themeMode: mode,
        home: JhinDesignScope(
          design: d,
          child: Scaffold(
            body: Center(
              child: RepaintBoundary(
                child: Builder(
                  builder: (context) =>
                      _ctx(UiState()).build(context, UiNode.fromJson(node)),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

List<Text> _pills(WidgetTester tester) => tester
    .widgetList<Text>(find.descendant(
        of: find.byType(Row), matching: find.byType(Text)))
    .toList();

void main() {
  final goldens = _goldenDir.isNotEmpty;
  Uri golden(String name) => Uri.file('$_goldenDir/$name');

  testWidgets('mod+shift+m renders Ctrl, ⇧, M pills off the Apple platforms',
      (tester) async {
    await _pump(tester, _kbd(), platform: TargetPlatform.linux);
    final labels = _pills(tester).map((text) => text.data).toList();
    expect(labels, ['Ctrl', '\u21e7', 'M']);
  });

  testWidgets('mod resolves to ⌘ on macOS', (tester) async {
    await _pump(tester, _kbd(), platform: TargetPlatform.macOS);
    final labels = _pills(tester).map((text) => text.data).toList();
    expect(labels, ['\u21e7', '\u2318', 'M'],
        reason: 'the canonical modifier order is ctrl, alt, shift, meta');
  });

  testWidgets('mod resolves to ⌘ on iOS too', (tester) async {
    await _pump(tester, _kbd(), platform: TargetPlatform.iOS);
    final labels = _pills(tester).map((text) => text.data).toList();
    expect(labels, ['\u21e7', '\u2318', 'M']);
  });

  testWidgets('meta renders ⊞ on Windows', (tester) async {
    await _pump(tester, _kbd({'chord': 'meta+k'}),
        platform: TargetPlatform.windows);
    expect(_pills(tester).map((text) => text.data).toList(), ['\u229e', 'K']);
  });

  testWidgets('meta renders Super elsewhere', (tester) async {
    await _pump(tester, _kbd({'chord': 'meta+k'}),
        platform: TargetPlatform.linux);
    expect(_pills(tester).map((text) => text.data).toList(), ['Super', 'K']);
  });

  testWidgets('the canonical modifier order is ctrl, alt, shift, meta; '
      'mod collapses with an explicit ctrl', (tester) async {
    await _pump(tester, _kbd({'chord': 'shift+alt+ctrl+mod+x'}),
        platform: TargetPlatform.linux);
    expect(_pills(tester).map((text) => text.data).toList(),
        ['Ctrl', 'Alt', '\u21e7', 'X'],
        reason: 'mod is an alias of ctrl off the Apple platforms — the '
            'upstream label expansion dedupes it');
  });

  testWidgets('key labels: Space, Esc, arrows, uppercased single chars',
      (tester) async {
    await _pump(tester, _kbd({'chord': 'escape+arrowup+ +a'}),
        platform: TargetPlatform.linux);
    expect(_pills(tester).map((text) => text.data).toList(),
        ['Esc', 'Up', 'Space', 'A']);
  });

  testWidgets('an unknown chord token renders literally and never throws',
      (tester) async {
    await _pump(tester, _kbd({'chord': 'mod+banana'}),
        platform: TargetPlatform.linux);
    final labels = _pills(tester).map((text) => text.data).toList();
    expect(labels, ['Ctrl', 'banana'],
        reason: 'the unknown token renders as a literal pill');
  });

  testWidgets('an empty chord degrades visibly', (tester) async {
    await _pump(tester, _kbd({'chord': ''}));
    expect(find.text('Missing chord'), findsOneWidget);
  });

  testWidgets('a missing chord degrades visibly', (tester) async {
    await _pump(tester, {'type': 'kbd', 'id': 'probe-kbd'});
    expect(find.text('Missing chord'), findsOneWidget);
  });

  testWidgets('the pill geometry is token-driven: the control radius and '
      'the text-2xs size', (tester) async {
    await _pump(tester, _kbd(), platform: TargetPlatform.linux);
    final containers = tester
        .widgetList<Container>(find.byType(Container))
        .where((container) =>
            container.decoration is BoxDecoration &&
            (container.decoration as BoxDecoration).borderRadius != null)
        .toList();
    expect(containers, isNotEmpty);
    final decoration = containers.first.decoration! as BoxDecoration;
    // `--control-radius` (0.5rem) ≡ the §4.3 radius.md token (8 px).
    expect(decoration.borderRadius, BorderRadius.circular(8));
    final style = _pills(tester).first.style!;
    // `--text-2xs` (0.6875rem) ≡ the §4.3 text.xs2 token (11 px).
    expect(style.fontSize, 11);
    expect(style.fontWeight, FontWeight.w500);
  });

  // One test per mode: a second pumpWidget inside the same test reuses the
  // MaterialApp element and does not re-theme (the frame would stay light).
  Future<void> goldenMode(WidgetTester tester, ThemeMode mode) async {
    final label = mode == ThemeMode.light ? 'light' : 'dark';
    await _pump(tester, _kbd(), mode: mode);
    if (goldens) {
      await expectLater(find.byKey(_shot),
          matchesGoldenFile(golden('kbd-$label.png')));
    }
  }

  testWidgets('golden: the mod+shift+m pills (light)',
      (tester) => goldenMode(tester, ThemeMode.light));
  testWidgets('golden: the mod+shift+m pills (dark)',
      (tester) => goldenMode(tester, ThemeMode.dark));
}
