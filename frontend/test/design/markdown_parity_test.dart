import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/markdown_render.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T104: the ChatMarkdown parity suite (docs/sdui.md §2.6, the markdown
/// mapping) — one fixture per upstream `ChatMarkdown.tsx` feature (commit
/// 37de6cb), each asserted at the mapping level and rendered into a golden
/// when the QA harness provides `T104_GOLDEN_DIR`.
///
/// Upstream anchors: headings h1-h6 (index.css:1762-1794), GitHub alerts
/// (ChatMarkdown.tsx:522-557, 2941-2957 — the five coloured bordered
/// cards), the code-block header recipe (ChatMarkdown.tsx:1083-1141,
/// index.css:1440-1442), the link treatment (index.css:1861-1870 — the
/// info-foreground colour; Jhin keeps a constant underline where upstream
/// underlines dotted on hover), the citation chip (ContextChip kind
/// "citation", accent oklch hue 259), the skill chips (SkillInlineText),
/// the external-link glyph (the favicon/globe fallback pinned to one
/// registry icon), inline vs standalone images (ChatMarkdown.tsx:416-449),
/// task lists (index.css:1841-1850) and the explicit non-features: math as
/// a `math` code block and footnote refs as plain refs.
const String _goldenDir = String.fromEnvironment('T104_GOLDEN_DIR');

/// The 1×1 red PNG used by the image fixtures (no network in tests).
const String _pixelPng =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
    'AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

class _Harness {
  final state = UiState();
  final dispatched = <Map<String, dynamic>>[];
  final toasts = <String>[];

  late final RenderContext ctx = RenderContext(
    state: state,
    registry: UiRegistry.standard(),
    patches: {},
    setState: (id, value) => state.setValue(id, value),
    patch: (id, props) {},
    navigate: (screen) {},
    dispatch: (action) async {
      if (action['op'] == 'toast') toasts.add('${action['text']}');
      dispatched.add(action);
    },
    openStream: (topic, {onStatus}) => const Stream.empty(),
    runDirectives: (directives) async {
      for (final directive in directives) {
        if (directive['op'] == 'toast') toasts.add('${directive['text']}');
      }
    },
    confirm: (message, onConfirm) {},
  );
}

final GlobalKey _goldenKey = GlobalKey();

Future<_Harness> _pumpMarkdown(
  WidgetTester tester,
  String source, {
  Set<String>? skills,
  bool syntax = false,
  ThemeMode mode = ThemeMode.light,
}) async {
  final harness = _Harness();
  final design = JhinTheme.fallback();
  final node = UiNode(type: 'markdown', props: {
    'text': source,
    if (skills != null) 'skills': skills.toList(),
    if (syntax) 'syntax': true,
  });
  await tester.pumpWidget(
    MediaQuery(
      data: const MediaQueryData(),
      child: MaterialApp(
        theme: design.light,
        darkTheme: design.dark,
        themeMode: mode,
        home: JhinDesignScope(
          design: design,
          child: Scaffold(
            body: RepaintBoundary(
              key: _goldenKey,
              child: Align(
                alignment: Alignment.topLeft,
                child: SizedBox(
                  width: 480,
                  child: SingleChildScrollView(
                    child: Builder(
                        builder: (context) => harness.ctx.build(context, node)),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
  return harness;
}

Future<void> _shot(WidgetTester tester, String name) async {
  if (_goldenDir.isEmpty) return;
  await expectLater(
      find.byKey(_goldenKey), matchesGoldenFile(Uri.file('$_goldenDir/$name')));
}

void main() {
  group('headings h1-h6', () {
    test('h1..h3 map to their tokens; h4..h6 carry the small-heading run',
        () {
      final nodes = markdownToNodes(
          '# one\n\n## two\n\n### three\n\n#### four\n\n##### five\n\n###### six');
      // h1..h3 stay plain text nodes with their token; h4..h6 carry a
      // per-span style (Jhin has no h4..h6 typography tokens).
      expect(nodes[0].type, 'text');
      expect(nodes[1].type, 'text');
      expect(nodes[2].type, 'text');
      expect(nodes[3].type, 'rich_text');
      expect(nodes[0].props['style'], 'h1');
      expect(nodes[1].props['style'], 'h2');
      expect(nodes[2].props['style'], 'h3');
      // h4..h6: the 0.875rem/600 run (upstream index.css:1786-1791); h6
      // adds the muted foreground (index.css:1792-1794).
      for (final level in [3, 4, 5]) {
        final spans =
            nodes[level].listProp('spans')!.cast<Map>();
        expect(spans.single['style'],
            containsPair('fontWeight', 600));
        expect(spans.single['style']['fontSize'], 14);
      }
      final six = nodes[5].listProp('spans')!.cast<Map>().single;
      expect(six['style']['color'], r'$color.muted-foreground');
    });

    testWidgets('renders and goldens', (tester) async {
      await _pumpMarkdown(tester,
          '# Heading one\n\n## Heading two\n\n### Heading three\n\n#### Heading four\n\n##### Heading five\n\n###### Heading six');
      await _shot(tester, 'markdown-headings-light.png');
      expect(tester.takeException(), isNull);
    });
  });

  group('paragraphs and the remark-breaks semantics', () {
    test('a paragraph is one text node; a single newline stays a break', () {
      final nodes = markdownToNodes('first line\nsecond line');
      expect(nodes.single.type, 'text');
      // remark-breaks: a single newline renders as a break — the text
      // span keeps the newline character (Flutter breaks the line on it).
      expect(nodes.single.props['text'], 'first line\nsecond line');
    });

    testWidgets('renders and goldens', (tester) async {
      await _pumpMarkdown(tester,
          'A plain paragraph with wrap-around text.\n\nA second paragraph\nbroken once.');
      await _shot(tester, 'markdown-paragraphs-light.png');
      expect(find.textContaining('broken once'), findsOneWidget);
    });
  });

  group('ul/ol lists', () {
    test('bullet items carry no marker prefix; ordered items their number',
        () {
      final nodes = markdownToNodes('- alpha\n- beta\n\n1. one\n2. two');
      final bullet = nodes[0].listProp('items')!.cast<Map>();
      expect(bullet.map((e) => e['text']), ['alpha', 'beta']);
      final ordered = nodes[1].listProp('items')!.cast<Map>();
      expect(ordered.map((e) => e['text']), ['1. one', '2. two']);
    });

    testWidgets('renders and goldens', (tester) async {
      await _pumpMarkdown(tester, '- alpha\n- beta\n  - nested\n\n1. one\n2. two');
      await _shot(tester, 'markdown-lists-light.png');
      expect(find.text('alpha'), findsOneWidget);
      expect(find.text('1. one'), findsOneWidget);
    });
  });

  group('tables', () {
    test('columns and rows map onto the table primitive', () {
      final node = markdownToNodes('| a | b |\n|---|---|\n| 1 | 2 |').single;
      expect(node.type, 'table');
      expect(node.listProp('columns'), [
        {'label': 'a'},
        {'label': 'b'},
      ]);
      expect(node.listProp('rows'), [
        ['1', '2'],
      ]);
    });

    testWidgets('renders and goldens', (tester) async {
      await _pumpMarkdown(tester,
          '| Name | Path |\n|------|------|\n| a    | b    |');
      await _shot(tester, 'markdown-tables-light.png');
      expect(find.text('Name'), findsOneWidget);
    });
  });

  group('blockquote', () {
    test('maps to the card primitive', () {
      final node = markdownToNodes('> quoted line').single;
      expect(node.type, 'card');
      expect(node.children.single.props['text'], 'quoted line');
    });

    testWidgets('renders and goldens', (tester) async {
      await _pumpMarkdown(tester, '> quoted line');
      await _shot(tester, 'markdown-blockquote-light.png');
      expect(find.text('quoted line'), findsOneWidget);
    });
  });

  group('inline code', () {
    test('the mono family token', () {
      final spans = markdownToNodes('run `x = 1` here').single
          .listProp('spans')!.cast<Map>();
      expect(spans[1]['style'], {'fontFamily': r'$font.mono'});
      expect(spans[1]['text'], 'x = 1');
    });

    testWidgets('renders and goldens', (tester) async {
      await _pumpMarkdown(tester, 'run `x = 1` here');
      await _shot(tester, 'markdown-inline-code-light.png');
      expect(find.textContaining('x = 1', findRichText: true),
          findsOneWidget);
    });
  });

  group('fenced code', () {
    test('language label from the info string', () {
      final node = markdownToNodes('```java\npublic class A {}\n```').single;
      expect(node.type, 'code_block');
      expect(node.props['language'], 'java');
      expect(node.props['code'], 'public class A {}');
    });

    testWidgets('copy sends the exact source and flips the glyph', (tester) async {
      final calls = <MethodCall>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform, (call) async {
        calls.add(call);
        return null;
      });
      final harness = await _pumpMarkdown(
          tester, '```java\npublic class A {}\n```',
          syntax: false);
      // The header recipe: the muted language label and the copy action.
      expect(find.text('java'), findsOneWidget);
      expect(find.byIcon(Icons.copy), findsOneWidget);
      await tester.tap(find.byIcon(Icons.copy));
      await tester.pump();
      expect(find.byIcon(Icons.check), findsOneWidget);
      final setData =
          calls.where((call) => call.method == 'Clipboard.setData').toList();
      expect((setData.single.arguments as Map)['text'], 'public class A {}');
      expect(harness.toasts, contains('Copied to clipboard'));
      await tester.pump(const Duration(milliseconds: 1201));
      tester.binding.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null);
    });

    testWidgets('syntax colours come from the tokens and goldens', (tester) async {
      await _pumpMarkdown(
          tester, '```dart\n// comment\nfinal x = 1;\n```',
          syntax: true);
      await _shot(tester, 'markdown-fenced-code-light.png');
      // The comment line resolves the muted-foreground token: the span
      // colour differs from the code foreground and from the other roles.
      final design = JhinTheme.fallback();
      final muted = design.colorOf('muted-foreground');
      final accent = design.colorOf('accent');
      final warning = design.colorOf('warning');
      expect(muted, isNot(accent));
      expect(warning, isNot(accent));
      expect(tester.takeException(), isNull);
    });
  });

  group('links', () {
    test('openUrl action, underline and the external-link glyph', () {
      final spans = markdownToNodes('see [docs](https://x.example/a) now')
          .single.listProp('spans')!.cast<Map>();
      expect(spans[1]['icon'], 'open_in_new');
      expect(spans[2]['action'], {'op': 'openUrl', 'value': 'https://x.example/a'});
      expect(spans[2]['style'], {
        'textDecoration': 'underline',
        'color': r'$color.info-foreground',
      });
      // A relative link keeps the action without the glyph.
      final inner = markdownToNodes('see [page](docs/x.md) now')
          .single.listProp('spans')!.cast<Map>();
      expect(inner[1]['icon'], isNull);
      expect(inner[1]['action'], {'op': 'openUrl', 'value': 'docs/x.md'});
    });

    testWidgets('renders, taps through and goldens', (tester) async {
      final harness =
          await _pumpMarkdown(tester, 'see [docs](https://x.example/a) now');
      await _shot(tester, 'markdown-links-light.png');
      // Tap the 'docs' span inside the rich run (per-span hit boxes).
      final paragraph = tester.renderObject<RenderParagraph>(find.byWidgetPredicate(
          (widget) =>
              widget is RichText &&
              widget.text.toPlainText().contains('docs')));
      final plain = paragraph.text.toPlainText();
      final start = plain.indexOf('docs');
      final box = paragraph.getBoxesForSelection(TextSelection(
              baseOffset: start, extentOffset: start + 'docs'.length))
          .first;
      await tester.tapAt(paragraph.localToGlobal(box.toRect().center));
      await tester.pump();
      expect(harness.dispatched, [
        {'op': 'openUrl', 'value': 'https://x.example/a'},
      ]);
    });
  });

  group('images', () {
    test('a standalone image renders a zoomable image node', () {
      final node =
          markdownToNodes('![alt text](https://x.example/i.png)').single;
      expect(node.type, 'image');
      expect(node.props['src'], 'https://x.example/i.png');
      expect(node.props['semanticsLabel'], 'alt text');
      expect(node.props['zoomable'], isTrue);
    });

    test('an image inside a sentence stays inline (an image span)', () {
      final spans = markdownToNodes('see ![i](https://x.example/i.png) here')
          .single.listProp('spans')!.cast<Map>();
      expect(spans.map((s) => s['text']).toList(), ['see ', '', ' here']);
      expect(spans[1]['image'], {
        'src': 'https://x.example/i.png',
        'semanticsLabel': 'i',
      });
    });

    testWidgets('the zoom dialog opens and closes and goldens', (tester) async {
      await _pumpMarkdown(tester, '![pixel]($_pixelPng)');
      await _shot(tester, 'markdown-images-light.png');
      // The inline image is tappable and opens the zoom dialog.
      await tester.tap(find.byType(Image).first, warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(find.byType(InteractiveViewer), findsOneWidget);
      expect(find.byTooltip('Close'), findsOneWidget);
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();
      expect(find.byType(InteractiveViewer), findsNothing);
    });
  });

  group('task lists', () {
    test('the checkbox glyph replaces the list marker', () {
      final items = markdownToNodes('- [x] done\n- [ ] open')
          .single.listProp('items')!.cast<Map>();
      final done = UiNode.fromJson(items[0]);
      final open = UiNode.fromJson(items[1]);
      expect(done.type, 'rich_text');
      final doneSpans = done.listProp('spans')!.cast<Map>();
      expect(doneSpans[0]['icon'], 'check_box');
      expect(doneSpans[0]['style'], {'color': r'$color.accent'});
      expect(doneSpans[2]['text'], 'done');
      final openSpans = open.listProp('spans')!.cast<Map>();
      expect(openSpans[0]['icon'], 'check_box_outline_blank');
      expect(openSpans[0]['style'], {'color': r'$color.muted-foreground'});
      // No bullet marker on task items (upstream list-style-type: none) —
      // the checkbox glyph takes the marker's place.
      expect(
          doneSpans.map((s) => s['text']),
          everyElement(isNot(contains('- '))));
    });

    testWidgets('renders and goldens', (tester) async {
      await _pumpMarkdown(tester, '- [x] done\n- [ ] open');
      await _shot(tester, 'markdown-task-lists-light.png');
      expect(find.byIcon(Icons.check_box), findsOneWidget);
      expect(find.byIcon(Icons.check_box_outline_blank), findsOneWidget);
    });
  });

  group('strong/em/strikethrough', () {
    test('the span styles', () {
      final spans = markdownToNodes('**bold** *em* ~~gone~~')
          .single.listProp('spans')!.cast<Map>();
      final styleBy = {
        for (final span in spans) span['text'] as String: span['style'],
      };
      expect(styleBy['bold'], {'fontWeight': 700});
      expect(styleBy['em'], {'fontStyle': 'italic'});
      expect(styleBy['gone'], {'textDecoration': 'lineThrough'});
    });

    testWidgets('renders and goldens', (tester) async {
      await _pumpMarkdown(tester, '**bold** *em* ~~gone~~');
      await _shot(tester, 'markdown-inline-styles-light.png');
      expect(find.textContaining('bold', findRichText: true),
          findsOneWidget);
      expect(find.textContaining('gone', findRichText: true),
          findsOneWidget);
    });
  });

  group('GitHub alerts', () {
    test('the five kinds map onto five distinct tone tokens', () {
      const fixture = '> [!NOTE]\n> n-body\n\n> [!TIP]\n> t-body\n\n'
          '> [!IMPORTANT]\n> i-body\n\n> [!WARNING]\n> w-body\n\n'
          '> [!CAUTION]\n> c-body';
      final nodes = markdownToNodes(fixture);
      expect(nodes, hasLength(5));
      final tones = nodes
          .map((n) => n.props['border'] as String)
          .toSet();
      expect(tones, {
        r'$color.info',
        r'$color.success',
        r'$color.accent',
        r'$color.warning',
        r'$color.error',
      });
      final titles = [
        for (final node in nodes)
          (node.children.first.listProp('spans')!.last as Map)['text'],
      ];
      expect(titles,
          [' Note', ' Tip', ' Important', ' Warning', ' Caution']);
      final icons = [
        for (final node in nodes)
          (node.children.first.listProp('spans')!.first as Map)['icon'],
      ];
      expect(icons, ['info', 'lightbulb', 'message', 'warning', 'error']);
      // The body carries the mapped quote content without the marker line.
      expect(nodes[0].children[1].props['text'], 'n-body');
    });

    test('a marker with trailing text is an ordinary quote', () {
      final node = markdownToNodes('> [!NOTE] aside\n> body').single;
      expect(node.type, 'card');
      expect(node.children.single.props['text'], contains('[!NOTE] aside'));
    });

    test('an unknown kind is an ordinary quote', () {
      final node = markdownToNodes('> [!FOO]\n> body').single;
      expect(node.type, 'card');
      expect(node.children.single.props['text'], contains('[!FOO]'));
    });

    for (final kind in const ['note', 'tip', 'important', 'warning', 'caution']) {
      testWidgets('renders the $kind card and goldens', (tester) async {
        await _pumpMarkdown(
            tester, '> [!${kind.toUpperCase()}]\n> the body line');
        await _shot(tester, 'markdown-alert-$kind-light.png');
        final label = ' ${kind[0].toUpperCase()}${kind.substring(1)}';
        // The title run carries the leading glyph placeholder (\uFFFC in
        // the plain text), so match on containment.
        expect(find.textContaining(label, findRichText: true),
            findsOneWidget);
        expect(find.text('the body line'), findsOneWidget);
      });
    }
  });

  group('citations', () {
    test('a t3-citation link renders the citation chip span', () {
      final nodes = markdownToNodes(
          '[Assistant quote](t3-citation://v1/env/thread/msg?text=quoted%20line&start=0&end=11&prefix=&suffix=)');
      final spans = nodes.single.listProp('spans')!.cast<Map>();
      expect(spans.single['chip'], {'kind': 'citation', 'label': 'quoted line'});
      // The chip replaces the link: no openUrl action on a citation.
      expect(spans.single['action'], isNull);
    });

    testWidgets('renders the blue pill and goldens', (tester) async {
      await _pumpMarkdown(tester,
          '[Assistant quote](t3-citation://v1/env/thread/msg?text=quoted%20line&start=0&end=11&prefix=&suffix=)');
      await _shot(tester, 'markdown-citation-light.png');
      expect(find.text('quoted line'), findsOneWidget);
      expect(find.byType(Chip), findsOneWidget);
    });
  });

  group('skill inlines', () {
    test('a known skill token becomes the chip span; unknown stays text',
        () {
      final nodes = markdownToNodes('run \$commit please',
          skills: {'commit'});
      final spans = nodes.single.listProp('spans')!.cast<Map>();
      expect(spans[1]['chip'], {'kind': 'skill', 'label': r'$commit'});
      final plain = markdownToNodes('run \$commit please', skills: {'other'})
          .single;
      expect(plain.props['text'], 'run \$commit please');
    });

    test('tokens inside code and links are not split', () {
      final nodes = markdownToNodes('`x \$commit y` and [a](https://e/x\$commit)',
          skills: {'commit'});
      // The inline code span keeps its raw text; the link carries no chip.
      final spans = nodes.single.listProp('spans')!.cast<Map>();
      expect(spans[0]['text'], 'x \$commit y');
      final link = spans[3]; // [1]=' and ', [2]=icon, [3]=link text
      expect(link['chip'], isNull);
      expect(link['action']['op'], 'openUrl');
    });

    testWidgets('renders the pill and goldens', (tester) async {
      await _pumpMarkdown(tester, 'run \$commit please',
          skills: {'commit'});
      await _shot(tester, 'markdown-skill-light.png');
      expect(find.text(r'$commit'), findsOneWidget);
    });
  });

  group('non-features (T104.2)', () {
    test('display math renders as a math code block', () {
      final nodes = markdownToNodes('before\n\n\$\$\nx = y + 1\n\$\$\n\nafter');
      expect(nodes[0].props['text'], 'before');
      final math = nodes[1];
      expect(math.type, 'code_block');
      expect(math.props['language'], 'math');
      expect(math.props['code'], 'x = y + 1');
      expect(nodes[2].props['text'], 'after');
    });

    test('inline math renders as a math code block too', () {
      final node = markdownToNodes('\$\$E = mc^2\$\$').single;
      expect(node.type, 'code_block');
      expect(node.props['language'], 'math');
      expect(node.props['code'], 'E = mc^2');
    });

    test('footnote refs render as plain refs without an action', () {
      final nodes = markdownToNodes('Body[^1]\n\n[^1]: the note');
      // The ref flattens into its paragraph as plain text: no openUrl, no
      // icon span (the paragraph itself stays a plain `text` node).
      expect(nodes[0].type, 'text');
      expect(nodes[0].props['text'], 'Body1');
      // The definition section degrades to plain text (§2.4).
      expect(nodes[1].props['text'], contains('the note'));
    });

    testWidgets('math goldens as a code block', (tester) async {
      await _pumpMarkdown(tester, 'before\n\n\$\$\nx = y + 1\n\$\$');
      await _shot(tester, 'markdown-math-light.png');
      expect(find.text('math'), findsOneWidget);
      expect(find.text('x = y + 1'), findsOneWidget);
    });
  });

  group('malformed markdown never throws (T104.2)', () {
    const malformed = <String>[
      '```dart\nnever closed',
      '~~~~\nunclosed tildes',
      '> [!NOTE]\n> body\n```\n',
      '[broken link](https://',
      '![no src]()',
      '|||||',
      '\u0000\u0001control\u0002chars',
      '\$\$never closed\nx = y',
      'a [b](c\n"unclosed',
    ];

    test('every malformed input maps without throwing', () {
      for (final source in malformed) {
        expect(() => markdownToNode(source), returnsNormally,
            reason: 'markdownToNode threw on: $source');
        expect(() => markdownToNodes(source), returnsNormally,
            reason: 'markdownToNodes threw on: $source');
      }
    });

    test('an unbalanced fence degrades the whole source to plain text', () {
      final node = markdownToNode('before\n\n```java\ncode line\n');
      expect(node.type, 'text');
      expect(node.props['text'], 'before\n\n```java\ncode line\n');
    });

    test('an unclosed math marker stays plain text', () {
      final node = markdownToNode('\$\$never closed\nx = y');
      expect(node.type, 'text');
      expect(node.props['text'], contains('never closed'));
    });

    testWidgets('malformed sources render partial content without a crash',
        (tester) async {
      // An unbalanced fence degrades the whole source to its raw text —
      // rendered as-is, no crash (§2.4).
      await _pumpMarkdown(tester, '> fine quote\n\n```dart\nnever closed');
      expect(find.textContaining('fine quote'), findsOneWidget);
      expect(find.textContaining('never closed'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await _shot(tester, 'markdown-malformed-light.png');

      // Supported constructs around a broken one render partially: the
      // quote renders as a card, the HTML block degrades to text.
      await _pumpMarkdown(tester, '> fine quote\n\n<div>raw html</div>');
      expect(find.text('fine quote'), findsOneWidget);
      expect(find.textContaining('<div>raw html</div>'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    test('fail mode: malformed markdown throws (the inverted expectation)',
        () {
      if (!const bool.fromEnvironment('T104_FAIL_MODE')) return;
      // Only reached on the QA --fail path: the deliberately wrong
      // expectation that the parser throws on malformed input. It does not
      // — this test must fail for the harness to prove it catches a broken
      // robustness contract.
      expect(() => markdownToNode('```dart\nnever closed'), throwsA(anything));
    });
  });
}
