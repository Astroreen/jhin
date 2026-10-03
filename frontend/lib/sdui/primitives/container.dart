import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `container` (§8.3): `children`, `direction: row|column`, `padding?`,
/// `gap?`, `align?`, `scroll?`.
///
/// Children with a `flex` are wrapped in `Expanded` (§8.3 universal
/// fields). In a horizontal row, field primitives that need a bounded width
/// ([_boundedInRow]) are also wrapped in `Expanded` so they fill the
/// remaining space instead of throwing a layout assertion. With no children
/// the node degrades to a visible placeholder.
Widget buildContainer(BuildContext context, UiNode node, RenderContext ctx) {
  if (node.children.isEmpty) {
    return degradedBox(context, 'Missing children');
  }
  final direction = node.stringProp('direction') == 'row'
      ? Axis.horizontal
      : Axis.vertical;
  final children = buildChildren(
    context,
    node,
    ctx,
    flexAware: true,
    expandTypes: direction == Axis.horizontal ? _boundedInRow : null,
  );
  final gap = node.numProp('gap')?.toDouble();
  final spaced = gap == null || gap <= 0
      ? children
      : <Widget>[
          for (var i = 0; i < children.length; i++) ...[
            if (i > 0)
              direction == Axis.horizontal
                  ? SizedBox(width: gap)
                  : SizedBox(height: gap),
            children[i],
          ],
        ];
  Widget result = direction == Axis.horizontal
      ? Row(
          mainAxisAlignment: _mainAlign(node.stringProp('align')),
          crossAxisAlignment: _crossAlign(node.stringProp('align')),
          children: spaced,
        )
      : Column(
          mainAxisAlignment: _mainAlign(node.stringProp('align')),
          crossAxisAlignment: _crossAlign(node.stringProp('align')),
          mainAxisSize: MainAxisSize.min,
          children: spaced,
        );
  if (node.boolProp('scroll') == true) {
    result = SingleChildScrollView(child: result);
  }
  return result;
}

/// Field primitives that build an `InputDecorator` and therefore require a
/// bounded width. A `Row` gives non-flex children unbounded main-axis
/// constraints, so these are wrapped in `Expanded` in a horizontal
/// container.
const Set<String> _boundedInRow = {'input', 'dropdown'};

MainAxisAlignment _mainAlign(String? align) {
  switch (align) {
    case 'start':
      return MainAxisAlignment.start;
    case 'end':
      return MainAxisAlignment.end;
    case 'center':
      return MainAxisAlignment.center;
    case 'spaceBetween':
      return MainAxisAlignment.spaceBetween;
  }
  return MainAxisAlignment.start;
}

CrossAxisAlignment _crossAlign(String? align) {
  switch (align) {
    case 'center':
      return CrossAxisAlignment.center;
    case 'end':
      return CrossAxisAlignment.end;
    case 'stretch':
      return CrossAxisAlignment.stretch;
  }
  return CrossAxisAlignment.start;
}
