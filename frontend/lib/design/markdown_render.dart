/// The `markdown` block-to-primitive renderer (docs/sdui.md §2.6, the
/// "Markdown block mapping" table): parses the markdown source with the
/// published `markdown` package and maps the parsed blocks onto the SDUI
/// primitive catalog — paragraphs to `text`/`rich_text`, headings to `text`
/// with a `style` token, fenced code to `code_block`, lists to `list`,
/// blockquotes to `card`, tables to `table`, links to `rich_text` spans with
/// an `openUrl` action, images to `image`.
///
/// Every unsupported or malformed construct degrades to a plain `text` node
/// (the documented degrade list next to the mapping table) — the mapping
/// never throws, whatever the source contains.
library;

import 'package:markdown/markdown.dart' as md;

import '../sdui/ui_node.dart';

/// Parses [source] and returns the mapped node tree: a `container` of the
/// mapped blocks (a single `text` for an unbalanced code fence — the
/// documented degrade).
UiNode markdownToNode(String source) {
  if (_hasUnbalancedFence(source)) {
    return UiNode(type: 'text', props: {'text': source});
  }
  final blocks = _blocks(md.Document(extensionSet: md.ExtensionSet.gitHubWeb)
      .parseLines(source.split('\n')));
  if (blocks.length == 1) return blocks.first;
  return UiNode(
    type: 'container',
    props: {'direction': 'column', 'gap': '\$spacing.md'},
    children: blocks,
  );
}

/// The mapped blocks of [source], one [UiNode] per markdown block — the
/// mapping output tests assert on.
List<UiNode> markdownToNodes(String source) => _blocks(
    md.Document(extensionSet: md.ExtensionSet.gitHubWeb)
        .parseLines(source.split('\n')));

/// A code-fence delimiter line: up to three leading spaces and a run of
/// three or more backticks or tildes.
final _fenceLine = RegExp(r'^ {0,3}(`{3,}|~{3,})');

/// Whether [source] opens a fenced code block it never closes: an odd count
/// of fence delimiter lines degrades the whole markdown node to a plain
/// `text` (§2.4 — never a crash).
bool _hasUnbalancedFence(String source) {
  var fences = 0;
  for (final line in source.split('\n')) {
    if (_fenceLine.hasMatch(line)) fences++;
  }
  return fences.isOdd;
}

// ---------------------------------------------------------------------------
// Block mapping
// ---------------------------------------------------------------------------

List<UiNode> _blocks(List<md.Node> nodes) {
  final out = <UiNode>[];
  for (final node in nodes) {
    out.addAll(_block(node));
  }
  return out;
}

List<UiNode> _block(md.Node node) {
  if (node is! md.Element) {
    // A bare Text block is the raw source of an HTML block — degrade to a
    // plain `text` (§2.4).
    final text = node.textContent.trim();
    return text.isEmpty ? const [] : [UiNode(type: 'text', props: {'text': text})];
  }
  switch (node.tag) {
    case 'p':
      return _paragraph(node);
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return _heading(node);
    case 'pre':
      return [_codeBlock(node)];
    case 'ul':
    case 'ol':
      return [_list(node)];
    case 'blockquote':
      return [_quote(node)];
    case 'table':
      return [_table(node)];
    case 'hr':
      return [UiNode(type: 'divider', props: const {})];
    default:
      // Unsupported blocks — footnotes, definition lists, unknown elements —
      // degrade to a plain `text` of their content (§2.4).
      final text = node.textContent.trim();
      return text.isEmpty ? const [] : [UiNode(type: 'text', props: {'text': text})];
  }
}

List<UiNode> _heading(md.Element element) {
  final level = int.tryParse(element.tag.substring(1)) ?? 1;
  // h1..h3 map to their token; h4..h6 collapse to the nearest one, `h3`.
  final style = level <= 1 ? 'h1' : level == 2 ? 'h2' : 'h3';
  final spans = _spans(element.children ?? const []);
  return [_inlineNode(spans, style: style)];
}

List<UiNode> _paragraph(md.Element element) {
  final out = <UiNode>[];
  var pending = <md.Node>[];
  void flush() {
    if (pending.isEmpty) return;
    final spans = _spans(pending);
    pending = [];
    if (spans.isNotEmpty) out.add(_inlineNode(spans));
  }

  for (final child in element.children ?? const <md.Node>[]) {
    if (child is md.Element && child.tag == 'img') {
      flush();
      final image = _image(child);
      if (image != null) out.add(image);
    } else {
      pending.add(child);
    }
  }
  flush();
  return out;
}

