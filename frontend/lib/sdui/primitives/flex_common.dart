/// Shared parsing + building for the Flex universal prop group (docs/sdui.md
/// §2.1 Flex table), used by `row`, `column`, `flex` and the multi-child
/// `box` direction mode. Flutter 3.27+ exposes `Flex.spacing` natively (this
/// repo pins Flutter 3.47) so `spacing` is applied through the real widget
/// param; `gap` (the legacy manual-interleave prop) falls back to an
/// explicit `SizedBox` interleave when `spacing` is absent. An unknown enum
/// literal degrades to the prop's default (§2.4) — never a crash.
library;

import 'package:flutter/material.dart';

import '../ui_node.dart';

MainAxisAlignment parseMainAxisAlignment(String? value) {
  switch (value) {
    case 'end':
      return MainAxisAlignment.end;
    case 'center':
      return MainAxisAlignment.center;
    case 'spaceBetween':
      return MainAxisAlignment.spaceBetween;
    case 'spaceAround':
      return MainAxisAlignment.spaceAround;
    case 'spaceEvenly':
      return MainAxisAlignment.spaceEvenly;
    default:
      return MainAxisAlignment.start;
  }
}

CrossAxisAlignment parseCrossAxisAlignment(String? value) {
  switch (value) {
    case 'end':
      return CrossAxisAlignment.end;
    case 'center':
      return CrossAxisAlignment.center;
    case 'stretch':
      return CrossAxisAlignment.stretch;
    case 'baseline':
      return CrossAxisAlignment.baseline;
    default:
      return CrossAxisAlignment.start;
  }
}

MainAxisSize? parseMainAxisSize(String? value) {
  switch (value) {
    case 'min':
      return MainAxisSize.min;
    case 'max':
      return MainAxisSize.max;
  }
  return null;
}

TextDirection? parseTextDirection(String? value) {
  switch (value) {
    case 'ltr':
      return TextDirection.ltr;
    case 'rtl':
      return TextDirection.rtl;
  }
  return null;
}

VerticalDirection? parseVerticalDirection(String? value) {
  switch (value) {
    case 'up':
      return VerticalDirection.up;
    case 'down':
      return VerticalDirection.down;
  }
  return null;
}

TextBaseline? parseTextBaseline(String? value) {
  switch (value) {
    case 'alphabetic':
      return TextBaseline.alphabetic;
    case 'ideographic':
      return TextBaseline.ideographic;
  }
  return null;
}

/// `none/hardEdge/softEdge/antiAlias/antiAliasWithSaveLayer` → [Clip].
/// `softEdge` (a doc literal with no Flutter equivalent) degrades to
/// [Clip.antiAlias], same as the universal `clip` wrapper (§2.3 step 9).
Clip parseClipLiteral(String? value) {
  switch (value) {
    case 'hardEdge':
      return Clip.hardEdge;
    case 'softEdge':
    case 'antiAlias':
      return Clip.antiAlias;
    case 'antiAliasWithSaveLayer':
      return Clip.antiAliasWithSaveLayer;
  }
  return Clip.none;
}

/// Builds a `Flex` (Row/Column) honoring the full Flex universal group on
/// [node]: `mainAxisAlignment`, `crossAxisAlignment`, `mainAxisSize`,
/// `textDirection`, `verticalDirection`, `textBaseline`, `gap`/`spacing`,
/// `overflow`/`clipBehavior`. [children] must already be flex-aware (built
/// with `flexParent: true` so nested `flex`/`fit` apply).
///
/// `crossAxisAlignment: baseline` requires a non-null `textBaseline` in
/// Flutter (else `Flex` asserts) — this defaults it to `alphabetic` when
/// absent, so the client never crashes on server content (§2.4).
Widget buildFlex({
  required Axis direction,
  required List<Widget> children,
  required UiNode node,
}) {
  final mainAxisAlignment =
      parseMainAxisAlignment(node.stringProp('mainAxisAlignment'));
  final crossAxisAlignment =
      parseCrossAxisAlignment(node.stringProp('crossAxisAlignment'));
  final mainAxisSize =
      parseMainAxisSize(node.stringProp('mainAxisSize')) ?? MainAxisSize.max;
  final textDirection = parseTextDirection(node.stringProp('textDirection'));
  final verticalDirection =
      parseVerticalDirection(node.stringProp('verticalDirection')) ??
          VerticalDirection.down;
  var textBaseline = parseTextBaseline(node.stringProp('textBaseline'));
  if (crossAxisAlignment == CrossAxisAlignment.baseline &&
      textBaseline == null) {
    textBaseline = TextBaseline.alphabetic;
  }

  final explicitClip = node.stringProp('clipBehavior');
  final overflow = node.stringProp('overflow');
  final clipBehavior = parseClipLiteral(
      explicitClip ?? (overflow == 'clip' ? 'hardEdge' : null));

  final spacing = node.numProp('spacing')?.toDouble();
  final gap = node.numProp('gap')?.toDouble();

  var effectiveChildren = children;
  var effectiveSpacing = 0.0;
  if (spacing != null && spacing > 0) {
    effectiveSpacing = spacing;
  } else if (gap != null && gap > 0 && children.length > 1) {
    effectiveChildren = <Widget>[
      for (var i = 0; i < children.length; i++) ...[
        if (i > 0)
          direction == Axis.horizontal
              ? SizedBox(width: gap)
              : SizedBox(height: gap),
        children[i],
      ],
    ];
  }

  return Flex(
    direction: direction,
    mainAxisAlignment: mainAxisAlignment,
    crossAxisAlignment: crossAxisAlignment,
    mainAxisSize: mainAxisSize,
    textDirection: textDirection,
    verticalDirection: verticalDirection,
    textBaseline: textBaseline,
    clipBehavior: clipBehavior,
    spacing: effectiveSpacing,
    children: effectiveChildren,
  );
}
