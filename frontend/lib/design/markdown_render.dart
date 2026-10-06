/// The `markdown` block-to-primitive renderer (docs/sdui.md §2.6, the
/// "Markdown block mapping" table): parses the markdown source with the
/// published `markdown` package and maps the parsed blocks onto the SDUI
/// primitive catalog — paragraphs to `text`/`rich_text`, headings to `text`
/// with a `style` token, fenced code to `code_block`, lists to `list`,
/// blockquotes to `card`, GitHub alerts to a bordered `box` callout, tables
/// to `table`, links to `rich_text` spans with an `openUrl` action, images
/// to `image` (or an inline `image` span), `t3-citation:` links and known
/// `$skill` tokens to inline `chip` spans.
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
UiNode markdownToNode(String source, {Set<String>? skills}) {
  if (_hasUnbalancedFence(source)) {
    return UiNode(type: 'text', props: {'text': source});
  }
  try {
    final blocks = _blocks(
        _document().parseLines(_mathFences(source.split('\n'))),
        skills: skills);
    if (blocks.length == 1) return blocks.first;
    return UiNode(
      type: 'container',
      props: {'direction': 'column', 'gap': '\$spacing.md'},
      children: blocks,
    );
  } catch (_) {
    // Malformed beyond recovery: degrade to the raw source as plain text
    // (§2.4 — the client never crashes on server content).
    return UiNode(type: 'text', props: {'text': source});
  }
}

/// The mapped blocks of [source], one [UiNode] per markdown block — the
/// mapping output tests assert on.
List<UiNode> markdownToNodes(String source, {Set<String>? skills}) {
  try {
    return _blocks(_document().parseLines(_mathFences(source.split('\n'))),
        skills: skills);
  } catch (_) {
    return [UiNode(type: 'text', props: {'text': source})];
  }
}

md.Document _document() => md.Document(extensionSet: md.ExtensionSet.gitHubWeb);

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
// LaTeX math — the explicit non-feature (T104.2)
// ---------------------------------------------------------------------------

