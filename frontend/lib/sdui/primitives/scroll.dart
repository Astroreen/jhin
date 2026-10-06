import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';
import 'scroll_common.dart';

/// The chat timeline anchor offset (T100): the upstream
/// `CHAT_TIMELINE_ANCHOR_OFFSET` (t3code commit 37de6cb,
/// `apps/web/src/components/chat/timelineScrollAnchoring.ts:39`) — 24 px,
/// "match[ing] the titlebar fade inset so draft promotion preserves the
/// first row's position". The plan's prose said 36 px; the checkout wins
/// (plan risk 5) and the verified value is 24. The live tail reserves it
/// as the end-of-timeline inset so the newest row never hugs the composer
/// seam, and the following-end tolerance reads it.
const double kChatTimelineAnchorOffset = 24.0;

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