UiNode _codeBlock(md.Element element) {
  final code = element.children?.isNotEmpty == true ? element.children!.first : null;
  var source = code?.textContent ?? element.textContent;
  if (source.endsWith('\n')) source = source.substring(0, source.length - 1);
  final props = <String, dynamic>{'code': source};
  final language = _languageOf(code);
  if (language != null) props['language'] = language;
  return UiNode(type: 'code_block', props: props);
}

String? _languageOf(md.Node? code) {
  if (code is! md.Element) return null;
  final classes = code.attributes['class']?.split(RegExp(r'\s+')) ?? const [];
  for (final name in classes) {
    if (name.startsWith('language-') && name.length > 'language-'.length) {
      return name.substring('language-'.length);
    }
  }
  return null;
}

UiNode _list(md.Element element) {
  final ordered = element.tag == 'ol';
  final items = <UiNode>[];
  var number = 1;
  for (final child in element.children ?? const <md.Node>[]) {
    if (child is! md.Element || child.tag != 'li') continue;
    items.add(_listItem(child, ordered ? '$number. ' : null));
    number++;
  }
  return UiNode(type: 'list', props: {
    'items': [for (final item in items) item.toJson()],
  });
}

UiNode _listItem(md.Element element, String? prefix) {
  final inline = <md.Node>[];
  final nested = <md.Element>[];
  for (final child in element.children ?? const <md.Node>[]) {
    if (child is md.Element && (child.tag == 'ul' || child.tag == 'ol')) {
      nested.add(child);
    } else if (child is md.Element && child.tag == 'p') {
      // A loose list item: its paragraph content, without paragraph chrome.
      inline.addAll(child.children ?? const []);
    } else {
      inline.add(child);
    }
  }
  final spans = _spans(inline);
  if (prefix != null && spans.isNotEmpty) {
    spans.first = _Span('$prefix${spans.first.text}',
        style: spans.first.style, action: spans.first.action, tooltip: spans.first.tooltip);
  }
  final content = spans.isEmpty ? null : _inlineNode(spans);
  if (nested.isEmpty) {
    return content ?? UiNode(type: 'text', props: const {'text': ''});
  }
  return UiNode(
    type: 'container',
    props: {'direction': 'column', 'gap': r'$spacing.sm'},
    children: [
      ?content,
      for (final list in nested) _list(list),
    ],
  );
}

UiNode _quote(md.Element element) {
  final inner = _blocks(element.children ?? const []);
  return UiNode(type: 'card', props: const {}, children: inner);
}

UiNode _table(md.Element element) {
  final columns = <Map<String, dynamic>>[];
  final rows = <List<Object>>[];
  for (final section in element.children ?? const <md.Node>[]) {
    if (section is! md.Element) continue;
    for (final row in section.children ?? const <md.Node>[]) {
      if (row is! md.Element || row.tag != 'tr') continue;
      final cells = <Object>[];
      for (final cell in row.children ?? const <md.Node>[]) {
        cells.add(cell.textContent.trim());
      }
      if (section.tag == 'thead') {
        for (final cell in cells) {
          columns.add({'label': cell});
        }
      } else if (cells.isNotEmpty) {
        rows.add(cells);
      }
    }
  }
  if (columns.isEmpty) {
    // A table without a header degrades to its plain text (§2.4).
    final text = element.textContent.trim();
    return UiNode(type: 'text', props: {'text': text});
  }
  return UiNode(type: 'table', props: {
    'columns': columns,
    'rows': rows,
  });
}

UiNode? _image(md.Element element) {
  final src = element.attributes['src'];
  if (src == null || src.isEmpty) return null;
  final alt = element.attributes['alt'];
  final props = <String, dynamic>{'src': src};
  if (alt != null && alt.isNotEmpty) props['semanticsLabel'] = alt;
  return UiNode(type: 'image', props: props);
}

// ---------------------------------------------------------------------------
// Inline mapping
// ---------------------------------------------------------------------------