/// Folds `$$ … $$` display-math blocks into `math` code fences before
/// parsing, so math renders as a `code_block` (the documented non-feature:
/// no LaTeX typesetting — the raw TeX source shows in a mono block). A
/// `$$` marker that never closes stays plain text (the degrade).
List<String> _mathFences(List<String> lines) {
  final out = <String>[];
  var index = 0;
  while (index < lines.length) {
    final trimmed = lines[index].trim();
    if (trimmed == '\$\$') {
      final body = <String>[];
      var cursor = index + 1;
      var closed = false;
      for (; cursor < lines.length; cursor++) {
        if (lines[cursor].trim() == '\$\$') {
          closed = true;
          cursor++;
          break;
        }
        body.add(lines[cursor]);
      }
      if (closed) {
        out
          ..add('```math')
          ..addAll(body)
          ..add('```');
        index = cursor;
        continue;
      }
    } else if (trimmed.length > 4 &&
        trimmed.startsWith('\$\$') &&
        trimmed.endsWith('\$\$')) {
      // Single-line `$$ x = y $$`.
      out
        ..add('```math')
        ..add(trimmed.substring(2, trimmed.length - 2).trim())
        ..add('```');
      index++;
      continue;
    }
    out.add(lines[index]);
    index++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block mapping
// ---------------------------------------------------------------------------

List<UiNode> _blocks(List<md.Node> nodes, {Set<String>? skills}) {
  final out = <UiNode>[];
  for (final node in nodes) {
    out.addAll(_block(node, skills: skills));
  }
  return out;
}

List<UiNode> _block(md.Node node, {Set<String>? skills}) {
  if (node is! md.Element) {
    // A bare Text block is the raw source of an HTML block — degrade to a
    // plain `text` (§2.4).
    final text = node.textContent.trim();
    return text.isEmpty ? const [] : [UiNode(type: 'text', props: {'text': text})];
  }
  switch (node.tag) {
    case 'p':
      return _paragraph(node, skills: skills);
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return _heading(node, skills: skills);
    case 'pre':
      return [_codeBlock(node)];
    case 'ul':
    case 'ol':
      return [_list(node, skills: skills)];
    case 'blockquote':
      return [_quote(node, skills: skills)];
    case 'table':
      return [_table(node)];
    case 'hr':
      return [UiNode(type: 'divider', props: const {})];
    case 'div':
      final alert = _alertKindOf(node);
      if (alert != null) return [_alertCard(alert, node, skills: skills)];
      return _degradedBlock(node);
    default:
      // Unsupported blocks — footnote sections, definition lists, unknown
      // elements — degrade to a plain `text` of their content (§2.4;
      // footnote refs render as plain refs without a link action).
      return _degradedBlock(node);
  }
}

/// The plain-text degrade of an unsupported block (§2.4).
List<UiNode> _degradedBlock(md.Element node) {
  final text = node.textContent.trim();
  return text.isEmpty ? const [] : [UiNode(type: 'text', props: {'text': text})];
}

List<UiNode> _heading(md.Element element, {Set<String>? skills}) {
  final level = int.tryParse(element.tag.substring(1)) ?? 1;
  final spans = _spans(element.children ?? const [], skills: skills);
  // h1..h3 map to their token; h4..h6 carry the upstream small-heading run
  // inline (Jhin has no h4..h6 tokens) and h6 adds the muted foreground
  // (upstream index.css:1762-1794).
  if (level <= 3) return [_inlineNode(spans, style: 'h$level')];
  final style = <String, dynamic>{'fontSize': 14, 'fontWeight': 600};
  if (level == 6) style['color'] = r'$color.muted-foreground';
  return [_inlineNode(_styled(spans, style))];
}

List<UiNode> _paragraph(md.Element element, {Set<String>? skills}) {
  // A paragraph whose only meaningful child is one image is a standalone
  // figure (upstream `STANDALONE_IMAGE_BLOCKS`, ChatMarkdown.tsx:416-449):
  // it renders as a zoomable `image` node instead of an inline span.
  final meaningful = (element.children ?? const <md.Node>[])
      .where((child) => !(child is md.Text && child.text.trim().isEmpty))
      .toList();
  if (meaningful.length == 1 &&
      meaningful.first is md.Element &&
      (meaningful.first as md.Element).tag == 'img') {
    final image = _image(meaningful.first as md.Element);
    return image == null ? const [] : [image];
  }
  final spans = _spans(element.children ?? const [], skills: skills);
  if (spans.isEmpty) return const [];
  return [_inlineNode(spans)];
}

UiNode _codeBlock(md.Element element) {
  final code = element.children?.isNotEmpty == true ? element.children!.first : null;
  var source = code?.textContent ?? element.textContent;
  if (source.endsWith('\n')) source = source.substring(0, source.length - 1);
  // The chat code block carries the header recipe: the language label and
  // the copy action (upstream MarkdownCodeBlock, ChatMarkdown.tsx:1083-1141).
  final props = <String, dynamic>{'code': source, 'copyable': true};
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

UiNode _list(md.Element element, {Set<String>? skills}) {
  final ordered = element.tag == 'ol';
  final items = <UiNode>[];
  var number = 1;
  for (final child in element.children ?? const <md.Node>[]) {
    if (child is! md.Element || child.tag != 'li') continue;
    items.add(_listItem(child, ordered ? '$number. ' : null, skills: skills));
    number++;
  }
  return UiNode(type: 'list', props: {
    'items': [for (final item in items) item.toJson()],
  });
}

UiNode _listItem(md.Element element, String? prefix, {Set<String>? skills}) {
  // A task-list item (upstream `li.task-list-item`): the checkbox glyph
  // replaces the list marker (upstream index.css:1841-1850).
  final task = element.attributes['class']?.contains('task-list-item') == true;
  final inline = <md.Node>[];
  final nested = <md.Element>[];
  var checked = false;
  for (final child in element.children ?? const <md.Node>[]) {
    if (child is md.Element && (child.tag == 'ul' || child.tag == 'ol')) {
      nested.add(child);
    } else if (child is md.Element && child.tag == 'p') {
      // A loose list item: its paragraph content, without paragraph chrome.
      inline.addAll(child.children ?? const []);
    } else if (child is md.Element && child.tag == 'input') {
      checked = child.attributes.containsKey('checked');
    } else {
      inline.add(child);
    }
  }
  final spans = _spans(inline, skills: skills);
  String? marker = prefix;
  if (task) {
    marker = null;
    spans.insert(0, _Span(' ', style: null));
    spans.insert(0, _Span('', icon: checked ? 'check_box' : 'check_box_outline_blank', style: {
      'color': checked ? r'$color.accent' : r'$color.muted-foreground',
    }));
  }
  if (marker != null && spans.isNotEmpty) {
    spans.first = _Span('$marker${spans.first.text}',
        style: spans.first.style, action: spans.first.action, tooltip: spans.first.tooltip);
  } else if (marker != null && spans.isEmpty) {
    spans.add(_Span(marker));
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
      for (final list in nested) _list(list, skills: skills),
    ],
  );
}

UiNode _quote(md.Element element, {Set<String>? skills}) {
  final inner = _blocks(element.children ?? const [], skills: skills);
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
  final props = <String, dynamic>{'src': src, 'zoomable': true};
  if (alt != null && alt.isNotEmpty) props['semanticsLabel'] = alt;
  return UiNode(type: 'image', props: props);
}

// ---------------------------------------------------------------------------
// GitHub alerts (T104.1) — the five coloured bordered cards
// ---------------------------------------------------------------------------

/// The five GitHub alert kinds (`markdown` package: the `markdown-alert-*`
/// class on the blockquote div, the marker rule matching upstream's — the
/// `[!KIND]` marker alone on its own line) mapped onto the Jhin tokens.
/// Upstream colours (ChatMarkdown.tsx:522-557): blue (note) → `info`,
/// emerald (tip) → `success`, purple (important) → the theme `accent` (no
/// purple semantic token exists — the nearest semantic token, recorded),
/// amber (warning) → `warning`, red (caution) → `error`.
const Map<String, String> _alertToneByKind = {
  'note': r'$color.info',
  'tip': r'$color.success',
  'important': r'$color.accent',
  'warning': r'$color.warning',
  'caution': r'$color.error',
};

/// The alert glyphs (upstream lucide InfoIcon / LightbulbIcon /
/// MessageSquareWarningIcon / TriangleAlertIcon / OctagonAlertIcon,
/// ChatMarkdown.tsx:527-556, mapped onto the client icon registry).
const Map<String, String> _alertIconByKind = {
  'note': 'info',
  'tip': 'lightbulb',
  'important': 'message',
  'warning': 'warning',
  'caution': 'error',
};

/// The alert titles (upstream `label`, ChatMarkdown.tsx:527-556).
const Map<String, String> _alertLabelByKind = {
  'note': 'Note',
  'tip': 'Tip',
  'important': 'Important',
  'warning': 'Warning',
  'caution': 'Caution',
};

String? _alertKindOf(md.Element element) {
  final classes = element.attributes['class']?.split(RegExp(r'\s+')) ?? const [];
  for (final name in classes) {
    if (name.startsWith('markdown-alert-') &&
        name.length > 'markdown-alert-'.length) {
      final kind = name.substring('markdown-alert-'.length);
      if (_alertLabelByKind.containsKey(kind)) return kind;
    }
  }
  return null;
}

/// The alert callout: a bordered column (upstream `my-1 border-l-2 pl-3`
/// with the kind colour, ChatMarkdown.tsx:2941-2957; Jhin's universal
/// decoration draws the kind colour on every side at the radius token)
/// carrying the icon + coloured title and the mapped quote body.
UiNode _alertCard(String kind, md.Element element, {Set<String>? skills}) {
  final tone = _alertToneByKind[kind]!;
  final inner = <UiNode>[];
  for (final child in element.children ?? const <md.Node>[]) {
    if (child is md.Element &&
        (child.attributes['class'] ?? '').contains('markdown-alert-title')) {
      continue; // The title is re-rendered from the kind below.
    }
    inner.addAll(_block(child, skills: skills));
  }
  return UiNode(
    type: 'column',
    props: {
      'gap': r'$spacing.xs',
      'border': tone,
      'borderWidth': 1,
      'borderRadius': r'$radius.sm',
      'padding': {
        'top': r'$spacing.xs',
        'bottom': r'$spacing.xs',
        'left': r'$spacing.md',
        'right': r'$spacing.xs',
      },
    },
    children: [
      UiNode(type: 'rich_text', props: {'spans': [
        {'icon': _alertIconByKind[kind], 'style': {'color': tone}},
        {'text': ' ${_alertLabelByKind[kind]}', 'style': {'fontWeight': 600, 'color': tone}},
      ]}),
      ...inner,
    ],
  );
}

// ---------------------------------------------------------------------------
// Inline mapping
// ---------------------------------------------------------------------------

/// One mapped inline run: the span wire shape `{text, style?, action?,
/// tooltip?, icon?, chip?, image?}` of §2.6 (an image is flushed as its own
/// block node when it is a paragraph's only content).
class _Span {
  const _Span(
    this.text, {
    this.style,
    this.action,
    this.tooltip,
    this.icon,
    this.chip,
    this.image,
  });

  final String text;
  final Map<String, dynamic>? style;
  final Map<String, dynamic>? action;
  final String? tooltip;
  final String? icon;
  final Map<String, dynamic>? chip;
  final Map<String, dynamic>? image;

  bool get plain =>
      style == null &&
      action == null &&
      tooltip == null &&
      icon == null &&
      chip == null &&
      image == null;
}

/// The wire shape of one span: `{text, style?, action?, tooltip?, icon?,
/// chip?, image?}`.
Map<String, dynamic> _spanJson(_Span span) {
  final map = <String, dynamic>{'text': span.text};
  if (span.style != null) map['style'] = span.style;
  if (span.action != null) map['action'] = span.action;
  if (span.tooltip != null) map['tooltip'] = span.tooltip;
  if (span.icon != null) map['icon'] = span.icon;
  if (span.chip != null) map['chip'] = span.chip;
  if (span.image != null) map['image'] = span.image;
  return map;
}

/// Merges one style map into every span (the h4..h6 heading run).
List<_Span> _styled(List<_Span> spans, Map<String, dynamic> extra) => [
      for (final span in spans)
        _Span(span.text,
            style: span.style == null
                ? extra
                : {...span.style!, ...extra.cast<String, dynamic>()},
            action: span.action,
            tooltip: span.tooltip,
            icon: span.icon,
            chip: span.chip,
            image: span.image),
    ];

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

/// The `$skill` inline token (upstream SkillInlineText.tsx:8-9): `$` plus a
/// name containing at least one letter, bounded by whitespace or the ends,
/// matched only against the known skills.
final _skillToken =
    RegExp(r'(^|\s)\$([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)');

/// Maps inline nodes to span runs, merging `emphasis`/`strong`/`code`/
/// `del`/`link` styles and flattening unknown elements to their plain text.
/// Adjacent plain runs coalesce into one span. A `t3-citation:` link maps
/// to the inline citation chip; a known `$skill` token in plain text maps
/// to the inline skill chip; an external web link carries the leading
/// external-link icon.
List<_Span> _spans(
  List<md.Node> nodes, {
  Map<String, dynamic>? style,
  Map<String, dynamic>? action,
  String? tooltip,
  Set<String>? skills,
  bool inCode = false,
  bool inLink = false,
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
    bool inCode = false,
    bool inLink = false,
  }) {
    Map<String, dynamic>? merge(Map<String, dynamic>? extra) =>
        extra == null ? style : {...?style, ...extra};

    if (node is md.Text) {
      final text = node.text;
      if (!inCode && !inLink && skills != null && skills.isNotEmpty) {
        // The skill chips split the plain run (upstream renders the
        // surrounding text and chips as sibling children).
        var cursor = 0;
        for (final match in _skillToken.allMatches(text)) {
          final name = match.group(2) ?? '';
          if (!skills.contains(name) ||
              !RegExp(r'[a-zA-Z]').hasMatch(name)) {
            continue;
          }
          final start = match.start + (match.group(1)?.length ?? 0);
          if (start > cursor) {
            add(text.substring(cursor, start), style: style, action: action, tooltip: tooltip);
          }
          out.add(_Span('', chip: {'kind': 'skill', 'label': '\$$name'}));
          cursor = match.start + match[0]!.length;
        }
        if (cursor > 0) {
          if (cursor < text.length) {
            add(text.substring(cursor), style: style, action: action, tooltip: tooltip);
          }
          return;
        }
      }
      add(text, style: style, action: action, tooltip: tooltip);
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
              tooltip: tooltip,
              inCode: inCode,
              inLink: inLink);
        }
      case 'strong':
        for (final child in children) {
          walk(child,
              style: merge(const {'fontWeight': 700}),
              action: action,
              tooltip: tooltip,
              inCode: inCode,
              inLink: inLink);
        }
      case 'del':
        for (final child in children) {
          walk(child,
              style: merge(const {'textDecoration': 'lineThrough'}),
              action: action,
              tooltip: tooltip,
              inCode: inCode,
              inLink: inLink);
        }
      case 'code':
        add(node.textContent,
            style: merge(const {'fontFamily': r'$font.mono'}),
            action: action,
            tooltip: tooltip);
      case 'img':
        final src = node.attributes['src'];
        if (src != null && src.isNotEmpty) {
          final alt = node.attributes['alt'];
          final image = <String, dynamic>{'src': src};
          if (alt != null && alt.isNotEmpty) image['semanticsLabel'] = alt;
          out.add(_Span('', image: image));
        }
      case 'a':
        final href = node.attributes['href'] ?? '';
        if (href.startsWith('t3-citation://')) {
          // The inline citation chip (upstream AssistantCitationChip →
          // ContextChip kind="citation"): the label is the quoted text from
          // the citation payload, falling back to the link text.
          final label =
              Uri.tryParse(href)?.queryParameters['text'] ?? node.textContent;
          out.add(_Span('',
              chip: {
                'kind': 'citation',
                'label': label.trim().isEmpty ? 'Citation' : label.trim(),
              }));
          return;
        }
        final linkAction = href.isEmpty
            ? action
            : {'op': 'openUrl', 'value': href};
        if (href.startsWith('http://') || href.startsWith('https://')) {
          // The leading external-link glyph (upstream renders a favicon
          // with the globe fallback before the link text,
          // ChatMarkdown.tsx:1439-1467; Jhin pins one registry glyph).
          out.add(_Span('',
              icon: 'open_in_new',
              style: {
                'color': r'$color.info-foreground',
              }));
        }
        for (final child in children) {
          walk(child,
              style: merge(const {
                'textDecoration': 'underline',
                'color': r'$color.info-foreground',
              }),
              action: linkAction,
              tooltip: tooltip,
              inCode: inCode,
              inLink: true);
        }
      case 'sup':
        // Footnote references and other superscripts flatten to their plain
        // text, without the nested link's action (the plain-refs
        // non-feature).
        add(node.textContent, style: style, action: action, tooltip: tooltip);
      case 'br':
        add('\n', style: style, action: action, tooltip: tooltip);
      default:
        // Unknown inline elements flatten to their plain text (§2.4).
        add(node.textContent, style: style, action: action, tooltip: tooltip);
    }
  }

  for (final node in nodes) {
    walk(node,
        style: style,
        action: action,
        tooltip: tooltip,
        inCode: inCode,
        inLink: inLink);
  }
  return out;
}
