import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../../design/tokens.dart';
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
///
/// T87: the container carrying the reserved composer surface id
/// ([kComposerSurfaceId]) is the composer surface — it carries the
/// upstream `--shadow-composer` elevation (index.css:193-194,
/// ComposerSurface.tsx:51) and the bottom safe-area inset (`pb-safe`,
/// index.css:1034-1036). Inside a `SafeArea` the inset already reads 0, so
/// the helper never double-counts; the shell (T96) drops the blanket
/// `SafeArea` and the composer picks the real inset up.
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
  if (node.id == kComposerSurfaceId) {
    result = _composerSurface(context, result);
  }
  return result;
}

/// The composer surface (T87): the `--shadow-composer` elevation over the
/// upstream `rounded-3xl` radius (ComposerSurface.tsx:51 — the §4.3 `xl3`
/// step) and the bottom safe-area inset outside the shadow box.
Widget _composerSurface(BuildContext context, Widget child) {
  final design = JhinDesignScope.of(context);
  final brightness = Theme.brightnessOf(context);
  final shadow = jhinComposerShadow(design.tokens.surface, brightness);
  Widget surface = DecoratedBox(
    decoration: BoxDecoration(
      borderRadius: jhinSurfaceRadius(
        design.tokens.surface,
        'xl3',
        remPx: design.switches.fontSizes.sizeInterface.toDouble(),
      ),
      boxShadow: shadow == null ? null : [shadow],
    ),
    child: child,
  );
  return Padding(
    padding: jhinSafeAreaPadding(context, bottom: true),
    child: surface,
  );
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
