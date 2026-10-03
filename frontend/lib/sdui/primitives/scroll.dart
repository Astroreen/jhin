import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';
import 'scroll_common.dart';

/// `scroll` (§2.6): `children` (eager) and the `items` lazy slot with
/// `itemCount` ("with `itemCount`, only visible children build"), plus
/// `scrollDirection` (`vertical`/`horizontal`, default `vertical`),
/// `reverse`, `physics` (§2.6 literals) and `shrinkWrap` (default
/// `false`). `padding` is the universal Box prop (§2.1).
///
/// Lazy mode turns on when `items` is non-empty and `itemCount` is a
/// positive int: the rows are `children` followed by the first `itemCount`
/// items, materialized on demand by `ListView.builder`. Without `itemCount`
/// everything is built eagerly in a `SingleChildScrollView` (the
/// documented "eager children" mode). `controller`-by-id is accepted and
/// ignored for now (deferred — see the T59 commit notes).
Widget buildScroll(BuildContext context, UiNode node, RenderContext ctx) {
  final rawItems = node.listProp('items');
  final items = rawItems == null
      ? const <UiNode>[]
      : [for (final item in rawItems) UiNode.fromJson(item)];
  final direction =
      node.stringProp('scrollDirection') == 'horizontal' ? Axis.horizontal : Axis.vertical;
  final reverse = node.boolProp('reverse') ?? false;
  final physics = parseScrollPhysics(node.stringProp('physics'));

  final itemCount = node.numProp('itemCount')?.round();
  if (items.isNotEmpty && itemCount != null && itemCount > 0) {
    final rows = <UiNode>[...node.children, ...items.take(itemCount)];
    return buildAdaptiveScroller(
      scrollDirection: direction,
      shrinkWrap: node.boolProp('shrinkWrap') ?? false,
      scroller: (shrinkWrap) => ListView.builder(
        scrollDirection: direction,
        reverse: reverse,
        physics: physics,
        shrinkWrap: shrinkWrap,
        itemCount: rows.length,
        itemBuilder: (context, index) => ctx.build(context, rows[index]),
      ),
    );
  }

  final children = <Widget>[
    ...buildChildren(context, node, ctx, flexAware: true),
    ...buildNodeList(context, ctx, rawItems),
  ];
  if (children.isEmpty) {
    return degradedBox(context, 'Missing children');
  }
  final content = direction == Axis.horizontal
      ? Row(mainAxisSize: MainAxisSize.min, children: children)
      : Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: children,
        );
  return SingleChildScrollView(
    scrollDirection: direction,
    reverse: reverse,
    physics: physics,
    child: content,
  );
}