/// One mapped inline run: the span wire shape `{text, style?, action?,
/// tooltip?}` of §2.6 (an image is flushed as its own block node instead).
class _Span {
  const _Span(this.text, {this.style, this.action, this.tooltip});

  final String text;
  final Map<String, dynamic>? style;
  final Map<String, dynamic>? action;
  final String? tooltip;

  bool get plain => style == null && action == null && tooltip == null;
}

/// The wire shape of one span: `{text, style?, action?, tooltip?}`.
Map<String, dynamic> _spanJson(_Span span) {
  final map = <String, dynamic>{'text': span.text};
  if (span.style != null) map['style'] = span.style;
  if (span.action != null) map['action'] = span.action;
  if (span.tooltip != null) map['tooltip'] = span.tooltip;
  return map;
}

/// Builds the `text`/`rich_text` node of one inline run: a plain run becomes
/// `text`, anything styled or tappable becomes `rich_text` spans.
UiNode _inlineNode(List<_Span> spans, {String? style}) {
  UiNode node(String type, Map<String, dynamic> props) {
    if (style != null) props['style'] = style;
    return UiNode(type: type, props: props);
  }

  if (spans.length == 1 && spans.first.plain) {
    return node('text', {'text': spans.first.text});
  }
  if (spans.isEmpty) {
    return node('text', {'text': ''});
  }
  return node('rich_text', {
    'spans': [for (final span in spans) _spanJson(span)],
  });
}

/// Maps inline nodes to span runs, merging `emphasis`/`strong`/`code`/
/// `del`/`link` styles and flattening unknown elements to their plain text.
/// Adjacent plain runs coalesce into one span.
List<_Span> _spans(
  List<md.Node> nodes, {
  Map<String, dynamic>? style,
  Map<String, dynamic>? action,
  String? tooltip,
}) {
  final out = <_Span>[];

  void add(String text, {Map<String, dynamic>? style, Map<String, dynamic>? action, String? tooltip}) {
    if (text.isEmpty) return;
    final span = _Span(text, style: style, action: action, tooltip: tooltip);
    if (span.plain && out.isNotEmpty && out.last.plain) {
      out[out.length - 1] = _Span('${out.last.text}$text');
      return;
    }
    out.add(span);
  }

  void walk(
    md.Node node, {
    Map<String, dynamic>? style,
    Map<String, dynamic>? action,
    String? tooltip,
  }) {
    Map<String, dynamic>? merge(Map<String, dynamic>? extra) =>
        extra == null ? style : {...?style, ...extra};

    if (node is md.Text) {
      add(node.text, style: style, action: action, tooltip: tooltip);
      return;
    }
    if (node is! md.Element) {
      add(node.textContent, style: style, action: action, tooltip: tooltip);
      return;
    }
    final children = node.children ?? const <md.Node>[];
    switch (node.tag) {
      case 'em':
        for (final child in children) {
          walk(child,
              style: merge(const {'fontStyle': 'italic'}),
              action: action,
              tooltip: tooltip);
        }
      case 'strong':
        for (final child in children) {
          walk(child,
              style: merge(const {'fontWeight': 700}),
              action: action,
              tooltip: tooltip);
        }
      case 'del':
        for (final child in children) {
          walk(child,
              style: merge(const {'textDecoration': 'lineThrough'}),
              action: action,
              tooltip: tooltip);
        }
      case 'code':
        add(node.textContent,
            style: merge(const {'fontFamily': r'$font.mono'}),
            action: action,
            tooltip: tooltip);
      case 'a':
        final href = node.attributes['href'];
        final linkAction = href == null || href.isEmpty
            ? action
            : {'op': 'openUrl', 'value': href};
        for (final child in children) {
          walk(child,
              style: merge(const {
                'textDecoration': 'underline',
                'color': r'$color.accent',
              }),
              action: linkAction,
              tooltip: tooltip);
        }
      case 'sup':
        // Footnote references and other superscripts flatten to their plain
        // text, without the nested link's action.
        add(node.textContent, style: style, action: action, tooltip: tooltip);
      case 'br':
        add('\n', style: style, action: action, tooltip: tooltip);
      default:
        // Unknown inline elements flatten to their plain text (§2.4).
        add(node.textContent, style: style, action: action, tooltip: tooltip);
    }
  }

  for (final node in nodes) {
    walk(node, style: style, action: action, tooltip: tooltip);
  }
  return out;
}
