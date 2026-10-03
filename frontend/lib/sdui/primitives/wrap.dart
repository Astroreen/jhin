import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';
import 'flex_common.dart';

/// `wrap` (§2.6): `children`, `direction`
/// (`horizontal`/`vertical`, default `horizontal`), `alignment` and
/// `runAlignment` (wrap alignment literals, default `start`), `spacing`,
/// `runSpacing`, `crossAxisAlignment` (wrap alignment literals, default
/// `start`), `textDirection` and `verticalDirection` (default `down`).
///
/// `direction`/`alignment`/`runAlignment`/`crossAxisAlignment` carry wrap's
/// own literal sets (§2.6), not the Flex ones, and `alignment` is wrap's
/// own prop — the registry skips the universal `align` alias for this type.
/// An unknown enum literal degrades to the prop's default (§2.4) — never a
/// crash.
Widget buildWrap(BuildContext context, UiNode node, RenderContext ctx) {
  if (node.children.isEmpty) {
    return degradedBox(context, 'Missing children');
  }
  return Wrap(
    direction:
        node.stringProp('direction') == 'vertical' ? Axis.vertical : Axis.horizontal,
    alignment: _wrapAlignment(node.stringProp('alignment')),
    spacing: node.numProp('spacing')?.toDouble() ?? 0,
    runSpacing: node.numProp('runSpacing')?.toDouble() ?? 0,
    runAlignment: _wrapAlignment(node.stringProp('runAlignment')),
    crossAxisAlignment: _wrapCrossAlignment(node.stringProp('crossAxisAlignment')),
    textDirection: parseTextDirection(node.stringProp('textDirection')),
    verticalDirection:
        parseVerticalDirection(node.stringProp('verticalDirection')) ??
            VerticalDirection.down,
    children: buildChildren(context, node, ctx),
  );
}

/// Wrap alignment literals (§2.6): `start` (default) / `center` / `end` /
/// `spaceBetween` / `spaceAround` / `spaceEvenly`.
WrapAlignment _wrapAlignment(String? value) {
  switch (value) {
    case 'center':
      return WrapAlignment.center;
    case 'end':
      return WrapAlignment.end;
    case 'spaceBetween':
      return WrapAlignment.spaceBetween;
    case 'spaceAround':
      return WrapAlignment.spaceAround;
    case 'spaceEvenly':
      return WrapAlignment.spaceEvenly;
  }
  return WrapAlignment.start;
}

/// `crossAxisAlignment` (§2.6) accepts the full wrap alignment literal set;
/// Flutter's `WrapCrossAlignment` only has `start`/`center`/`end`, so the
/// three `space*` literals degrade to `start` (the prop's default, §2.4).
WrapCrossAlignment _wrapCrossAlignment(String? value) {
  switch (value) {
    case 'center':
      return WrapCrossAlignment.center;
    case 'end':
      return WrapCrossAlignment.end;
  }
  return WrapCrossAlignment.start;
}
