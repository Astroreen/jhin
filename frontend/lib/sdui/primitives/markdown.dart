import 'package:flutter/material.dart';

import '../../design/markdown_render.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `markdown` (§2.6): `text` (markdown source, required) plus the accepted
/// `codeBlockStyle` and `syntax` fences styling hints and the T104
/// `skills` list (the known `$skill` names — a known token renders the
/// inline skill chip).
///
/// Parsing and the block-to-primitive mapping live in
/// `design/markdown_render.dart`; this primitive just maps the tree and
/// builds it through the registry pipeline. The legacy level-1 text props
/// (`style`, `bold`, `italic`, `color`) style every mapped block that has
/// no style of its own (§2.1). A missing `text` prop degrades to a visible
/// placeholder (§2.4).
Widget buildMarkdown(BuildContext context, UiNode node, RenderContext ctx) {
  final text = node.stringProp('text');
  if (text == null) {
    return degradedBox(context, 'Missing text');
  }
  final legacy = <String, dynamic>{};
  final style = node.stringProp('style');
  if (style != null) legacy['style'] = style;
  if (node.boolProp('bold') == true) legacy['bold'] = true;
  if (node.boolProp('italic') == true) legacy['italic'] = true;
  final color = node.props['color'];
  if (color != null) legacy['color'] = color;
  final skills = <String>[
    for (final skill in node.listProp('skills') ?? const <Object?>[])
      if (skill is String && skill.isNotEmpty) skill,
  ];
  var tree = markdownToNode(text, skills: skills.isEmpty ? null : skills.toSet());
  if (node.boolProp('syntax') == true) {
    tree = _stampSyntax(tree);
  }
  if (legacy.isNotEmpty) {
    tree = _inherit(tree, legacy);
  }
  return ctx.build(context, tree);
}

/// Stamps `syntax: true` onto every mapped `code_block` (§2.6 — the `syntax`
/// hint colours the fences).
UiNode _stampSyntax(UiNode node) {
  final props = Map<String, dynamic>.from(node.props);
  if (node.type == 'code_block') props['syntax'] = true;
  final items = node.listProp('items');
  if (items != null) {
    props['items'] = [
      for (final item in items)
        item is Map ? _stampSyntax(UiNode.fromJson(item)).toJson() : item,
    ];
  }
  return UiNode(
    type: node.type,
    props: props,
    children: [for (final child in node.children) _stampSyntax(child)],
  );
}

/// Copies the legacy level-1 text props onto every mapped `text`/`rich_text`
/// block that does not set them itself (§2.1), recursively through
/// `children` and `list` items.
UiNode _inherit(UiNode node, Map<String, dynamic> legacy) {
  final props = Map<String, dynamic>.from(node.props);
  if (node.type == 'text' || node.type == 'rich_text') {
    for (final key in const ['style', 'bold', 'italic', 'color']) {
      if (legacy.containsKey(key)) props.putIfAbsent(key, () => legacy[key]!);
    }
  }
  final items = node.listProp('items');
  if (items != null) {
    props['items'] = [
      for (final item in items)
        item is Map ? _inherit(UiNode.fromJson(item), legacy).toJson() : item,
    ];
  }
  return UiNode(
    type: node.type,
    props: props,
    children: [for (final child in node.children) _inherit(child, legacy)],
  );
}
