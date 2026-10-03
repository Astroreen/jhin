import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';
import 'flex_common.dart';

/// `stack` (§2.6): `children` (layered; `positioned` children allowed),
/// `alignment` (alignment of the non-positioned children, default
/// `topLeft`), `fit` (`loose`/`passthrough`/`expand`, default `loose`),
/// `clipBehavior` (clip literals, default `hardEdge`) and `textDirection`
/// (`ltr`/`rtl`).
///
/// `alignment` is stack's own prop (§2.6), not the universal `align` alias
/// — the registry skips the alias for this type. Every child is built with
/// `stackParent: true`, so a `positioned` child becomes a real [Positioned]
/// around its universal wrapping (§2.3); a `positioned` without a `stack`
/// parent degrades to `align` (§2.4). An unknown enum literal degrades to
/// the prop's default — never a crash.
Widget buildStack(BuildContext context, UiNode node, RenderContext ctx) {
  if (node.children.isEmpty) {
    return degradedBox(context, 'Missing children');
  }
  return Stack(
    alignment:
        parseAlignmentLiteral(node.props['alignment']) ?? Alignment.topLeft,
    fit: _stackFit(node.stringProp('fit')),
    clipBehavior: _stackClip(node.stringProp('clipBehavior')),
    textDirection: parseTextDirection(node.stringProp('textDirection')),
    children: [
      for (final child in node.children) ctx.build(context, child, stackParent: true),
    ],
  );
}

/// `fit` (§2.6): `loose` (default) / `passthrough` / `expand`. An unknown
/// literal degrades to the default (§2.4).
StackFit _stackFit(String? value) {
  switch (value) {
    case 'passthrough':
      return StackFit.passthrough;
    case 'expand':
      return StackFit.expand;
  }
  return StackFit.loose;
}

/// `clipBehavior` (§2.6): the clip literal set with `hardEdge` as the
/// documented default. `softEdge` (a doc literal with no Flutter
/// equivalent) maps to [Clip.antiAlias], and an unknown literal degrades to
/// the default (§2.4).
Clip _stackClip(String? value) {
  switch (value) {
    case 'none':
      return Clip.none;
    case 'hardEdge':
      return Clip.hardEdge;
    case 'softEdge':
    case 'antiAlias':
      return Clip.antiAlias;
    case 'antiAliasWithSaveLayer':
      return Clip.antiAliasWithSaveLayer;
  }
  return Clip.hardEdge;
}
