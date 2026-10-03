import 'package:flutter/material.dart' hide ActionDispatcher;
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/markdown_render.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/directives.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T60 — `text`/`rich_text` typography parity, real `markdown` rendering and
/// the `code_block` primitive over the harness pattern of
/// `design/universal_props_test.dart`: a recording [RenderContext] over a
/// fresh [UiState], [UiNode.fromJson], `ctx.build`.
///
/// Client rule (§2.4/§9): unknown props, unknown enum literals and unknown
/// markdown constructs degrade silently — none of these tests may throw on
/// server content.

/// A [DirectiveHost] recording the toasts it is asked to show; the copy
/// affordance of `code_block` proves its toast feedback here.
class _ToastHost implements DirectiveHost {
  final List<String> toasts = [];

  @override
  Future<void> toast(String text, String? style) async => toasts.add(text);

  @override
  Future<void> navigate(String screen) async {}

  @override
  Future<void> back() async {}

  @override
  Future<void> replace(String screen) async {}

  @override
  Future<void> refresh() async {}

  @override
  Future<void> reloadBootstrap() async {}

  @override
  Future<void> setToken(String value) async {}

  @override
  Future<void> clearToken() async {}

  @override
  Future<void> setServerUrl(String value) async {}

  @override
  Future<void> openProfiles() async {}

  @override
  Future<void> dialog(Map<String, dynamic> node) async {}

  @override
  Future<void> dismissDialog() async {}

  @override
  Future<void> setStateValue(String id, Object? value) async {}

  @override
  Future<void> patch(String id, Map<String, dynamic> props) async {}

  @override
  Future<void> setScreen(String id, Map<String, dynamic> node) async {}

  @override
  Future<void> openUrl(String value) async {}
}

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
    dispatch: (action) async =>
        dispatched.add(Map<String, dynamic>.from(action)),
    openStream: (topic, {onStatus}) => const Stream.empty(),
    runDirectives: (directives) async {
      final host = _ToastHost();
      await DirectiveExecutor(host).execute(directives);
      toasts.addAll(host.toasts);
    },
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

