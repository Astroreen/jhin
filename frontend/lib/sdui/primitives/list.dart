import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';
import 'scroll_common.dart';

/// `list` (§2.6): `items` (node or string array — strings are the `text`
/// shorthand), `maxHeight`, `separator`, `itemExtent`, `prototypeItem`.
/// Built as a lazy `ListView.builder`/`ListView.separated`: only visible
/// rows materialize (the T59 lazy upgrade). `sections`/`onReorder`/
/// `selection`/`empty` are the T63 list-v2 scope and are not read here.
///
/// `maxHeight` bounds the viewport; without it the list fills its bounded
/// slot, and in an unbounded parent it degrades to a content-sized
/// shrink-wrap scroller (`scroll_common.dart`) instead of asserting.
/// `itemExtent`/`prototypeItem` fix the row extent on the builder path;
/// with a `separator` the rows are laid out by `ListView.separated`, which
/// has no extent inference — those two props are ignored there (§2.4).
/// Missing or empty `items` degrades to a visible placeholder.
Widget buildList(BuildContext context, UiNode node, RenderContext ctx) {
  final rawItems = node.listProp('items');
  if (rawItems == null || rawItems.isEmpty) {
    return degradedBox(context, 'Missing items');
  }
  final items = [for (final item in rawItems) UiNode.fromJson(item)];
  final separator = node.props['separator'];
  final itemExtent = node.numProp('itemExtent')?.toDouble();
  final prototype = separator == null && node.props['prototypeItem'] != null
      ? buildChildProp(context, ctx, node.props['prototypeItem'])
      : null;
  final scroller = buildAdaptiveScroller(
    scrollDirection: Axis.vertical,
    shrinkWrap: false,
    scroller: (shrinkWrap) {
      if (separator != null) {
        final separatorNode = UiNode.fromJson(separator);
        return ListView.separated(
          shrinkWrap: shrinkWrap,
          itemCount: items.length,
          itemBuilder: (context, index) => ctx.build(context, items[index]),
          separatorBuilder: (context, index) => ctx.build(context, separatorNode),
        );
      }
      return ListView.builder(
        shrinkWrap: shrinkWrap,
        itemExtent: itemExtent != null && itemExtent > 0 ? itemExtent : null,
        prototypeItem: prototype,
        itemCount: items.length,
        itemBuilder: (context, index) => ctx.build(context, items[index]),
      );
    },
  );
  final maxHeight = node.numProp('maxHeight')?.toDouble();
  if (maxHeight == null || maxHeight < 0) return scroller;
  return ConstrainedBox(
    constraints: BoxConstraints(maxHeight: maxHeight),
    child: scroller,
  );
}