Future<_Harness> _pumpNode(WidgetTester tester, Object? json, {Size? size}) async {
  if (size != null) {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
  }
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

/// The [RenderParagraph] under the `Text.rich`/`rich_text` node.
RenderParagraph _paragraphOf(WidgetTester tester, Finder textFinder) {
  return tester.renderObject<RenderParagraph>(
      find.descendant(of: textFinder, matching: find.byType(RichText)).first);
}

/// Taps the run of [spanText] inside one rich-text paragraph.
Future<void> _tapSpan(
    WidgetTester tester, Finder textFinder, String spanText) async {
  final paragraph = _paragraphOf(tester, textFinder);
  final plain = paragraph.text.toPlainText();
  final start = plain.indexOf(spanText);
  expect(start, greaterThanOrEqualTo(0), reason: 'span "$spanText" in "$plain"');
  final box = paragraph
      .getBoxesForSelection(
          TextSelection(baseOffset: start, extentOffset: start + spanText.length))
      .first;
  await tester.tapAt(paragraph.localToGlobal(box.toRect().center));
  await tester.pump();
}

/// Rich-text runs whose plain text contains [fragment].
Finder _richRuns(String fragment) => find.byWidgetPredicate((widget) =>
    widget is RichText && widget.text.toPlainText().contains(fragment));

/// The ~30-line markdown fixture: paragraphs, h1-h3, a fenced code block,
/// nested lists, an ordered list, a blockquote, a table, a link, an image
/// and unsupported constructs (an HTML block and a footnote).
const _fixture = '''
# Title One

Intro paragraph with a [link](https://example.com/x) and **bold**.

## Sub two

### Sub three

- alpha
- beta
  - nested one
  - nested two

1. first
2. second

```java
public class A {}
```

> quoted line

| Name | Path |
|------|------|
| a    | b    |

![alt text](https://example.invalid/i.png)

<div>raw html block</div>

A footnote ref[^note] here.

[^note]: the note text

---

Done.
''';

/// The mapped block tree as `type summary` lines, recorded in
/// `.sisyphus/evidence/T60/markdown-tree.txt`.
String _tree(List<UiNode> nodes) {
  final out = StringBuffer();
  void walk(UiNode node, int depth) {
    final pad = '  ' * depth;
    final summary = switch (node.type) {
      'text' =>
        'text "${node.stringProp('text')}" style=${node.stringProp('style') ?? 'body'}',
      'rich_text' => 'rich_text spans=${node.listProp('spans')?.length ?? 0}',
      'code_block' =>
        'code_block language=${node.stringProp('language')} code="${node.stringProp('code')}"',
      'list' => 'list items=${(node.listProp('items') ?? const []).length}',
      'card' => 'card children=${node.children.length}',
      'table' => 'table columns=${(node.listProp('columns') ?? const []).length} '
          'rows=${(node.listProp('rows') ?? const []).length}',
      'image' => 'image src=${node.stringProp('src')} '
          'alt=${node.stringProp('semanticsLabel')}',
      'divider' => 'divider',
      _ => node.type,
    };
    out.writeln('$pad$summary');
    for (final span in node.listProp('spans') ?? const []) {
      if (span is Map) {
        final action = span['action'];
        out.writeln('$pad  span "${span['text']}"'
            '${action != null ? ' action=$action' : ''}'
            '${span['style'] != null ? ' style=${span['style']}' : ''}');
      }
    }
    for (final item in node.listProp('items') ?? const []) {
      if (item is Map) walk(UiNode.fromJson(item), depth + 1);
    }
    for (final child in node.children) {
      walk(child, depth + 1);
    }
  }

  for (final node in nodes) {
    walk(node, 0);
  }
  return out.toString();
}

void main() {
  group('text typography parity (§2.6)', () {
    testWidgets('style h1/h2/h3/body/small/caption/mono map to the '
        'typography tokens; caption maps to small', (tester) async {
      final tokens = JhinTheme.fallback().tokens;
      for (final entry in {
        'h1': tokens.typography.h1,
        'h2': tokens.typography.h2,
        'h3': tokens.typography.h3,
        'body': tokens.typography.body,
        'small': tokens.typography.small,
        'caption': tokens.typography.small,
        'mono': tokens.typography.mono,
      }.entries) {
        await _pumpNode(tester, {'type': 'text', 'text': 'S', 'style': entry.key});
        final text = tester.widget<Text>(find.text('S'));
        expect(text.style, entry.value, reason: 'style ${entry.key}');
      }
    });

    testWidgets('an unknown style token degrades to body; bold/italic/color '
        'apply over it', (tester) async {
      final tokens = JhinTheme.fallback().tokens;
      await _pumpNode(tester, {
        'type': 'text',
        'text': 'S',
        'style': 'nope',
        'bold': true,
        'italic': true,
        'color': '#112233',
      });
      final style = tester.widget<Text>(find.text('S')).style!;
      expect(style.fontSize, tokens.typography.body.fontSize);
      expect(style.fontWeight, FontWeight.bold);
      expect(style.fontStyle, FontStyle.italic);
      expect(style.color, const Color(0xFF112233));
    });

    testWidgets('strutStyle, textWidthBasis, locale and selectionColor land '
        'on the Text widget', (tester) async {
      await _pumpNode(tester, {
        'type': 'text',
        'text': 'S',
        'strutStyle': {'size': 18, 'height': 1.4, 'leading': 2},
        'textWidthBasis': 'longestLine',
        'locale': 'en-US',
        'selectionColor': '#FF00FF',
      });
      final text = tester.widget<Text>(find.text('S'));
      expect(text.strutStyle?.fontSize, 18);
      expect(text.strutStyle?.height, 1.4);
      expect(text.strutStyle?.leading, 2);
      expect(text.textWidthBasis, TextWidthBasis.longestLine);
      expect(text.locale.toString(), 'en_US');
      expect(text.selectionColor, const Color(0xFFFF00FF));
    });

    testWidgets('textWidthBasis character degrades to parent; overflow is '
        'the accepted alias of textOverflow', (tester) async {
      await _pumpNode(tester, {
        'type': 'text',
        'text': 'S',
        'textWidthBasis': 'character',
        'overflow': 'ellipsis',
      });
      final text = tester.widget<Text>(find.text('S'));
      expect(text.textWidthBasis, TextWidthBasis.parent);
      expect(text.overflow, TextOverflow.ellipsis);
    });

    testWidgets('universal Text group (maxLines, softWrap, fontFamily) lands '
        'over the named style', (tester) async {
      await _pumpNode(tester, {
        'type': 'text',
        'text': 'S',
        'style': 'h1',
        'maxLines': 2,
        'softWrap': false,
        'ellipsis': true,
        'fontFamily': 'Roboto',
        'fontSize': 99,
      });
      final text = tester.widget<Text>(find.text('S'));
      expect(text.maxLines, 2);
      expect(text.softWrap, isFalse);
      expect(text.overflow, TextOverflow.ellipsis);
      expect(text.style?.fontFamily, 'Roboto');
      expect(text.style?.fontSize, 99);
      // The named typography style survives the universal merge.
      expect(text.style?.fontWeight, FontWeight.w700);
    });

    testWidgets('a missing text prop degrades to a visible placeholder',
        (tester) async {
      await _pumpNode(tester, {'type': 'text'});
      expect(find.text('Missing text'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('rich_text (§2.6)', () {
    testWidgets('spans render as one rich text run with their styles',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'rich_text',
        'spans': [
          {'text': 'plain '},
          {'text': 'h1', 'style': 'h1'},
          {
            'text': 'fat',
            'style': {'fontWeight': 700},
          },
        ],
      });
      expect(tester.takeException(), isNull);
      final text = tester.widget<Text>(
          find.byWidgetPredicate((w) => w is Text && w.textSpan != null));
      final spans = (text.textSpan! as TextSpan).children!.cast<TextSpan>();
      expect(spans.map((s) => s.text), ['plain ', 'h1', 'fat']);
      expect(spans[1].style, JhinTheme.fallback().tokens.typography.h1);
      expect(spans[2].style?.fontWeight, FontWeight.w700);
    });

    testWidgets('a span action dispatches on tap', (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'rich_text',
        'spans': [
          {'text': 'go '},
          {
            'text': 'there',
            'action': {'path': '/ui/action/go', 'name': 'go'},
          },
        ],
      });
      await _tapSpan(
          tester,
          find.byWidgetPredicate((w) => w is Text && w.textSpan != null),
          'there');
      expect(harness.dispatched, [
        {'path': '/ui/action/go', 'name': 'go'},
      ]);
    });

    testWidgets('a span tooltip wraps its own text', (tester) async {
      await _pumpNode(tester, {
        'type': 'rich_text',
        'spans': [
          {
            'text': 'hinted',
            'tooltip': 'a hint',
          },
        ],
      });
      expect(find.byTooltip('a hint'), findsOneWidget);
      expect(find.text('hinted', findRichText: true), findsOneWidget);
    });

    testWidgets('a rich_text span with an unknown action drops the action '
        'but keeps the text', (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'rich_text',
        'spans': [
          {'text': 'kept'},
          {
            'text': 'dead',
            'action': {'op': 'not_a_directive', 'value': 'x'},
          },
        ],
      });
      expect(_richRuns('kept'), findsOneWidget);
      expect(_richRuns('dead'), findsOneWidget);
      await _tapSpan(
          tester,
          find.byWidgetPredicate((w) => w is Text && w.textSpan != null),
          'dead');
      expect(harness.dispatched, isEmpty);
      expect(tester.takeException(), isNull);
    });

    testWidgets('an unknown rich_text span field is ignored', (tester) async {
      await _pumpNode(tester, {
        'type': 'rich_text',
        'spans': [
          {'text': 'kept', 'glow': true, 'style': 'nope'},
        ],
      });
      expect(_richRuns('kept'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('missing spans degrades to a visible placeholder',
        (tester) async {
      await _pumpNode(tester, {'type': 'rich_text', 'spans': []});
      expect(find.text('Missing spans'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('markdown mapping (§2.6)', () {
    test('markdown fixture renders the expected primitive tree', () {
      final nodes = markdownToNodes(_fixture);
      // The mapping of the fixture, block by block.
      expect(nodes.map((n) => n.type).toList(), [
        'text', // # Title One
        'rich_text', // intro with a link and bold
        'text', // ## Sub two
        'text', // ### Sub three
        'list', // bullet list with a nested list
        'list', // ordered list
        'code_block', // ```java fence
        'card', // blockquote
        'table', // pipe table
        'image', // ![alt text](…)
        'text', // the HTML block degrades to text
        'text', // the footnote reference paragraph
        'divider', // ---
        'text', // Done.
        'text', // the footnote definition degrades to text (hoisted last)
      ]);

      expect(nodes[0].props['text'], 'Title One');
      expect(nodes[0].props['style'], 'h1');
      expect(nodes[2].props['style'], 'h2');
      expect(nodes[3].props['style'], 'h3');

      final intro = nodes[1];
      final spans = intro.listProp('spans')!.cast<Map>();
      expect(spans.map((s) => s['text']).toList(),
          ['Intro paragraph with a ', 'link', ' and ', 'bold', '.']);
      expect(spans[1]['action'], {'op': 'openUrl', 'value': 'https://example.com/x'});
      expect(spans[3]['style'], {'fontWeight': 700});

      final items = nodes[4].listProp('items')!.cast<Map>();
      expect(items, hasLength(2));
      expect(items[0]['text'], 'alpha');
      final beta = UiNode.fromJson(items[1]);
      expect(beta.type, 'container');
      expect(beta.children[0].props['text'], 'beta');
      expect(beta.children[1].type, 'list');
      final nested = beta.children[1].listProp('items')!.cast<Map>();
      expect(nested.map((e) => e['text']), ['nested one', 'nested two']);

      final ordered = nodes[5].listProp('items')!.cast<Map>();
      expect(ordered.map((e) => e['text']), ['1. first', '2. second']);

      expect(nodes[6].props['code'], 'public class A {}');
      expect(nodes[6].props['language'], 'java');

      expect(nodes[7].children.single.props['text'], 'quoted line');

      expect(nodes[8].listProp('columns'), [
        {'label': 'Name'},
        {'label': 'Path'},
      ]);
      expect(nodes[8].listProp('rows'), [
        ['a', 'b'],
      ]);

      expect(nodes[9].props['src'], 'https://example.invalid/i.png');
      expect(nodes[9].props['semanticsLabel'], 'alt text');

      expect(nodes[10].props['text'], contains('<div>raw html block</div>'));
      expect(nodes[11].props['text'], 'A footnote ref1 here.');
      expect(nodes[12].type, 'divider');
      expect(nodes[13].props['text'], 'Done.');
      expect(nodes[14].props['text'], startsWith('the note text'));

      // The recorded fixture and tree dump for
      // .sisyphus/evidence/T60/markdown-tree.txt.
      print('T60_MARKDOWN_FIXTURE_BEGIN');
      print(_fixture);
      print('T60_MARKDOWN_FIXTURE_END');
      print('T60_MARKDOWN_TREE_BEGIN');
      print(_tree(nodes));
      print('T60_MARKDOWN_TREE_END');
    });

    testWidgets('the markdown fixture renders its blocks as widgets',
        (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'markdown',
        'text': _fixture,
      }, size: const Size(1000, 3000));
      expect(tester.takeException(), isNull);

      // headings and paragraphs
      expect(find.text('Title One'), findsOneWidget);
      expect(find.text('Sub two'), findsOneWidget);
      expect(find.text('Sub three'), findsOneWidget);
      // the fenced code block, with its language label
      expect(find.text('java'), findsOneWidget);
      expect(find.text('public class A {}'), findsOneWidget);
      // lists, nested included
      expect(find.text('alpha'), findsOneWidget);
      expect(find.text('nested one'), findsOneWidget);
      expect(find.text('1. first'), findsOneWidget);
      // the quote card
      expect(find.text('quoted line'), findsOneWidget);
      // the table
      expect(find.text('Name'), findsOneWidget);
      expect(find.text('Path'), findsOneWidget);
      // the image and the degraded constructs
      expect(find.byType(Image), findsOneWidget);
      expect(find.textContaining('<div>raw html block</div>'), findsOneWidget);

      // the link span dispatches an openUrl action
      await _tapSpan(
          tester,
          find.byWidgetPredicate((w) => w is Text && w.textSpan != null),
          'link');
      expect(harness.dispatched, [
        {'op': 'openUrl', 'value': 'https://example.com/x'},
      ]);
    });

    testWidgets('markdown legacy style and color apply to every block',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'markdown',
        'text': 'plain block',
        'style': 'h1',
        'color': '#112233',
      });
      final text = tester.widget<Text>(find.text('plain block'));
      expect(text.style?.fontSize, JhinTheme.fallback().tokens.typography.h1.fontSize);
      expect(text.style?.color, const Color(0xFF112233));
    });
  });

  group('code_block (§2.6)', () {
    testWidgets('language label and code render in monospace', (tester) async {
      await _pumpNode(tester, {
        'type': 'code_block',
        'code': 'x = 1',
        'language': 'python',
      });
      expect(find.text('python'), findsOneWidget);
      final code = tester.widget<Text>(find.text('x = 1'));
      expect(code.style?.fontFamily, 'monospace');
    });

    testWidgets('code_block copy sends the exact source to the clipboard '
        'and toasts', (tester) async {
      final calls = <MethodCall>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform, (call) async {
        calls.add(call);
        return null;
      });
      final harness = await _pumpNode(tester, {
        'type': 'code_block',
        'code': 'line1\nline 2',
        'language': 'text',
        'copyable': true,
      });
      await tester.tap(find.byIcon(Icons.copy));
      await tester.pumpAndSettle();

      final setData =
          calls.where((call) => call.method == 'Clipboard.setData').toList();
      expect(setData, hasLength(1));
      expect((setData.single.arguments as Map)['text'], 'line1\nline 2');
      expect(harness.toasts, contains('Copied to clipboard'));

      tester.binding.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null);
    });

    testWidgets('wrap false scrolls horizontally; wrap true wraps the code',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'code_block',
        'code': 'a very long single line',
        'wrap': false,
      });
      expect(find.byType(SingleChildScrollView), findsOneWidget);

      await _pumpNode(tester, {
        'type': 'code_block',
        'code': 'a very long single line',
        'wrap': true,
      });
      expect(find.byType(SingleChildScrollView), findsNothing);
      expect(tester.widget<Text>(find.text('a very long single line')).softWrap,
          isTrue);
    });

    testWidgets('maxLines limits the line count', (tester) async {
      await _pumpNode(tester, {
        'type': 'code_block',
        'code': 'a\nb\nc',
        'maxLines': 2,
      });
      expect(tester.widget<Text>(find.text('a\nb\nc')).maxLines, 2);
    });

    testWidgets('lineNumbers shows the line numbers', (tester) async {
      await _pumpNode(tester, {
        'type': 'code_block',
        'code': 'aaa\nbbb',
        'lineNumbers': true,
      });
      expect(find.text('1'), findsOneWidget);
      expect(find.text('2'), findsOneWidget);
    });

    testWidgets('code_block with unknown language just labels it',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'code_block',
        'code': 'x',
        'language': 'klingon',
      });
      expect(find.text('klingon'), findsOneWidget);
      expect(find.text('x'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('degrades (§2.4)', () {
    test('unbalanced markdown fence degrades to plain text', () {
      final node = markdownToNode('before\n\n```java\ncode line\n');
      expect(node.type, 'text');
      expect(node.props['text'], 'before\n\n```java\ncode line\n');
    });

    testWidgets(
        'an unbalanced markdown fence renders as plain text without a crash',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'markdown',
        'text': 'before\n\n```java\ncode line\n',
      });
      expect(find.textContaining('```java'), findsOneWidget);
      expect(find.textContaining('code line'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    test('unknown markdown construct degrades to text', () {
      final nodes = markdownToNodes('ref[^x]\n\n[^x]: note\n\n<div>raw</div>');
      // The footnote reference flattens into its paragraph; the footnote
      // definition and the HTML block degrade to plain `text` nodes.
      expect(nodes.map((n) => n.type).toList(), ['text', 'text', 'text']);
      expect(nodes[0].props['text'], 'ref1');
      expect(nodes[1].props['text'], contains('<div>raw</div>'));
      expect(nodes[2].props['text'], startsWith('note'));
    });

    testWidgets('an unknown markdown construct renders as text without a crash',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'markdown',
        'text': '[^x]: note\n\n<div>raw</div>',
      });
      expect(find.textContaining('<div>raw</div>'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
