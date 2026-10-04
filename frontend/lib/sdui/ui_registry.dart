import 'package:flutter/material.dart';

import '../design/icon_registry.dart';
import '../design/theme.dart';
import '../design/tokens.dart';
import 'expr.dart';
import 'primitives/align_primitive.dart';
import 'primitives/aspect_ratio_primitive.dart';
import 'primitives/box.dart';
import 'primitives/button.dart';
import 'primitives/card.dart';
import 'primitives/center_primitive.dart';
import 'primitives/chart_bar.dart';
import 'primitives/chart_line.dart';
import 'primitives/chart_pie.dart';
import 'primitives/checkbox.dart';
import 'primitives/code_block.dart';
import 'primitives/column.dart';
import 'primitives/container.dart';
import 'primitives/divider.dart';
import 'primitives/drawer.dart';
import 'primitives/dropdown.dart';
import 'primitives/expanded.dart';
import 'primitives/figure.dart';
import 'primitives/flex.dart';
import 'primitives/flexible.dart';
import 'primitives/form.dart';
import 'primitives/grid.dart';
import 'primitives/icon.dart';
import 'primitives/icon_button.dart';
import 'primitives/image.dart';
import 'primitives/input.dart';
import 'primitives/list.dart';
import 'primitives/markdown.dart';
import 'primitives/nav.dart';
import 'primitives/positioned.dart';
import 'primitives/progress.dart';
import 'primitives/rich_text.dart';
import 'primitives/row.dart';
import 'primitives/screen.dart';
import 'primitives/scroll.dart';
import 'primitives/sized_box.dart';
import 'primitives/slider.dart';
import 'primitives/spacer.dart';
import 'primitives/stack.dart';
import 'primitives/stream_view.dart';
import 'primitives/switch.dart';
import 'primitives/table.dart';
import 'primitives/text.dart';
import 'primitives/wrap.dart';
import 'render_context.dart';
import 'ui_node.dart';
import 'ui_state.dart';

/// Maps a node `type` to its widget builder (§8.3).
///
/// [build] wraps every node with the universal semantics: `when` / `visible`
/// hiding, `${…}` interpolation of string props, `$token` resolution
/// (§2.2), the universal prop surface in the fixed wrapping order of §2.3,
/// and per-node error isolation — one bad node never kills the screen. An
/// unknown type renders the muted `Unsupported UI element: <type>` card and
/// never throws.
class UiRegistry {
  UiRegistry([Map<String, UiBuilder>? builders]) : _builders = {...?builders};

  /// The fixed 25-primitive catalog (D-10); the builders live in
  /// `primitives/`.
  factory UiRegistry.standard() {
    final registry = UiRegistry();
    registry._builders.addAll({
      'screen': buildScreen,
      'nav': buildNav,
      'container': buildContainer,
      'card': buildCard,
      'text': buildText,
      'markdown': buildMarkdown,
      'rich_text': buildRichText,
      'code_block': buildCodeBlock,
      'button': buildButton,
      'input': buildInput,
      'dropdown': buildDropdown,
      'checkbox': buildCheckbox,
      'switch': buildSwitch,
      'slider': buildSlider,
      'form': buildForm,
      'list': buildList,
      'stream_view': buildStreamView,
      'table': buildTable,
      'divider': buildDivider,
      'spacer': buildSpacer,
      'progress': buildProgress,
      'image': buildImage,
      'figure': buildFigure,
      'chart_line': buildChartLine,
      'chart_bar': buildChartBar,
      'chart_pie': buildChartPie,
      'drawer': buildDrawer,
      'box': buildBox,
      'row': buildRow,
      'column': buildColumn,
      'flex': buildFlexPrimitive,
      'expanded': buildExpanded,
      'flexible': buildFlexible,
      'sized_box': buildSizedBox,
      'align': buildAlignPrimitive,
      'center': buildCenterPrimitive,
      'aspect_ratio': buildAspectRatioPrimitive,
      'stack': buildStack,
      'positioned': buildPositioned,
      'wrap': buildWrap,
      'grid': buildGrid,
      'scroll': buildScroll,
      'icon': buildIcon,
      'icon_button': buildIconButton,
    });
    return registry;
  }

  final Map<String, UiBuilder> _builders;

  /// Registers (or overrides) one builder.
  void register(String type, UiBuilder builder) => _builders[type] = builder;

  /// Builds one node. Applies the universal fields, then the type builder,
  /// isolating any failure to this node.
  ///
  /// [flexParent] marks the node as a direct child of a `Flex` (row,
  /// column, …): only then are `flex`/`fit` honored (§2.3 step 14) —
  /// Flutter requires flex children to be direct children of a Flex, and
  /// the client never crashes on server content, so a `flex` elsewhere
  /// degrades silently.
  ///
  /// [stackParent] marks the node as a direct child of a `stack`: only
  /// then does a `positioned` node wrap in [Positioned] (§2.6) — Flutter
  /// requires parent-data widgets to be direct children of their Stack.
  /// A `positioned` elsewhere degrades to `align` (§2.4).
  Widget build(
    BuildContext context,
    UiNode node,
    RenderContext ctx, {
    bool flexParent = false,
    bool stackParent = false,
  }) {
    if (node.isUnsupported) {
      return _unsupportedCard(context, node.type, node.error);
    }
    if (node.boolProp('visible') == false) {
      return const SizedBox.shrink();
    }
    final when = node.when;
    if (when != null && evalWhen(when, ctx.state) == false) {
      return const SizedBox.shrink();
    }
    final builder = _builders[node.type];
    if (builder == null) {
      return _unsupportedCard(context, node.type, null);
    }
    final design = JhinDesignScope.of(context);
    var prepared = _interpolateNode(node, ctx);
    prepared = _resolveNodeTokens(prepared, design.tokens);
    Widget result;
    try {
      result = builder(context, prepared, ctx);
    } catch (error) {
      debugPrint('Jhin SDUI: failed to render "${node.type}": $error');
      return _unsupportedCard(context, node.type, '$error');
    }
    result = _applyUniversal(
      context,
      prepared,
      result,
      design,
      ctx,
      flexParent: flexParent,
    );
    return _applyPositionedWrap(result, prepared, stackParent: stackParent);
  }

  /// The §2.6 `positioned` wrap: under a `stack` parent ([stackParent]) the
  /// node becomes a [Positioned] around its whole universal wrapping —
  /// outermost, since Flutter requires the parent-data widget to be the
  /// direct child of its Stack (margin and friends stay inside it, mirroring
  /// the flex wrap of §2.3 step 14). Without a `stack` parent the node
  /// degrades to `align` (§2.4): the child renders centered — never a
  /// crash.
  static Widget _applyPositionedWrap(
    Widget result,
    UiNode node, {
    required bool stackParent,
  }) {
    if (node.type != 'positioned') return result;
    if (!stackParent) return Align(child: result);
    return Positioned(
      top: node.numProp('top')?.toDouble(),
      right: node.numProp('right')?.toDouble(),
      bottom: node.numProp('bottom')?.toDouble(),
      left: node.numProp('left')?.toDouble(),
      width: node.numProp('width')?.toDouble(),
      height: node.numProp('height')?.toDouble(),
      child: result,
    );
  }

  /// The universal prop surface (§2.1), applied in the fixed wrapping order
  /// of §2.3: text style → DecoratedBox → Padding(padding) →
  /// ConstrainedBox → AspectRatio → Opacity → Transform → Clip → Align →
  /// Tooltip → gesture → Focus → Semantics → MouseRegion →
  /// Flexible/Expanded → Padding(margin) (the §2.3 note fixes `MouseRegion`
  /// outermost of the interaction cluster and `Focus` between the gesture
  /// wrapper and `Semantics`).
  ///
  /// Deterministic and tested; every step degrades silently on malformed
  /// props (§2.4).
  static Widget _applyUniversal(
    BuildContext context,
    UiNode node,
    Widget primitive,
    JhinTheme design,
    RenderContext ctx, {
    required bool flexParent,
  }) {
    final tokens = design.tokens;
    var result = primitive;

    // 2. text style (text-bearing nodes).
    final styling = _textStyling(node);
    result = _applyTextStyle(result, styling);
    // Whether `color` is the legacy text color and `height` the line-height
    // multiple (§2.1 Text group) instead of the Box-group background color
    // and box constraint: only text-bearing primitives (`text`, `markdown`,
    // `rich_text`) qualify — a `box`/`container` whose built widget is a
    // bare `Text` child passthrough still paints `color` as its own
    // background, and `code_block` paints `color` as the code box
    // background.
    final textBearing = node.type == 'text' ||
        node.type == 'markdown' ||
        node.type == 'rich_text';
    // `color` is the icon color on `icon`/`icon_button` (§2.6) — consumed by
    // the primitive, not painted as a background (the same rule as the text
    // color on text-bearing nodes).
    final colorBearing =
        textBearing || node.type == 'icon' || node.type == 'icon_button';

    // 3. DecoratedBox (color/gradient/border/borderRadius/shadow).
    final decoration = _decoration(node, colorConsumed: colorBearing);
    if (decoration != null) {
      result = DecoratedBox(decoration: decoration, child: result);
    }

    // 4. Padding (padding). `icon_button` owns its `padding` key (§2.6 —
    // the IconButton padding around the icon), so the universal wrap skips
    // it there.
    if (node.type != 'icon_button') {
      final padding = parsePadding(node.props['padding'], tokens: tokens);
      if (padding != null) {
        result = Padding(padding: padding, child: result);
      }
    }

    // 5. ConstrainedBox (min/max/w/h). On a text-bearing node `height` is
    // the line-height multiple (consumed by the text style above), not a
    // box constraint.
    final constraints = _constraints(node, textBearing: textBearing);
    if (constraints != null) {
      result = ConstrainedBox(constraints: constraints, child: result);
    }

    // 6. AspectRatio.
    final ratio = node.numProp('aspectRatio');
    if (ratio != null && ratio > 0) {
      result = AspectRatio(aspectRatio: ratio.toDouble(), child: result);
    }

    // 7. Opacity.
    final opacity = node.numProp('opacity');
    if (opacity != null && opacity != 1) {
      result = Opacity(
        opacity: opacity.toDouble().clamp(0.0, 1.0),
        child: result,
      );
    }

    // 8. Transform.
    final transform = _transform(node.props['transform']);
    if (transform != null) {
      result = Transform(transform: transform, child: result);
    }

    // 9. Clip.
    result = _applyClip(result, node, tokens);

    // 10. Align (`alignment` is accepted as an alias — except on the
    // primitives whose §2.6 `alignment` is their own layout prop).
    final alignment =
        _alignment(node.props['align'] ?? _alignmentAlias(node));

    if (alignment != null) {
      result = Align(alignment: alignment, child: result);
    }

    // 11. Tooltip.
    final tooltip = node.stringProp('tooltip');
    if (tooltip != null && tooltip.isNotEmpty) {
      result = Tooltip(message: tooltip, child: result);
    }

    // 12. gesture wrapper.
    result = _applyGesture(context, node, result, ctx);

    // 12b. Focus (focusable) — between the gesture wrapper and Semantics
    // (the §2.3 note).
    result = _applyFocus(result, node);

    // 13. Semantics.
    result = _applySemantics(result, node);

    // 13b. MouseRegion (cursor) — the outermost wrapper of the interaction
    // cluster (the §2.3 note).
    result = _applyCursor(result, node);

    // 14 + 15. Flexible/Expanded (flex/fit) and Padding(margin).
    result = _applyFlexAndMargin(
      result,
      node,
      tokens: tokens,
      flexParent: flexParent,
    );
    return result;
  }

  static UiNode _interpolateNode(UiNode node, RenderContext ctx) {
    final props = <String, dynamic>{};
    node.props.forEach((key, value) {
      props[key] = _interpolationExempt.contains(key)
          ? value
          : _interpolateValue(value, ctx.state);
    });
    return UiNode(type: node.type, props: props, children: node.children);
  }

  static Object? _interpolateValue(Object? value, UiState state) {
    if (value is String) return interpolate(value, state);
    if (value is Map) {
      final out = <String, dynamic>{};
      value.forEach((key, item) {
        out['$key'] = _interpolationExempt.contains('$key')
            ? item
            : _interpolateValue(item, state);
      });
      return out;
    }
    if (value is List) {
      return [for (final item in value) _interpolateValue(item, state)];
    }
    return value;
  }

  static const Set<String> _interpolationExempt = {'id', 'when', 'pattern'};
}

// ---------------------------------------------------------------------------
// $token resolution (§2.2)
// ---------------------------------------------------------------------------

/// Props whose string value is content, not a token reference: a leading
/// `$` in a text/label/title is literal content (a price, a mention), and
/// resolving it could only degrade the node. Structural props resolve.
const Set<String> _tokenExempt = {
  'id',
  'when',
  'pattern',
  'text',
  'label',
  'title',
  'subtitle',
  'message',
  'placeholder',
  'hint',
};

/// Resolves `$token` string props client-side (§2.2): `$spacing.md` → 12,
/// `$color.accent` → the palette color, … An unknown or failed lookup keeps
/// the literal string and the node still renders — never throws.
UiNode _resolveNodeTokens(UiNode node, JhinTokens tokens) {
  final props = <String, dynamic>{};
  node.props.forEach((key, value) {
    props[key] =
        _tokenExempt.contains(key) ? value : _resolveTokenValue(value, tokens);
  });
  return UiNode(type: node.type, props: props, children: node.children);
}

Object? _resolveTokenValue(Object? value, JhinTokens tokens) {
  if (value is String) {
    if (!value.startsWith('\$')) return value;
    return tokens.resolveToken(value) ?? value;
  }
  if (value is Map) {
    return {
      for (final entry in value.entries)
        entry.key: _tokenExempt.contains('${entry.key}')
            ? entry.value
            : _resolveTokenValue(entry.value, tokens),
    };
  }
  if (value is List) {
    return [for (final item in value) _resolveTokenValue(item, tokens)];
  }
  return value;
}

// ---------------------------------------------------------------------------
// Universal prop application (§2.1 / §2.3)
// ---------------------------------------------------------------------------

/// Text-style props of one node (§2.1 Text group), or null when none is
/// set.
class _TextStyling {
  const _TextStyling({
    this.style,
    this.textAlign,
    this.overflow,
    this.maxLines,
    this.softWrap,
  });

  final TextStyle? style;
  final TextAlign? textAlign;
  final TextOverflow? overflow;
  final int? maxLines;
  final bool? softWrap;
}

_TextStyling? _textStyling(UiNode node) {
  final style = _textStyle(node);
  // `overflow` is the accepted alias of `textOverflow` on text-bearing
  // primitives (§2.1); on flex nodes the same key is the child overflow.
  final textBearing =
      node.type == 'text' || node.type == 'markdown' || node.type == 'rich_text';
  final overflow = _textOverflow(node.stringProp('textOverflow')) ??
      (textBearing ? _textOverflow(node.stringProp('overflow')) : null) ??
      (node.boolProp('ellipsis') == true ? TextOverflow.ellipsis : null);
  final textAlign = _textAlign(node.stringProp('textAlign'));
  final maxLines = node.numProp('maxLines')?.round();
  final softWrap = node.boolProp('softWrap');
  if (style == null &&
      overflow == null &&
      textAlign == null &&
      maxLines == null &&
      softWrap == null) {
    return null;
  }
  return _TextStyling(
    style: style,
    textAlign: textAlign,
    overflow: overflow,
    maxLines: maxLines,
    softWrap: softWrap,
  );
}

TextStyle? _textStyle(UiNode node) {
  final fontFamily = node.stringProp('fontFamily');
  final fontSize = node.numProp('fontSize')?.toDouble();
  final fontWeight = _fontWeight(node.props['fontWeight']);
  final fontStyle = _fontStyle(node.stringProp('fontStyle'));
  final letterSpacing = node.numProp('letterSpacing')?.toDouble();
  final wordSpacing = node.numProp('wordSpacing')?.toDouble();
  final height = node.numProp('height')?.toDouble();
  final decoration = _textDecoration(node.stringProp('textDecoration'));
  if (fontFamily == null &&
      fontSize == null &&
      fontWeight == null &&
      fontStyle == null &&
      letterSpacing == null &&
      wordSpacing == null &&
      height == null &&
      decoration == null) {
    return null;
  }
  return TextStyle(
    fontFamily: fontFamily,
    fontSize: fontSize,
    fontWeight: fontWeight,
    fontStyle: fontStyle,
    letterSpacing: letterSpacing,
    wordSpacing: wordSpacing,
    height: height,
    decoration: decoration,
  );
}

/// `fontWeight` 100–900 (§2.1); anything else degrades to null.
FontWeight? _fontWeight(Object? value) {
  if (value is! num || value < 100 || value > 900) return null;
  final index = ((value - 100) / 100).round().clamp(0, FontWeight.values.length - 1);
  return FontWeight.values[index];
}

FontStyle? _fontStyle(String? value) {
  switch (value) {
    case 'normal':
      return FontStyle.normal;
    case 'italic':
      return FontStyle.italic;
  }
  return null;
}

TextDecoration? _textDecoration(String? value) {
  switch (value) {
    case 'none':
      return TextDecoration.none;
    case 'underline':
      return TextDecoration.underline;
    case 'overline':
      return TextDecoration.overline;
    case 'lineThrough':
      return TextDecoration.lineThrough;
  }
  return null;
}

TextAlign? _textAlign(String? value) {
  switch (value) {
    case 'left':
      return TextAlign.left;
    case 'right':
      return TextAlign.right;
    case 'center':
      return TextAlign.center;
    case 'justify':
      return TextAlign.justify;
    case 'start':
      return TextAlign.start;
    case 'end':
      return TextAlign.end;
  }
  return null;
}

TextOverflow? _textOverflow(String? value) {
  switch (value) {
    case 'clip':
      return TextOverflow.clip;
    case 'fade':
      return TextOverflow.fade;
    case 'ellipsis':
      return TextOverflow.ellipsis;
    case 'visible':
      return TextOverflow.visible;
  }
  return null;
}

/// Applies the text style (§2.3 step 2): on a [Text] the style is merged
/// into the widget (the universal props win over the primitive's named
/// style); on any other widget the style becomes the ambient
/// [DefaultTextStyle] for text descendants. Every other [Text] parameter —
/// `strutStyle`, `locale`, `textWidthBasis`, `selectionColor`, the
/// `Text.rich` spans of `rich_text`, … — is preserved across the rebuild.
Widget _applyTextStyle(Widget widget, _TextStyling? styling) {
  if (styling == null) return widget;
  if (widget is Text && (widget.data != null || widget.textSpan != null)) {
    final style = widget.style == null
        ? styling.style
        : widget.style!.merge(styling.style);
    final textAlign = styling.textAlign ?? widget.textAlign;
    final softWrap = styling.softWrap ?? widget.softWrap;
    final maxLines = styling.maxLines ?? widget.maxLines;
    final overflow = styling.overflow ?? widget.overflow;
    if (widget.textSpan != null) {
      return Text.rich(
        widget.textSpan!,
        style: style,
        textAlign: textAlign,
        softWrap: softWrap,
        maxLines: maxLines,
        overflow: overflow,
        strutStyle: widget.strutStyle,
        textDirection: widget.textDirection,
        locale: widget.locale,
        textScaler: widget.textScaler,
        semanticsLabel: widget.semanticsLabel,
        textWidthBasis: widget.textWidthBasis,
        textHeightBehavior: widget.textHeightBehavior,
        selectionColor: widget.selectionColor,
      );
    }
    return Text(
      widget.data!,
      style: style,
      textAlign: textAlign,
      softWrap: softWrap,
      maxLines: maxLines,
      overflow: overflow,
      strutStyle: widget.strutStyle,
      textDirection: widget.textDirection,
      locale: widget.locale,
      textScaler: widget.textScaler,
      semanticsLabel: widget.semanticsLabel,
      textWidthBasis: widget.textWidthBasis,
      textHeightBehavior: widget.textHeightBehavior,
      selectionColor: widget.selectionColor,
    );
  }
  if (styling.style != null) {
    return DefaultTextStyle.merge(style: styling.style, child: widget);
  }
  return widget;
}

/// The `DecoratedBox` decoration (§2.3 step 3): `color`, `gradient`,
/// `border`+`borderWidth`+`borderStyle`, `borderRadius`, `shadow`.
///
/// On a node that consumes `color` itself (text-bearing nodes: the legacy
/// level-1 text color; `icon`/`icon_button`: the icon color, §2.6) the
/// color is not painted as a background.
Decoration? _decoration(UiNode node, {required bool colorConsumed}) {
  final color = colorConsumed ? null : _asColor(node.props['color']);
  final gradient = _gradient(node.props['gradient']);
  final shape = _boxShape(node.stringProp('shape'));
  // Flutter's `BoxDecoration` forbids combining `borderRadius` with
  // `BoxShape.circle` (an assertion, not a degrade) — drop the radius for a
  // circle instead (§2.4/§9: never crash on server content).
  final borderRadius = shape == BoxShape.circle
      ? null
      : _borderRadius(node.props['borderRadius']);
  final border = _border(node);
  final shadow = _shadow(node.props['shadow']);
  if (color == null &&
      gradient == null &&
      borderRadius == null &&
      border == null &&
      shadow == null &&
      shape != BoxShape.circle) {
    return null;
  }
  return BoxDecoration(
    color: color,
    gradient: gradient,
    border: border,
    borderRadius: borderRadius,
    boxShadow: shadow == null ? null : [shadow],
    shape: shape ?? BoxShape.rectangle,
  );
}

/// The `box`-only `shape` prop (§2.6): `rectangle` (default) or `circle`.
/// Unknown/absent degrades to null (→ `BoxShape.rectangle`), never a crash.
BoxShape? _boxShape(String? value) {
  switch (value) {
    case 'circle':
      return BoxShape.circle;
    case 'rectangle':
      return BoxShape.rectangle;
  }
  return null;
}

/// A [Color] passthrough over [parseColor]: a resolved `$color.*` token
/// arrives as a [Color], a literal as a hex string.
Color? _asColor(Object? value) {
  if (value is Color) return value;
  return parseColor(value);
}

Border? _border(UiNode node) {
  final color = _asColor(node.props['border']);
  if (color == null) return null;
  final style = node.stringProp('borderStyle') == 'none'
      ? BorderStyle.none
      : BorderStyle.solid;
  return Border.all(
    color: color,
    width: node.numProp('borderWidth')?.toDouble() ?? 1.0,
    style: style,
  );
}

BorderRadius? _borderRadius(Object? value) {
  final radius = value is num ? value.toDouble() : null;
  if (radius == null) return null;
  return BorderRadius.circular(radius);
}

BoxShadow? _shadow(Object? value) {
  if (value is num) {
    // An `$elevation.*` token (or bare number): blur and offset follow the
    // elevation value.
    final elevation = value.toDouble();
    return BoxShadow(blurRadius: elevation, offset: Offset(0, elevation));
  }
  if (value is! Map) return null;
  final map = Map<String, dynamic>.from(value);
  final blur = map['blur'];
  final spread = map['spread'];
  final offset = map['offset'];
  final dx = offset is List && offset.isNotEmpty && offset[0] is num
      ? (offset[0] as num).toDouble()
      : 0.0;
  final dy = offset is List && offset.length > 1 && offset[1] is num
      ? (offset[1] as num).toDouble()
      : 0.0;
  return BoxShadow(
    color: _asColor(map['color']) ?? Colors.black26,
    blurRadius: blur is num ? blur.toDouble() : 0,
    spreadRadius: spread is num ? spread.toDouble() : 0,
    offset: Offset(dx, dy),
  );
}

Gradient? _gradient(Object? value) {
  if (value is! Map) return null;
  final map = Map<String, dynamic>.from(value);
  final rawColors = map['colors'];
  if (rawColors is! List) return null;
  final colors = [
    for (final item in rawColors)
      if (_asColor(item) case final Color color) color,
  ];
  if (colors.length < 2) return null;
  final rawStops = map['stops'];
  List<double>? stops;
  if (rawStops is List &&
      rawStops.length == colors.length &&
      rawStops.every((stop) => stop is num)) {
    stops = [for (final stop in rawStops) (stop as num).toDouble()];
  }
  final begin = _alignment(map['begin']) ?? Alignment.centerLeft;
  final end = _alignment(map['end']) ?? Alignment.centerRight;
  switch (map['type']) {
    case 'radial':
      return RadialGradient(colors: colors, stops: stops);
    case 'sweep':
      return SweepGradient(colors: colors, stops: stops);
    case 'linear':
    case null:
      return LinearGradient(
          colors: colors, stops: stops, begin: begin, end: end);
  }
  return null;
}

/// Alignment literals (`topLeft` … `bottomRight`) or a `[x, y]` pair;
/// anything else degrades to null.
Alignment? _alignment(Object? value) {
  if (value is String) {
    switch (value) {
      case 'topLeft':
        return Alignment.topLeft;
      case 'topCenter':
        return Alignment.topCenter;
      case 'topRight':
        return Alignment.topRight;
      case 'centerLeft':
        return Alignment.centerLeft;
      case 'center':
        return Alignment.center;
      case 'centerRight':
        return Alignment.centerRight;
      case 'bottomLeft':
        return Alignment.bottomLeft;
      case 'bottomCenter':
        return Alignment.bottomCenter;
      case 'bottomRight':
        return Alignment.bottomRight;
    }
    return null;
  }
  if (value is List &&
      value.length == 2 &&
      value[0] is num &&
      value[1] is num) {
    return Alignment((value[0] as num).toDouble(), (value[1] as num).toDouble());
  }
  return null;
}

/// Public alias of [_alignment] (docs/sdui.md §2.1 Box `align`): shared by
/// the universal wrapper above and the `align`/`box`/`center` primitives,
/// which need the same alignment-literal parsing for their own `child`
/// slot. Unknown values degrade to null (§2.4).
Alignment? parseAlignmentLiteral(Object? value) => _alignment(value);

/// Primitives whose §2.6 `alignment` prop is their own layout prop —
/// `stack`'s non-positioned child alignment, `wrap`'s run alignment,
/// `icon_button`'s icon alignment — and not the §2.1 alias of `align`. On
/// those types the alias must not double-wrap the node in an `Align`.
const Set<String> _ownAlignmentProps = {'stack', 'wrap', 'icon_button'};

/// The §2.1 `alignment` alias value of a node: null where the primitive
/// owns the key (see [_ownAlignmentProps]).
Object? _alignmentAlias(UiNode node) =>
    _ownAlignmentProps.contains(node.type) ? null : node.props['alignment'];

/// Builds the single `child` prop slot used by single-child primitives
/// (`box`, `expanded`, `flexible`, `align`, `center`, `sized_box`,
/// `aspect_ratio`, …): a nested node object or the string shorthand. `null`
/// (the prop absent) returns `null` so the caller can degrade visibly.
Widget? buildChildProp(BuildContext context, RenderContext ctx, Object? value) {
  if (value == null) return null;
  return ctx.build(context, UiNode.fromJson(value));
}

/// The `ConstrainedBox` constraints (§2.3 step 5). `width`/`height` set
/// tight extents; explicit min/max win over them. A non-normalized set
/// (max < min) degrades to no constraints.
BoxConstraints? _constraints(UiNode node, {required bool textBearing}) {
  final width = node.numProp('width')?.toDouble();
  // On a text-bearing node `height` is the line-height multiple, not a box
  // constraint.
  final height = textBearing ? null : node.numProp('height')?.toDouble();
  var minWidth = node.numProp('minWidth')?.toDouble();
  var maxWidth = node.numProp('maxWidth')?.toDouble();
  var minHeight = node.numProp('minHeight')?.toDouble();
  var maxHeight = node.numProp('maxHeight')?.toDouble();
  if (width == null &&
      height == null &&
      minWidth == null &&
      maxWidth == null &&
      minHeight == null &&
      maxHeight == null) {
    return null;
  }
  if (width != null) {
    minWidth = width;
    maxWidth = width;
  }
  if (height != null) {
    minHeight = height;
    maxHeight = height;
  }
  if (node.numProp('minWidth') != null) minWidth = node.numProp('minWidth')!.toDouble();
  if (node.numProp('maxWidth') != null) maxWidth = node.numProp('maxWidth')!.toDouble();
  if (node.numProp('minHeight') != null) minHeight = node.numProp('minHeight')!.toDouble();
  if (node.numProp('maxHeight') != null) maxHeight = node.numProp('maxHeight')!.toDouble();
  final minW = minWidth ?? 0.0;
  final maxW = maxWidth ?? double.infinity;
  final minH = minHeight ?? 0.0;
  final maxH = maxHeight ?? double.infinity;
  if (minW > maxW || minH > maxH) return null;
  return BoxConstraints(
    minWidth: minW,
    maxWidth: maxW,
    minHeight: minH,
    maxHeight: maxH,
  );
}

/// The `Transform` (§2.3 step 8): a 16-number column-major matrix, or
/// `{translate: [x,y,z]?, rotate?: rad, scale?: [x,y]}` (applied in that
/// order). Anything else degrades to no transform.
Matrix4? _transform(Object? value) {
  if (value is List && value.length == 16 && value.every((item) => item is num)) {
    final matrix = Matrix4.identity();
    final storage = matrix.storage;
    for (var i = 0; i < 16; i++) {
      storage[i] = (value[i] as num).toDouble();
    }
    return matrix;
  }
  if (value is! Map) return null;
  final map = Map<String, dynamic>.from(value);
  final matrix = Matrix4.identity();
  final translate = map['translate'];
  if (translate is List &&
      translate.length >= 2 &&
      translate.length <= 3 &&
      translate.every((item) => item is num)) {
    matrix.translateByDouble(
      (translate[0] as num).toDouble(),
      (translate[1] as num).toDouble(),
      translate.length > 2 ? (translate[2] as num).toDouble() : 0,
      1,
    );
  }
  final rotate = map['rotate'];
  if (rotate is num) matrix.rotateZ(rotate.toDouble());
  final scale = map['scale'];
  if (scale is List &&
      scale.length == 2 &&
      scale.every((item) => item is num)) {
    matrix.scaleByDouble(
        (scale[0] as num).toDouble(), (scale[1] as num).toDouble(), 1, 1);
  }
  return matrix;
}

/// The `clip` (§2.3 step 9): `hardEdge` clips rectangularly, the rounded
/// variants clip with the node's `borderRadius` (default `$radius.sm`).
/// `none` and unknown values degrade to no clip.
Widget _applyClip(Widget result, UiNode node, JhinTokens tokens) {
  switch (node.stringProp('clip')) {
    case 'hardEdge':
      return ClipRect(clipBehavior: Clip.hardEdge, child: result);
    case 'softEdge':
    case 'antiAlias':
    case 'antiAliasWithSaveLayer':
      final behavior = node.stringProp('clip') == 'antiAliasWithSaveLayer'
          ? Clip.antiAliasWithSaveLayer
          : Clip.antiAlias;
      final radius = _borderRadius(node.props['borderRadius']) ??
          BorderRadius.circular(tokens.radius.sm);
      return ClipRRect(borderRadius: radius, clipBehavior: behavior, child: result);
    default:
      return result;
  }
}

/// Primitives that already own their interaction — their own `action`
/// handler and tap target (`button`, `icon_button`, `dropdown`) — so the
/// gesture wrapper must not add a nested second dispatch handler for them
/// (the §2.3 note).
const Set<String> _interactivePrimitives = {'button', 'icon_button', 'dropdown'};

/// The gesture wrapper (§2.3 step 12): `InkWell` when the node sits on a
/// Material surface, `GestureDetector` otherwise. `action`/`onTap` drive
/// the tap, `onLongPress` the long press — with both present the tap rides
/// the `InkWell` and the long press an outer `GestureDetector`, so a tap
/// fires only `onTap` and a long press only `onLongPress`. `confirm` gates
/// every dispatch (a decline dispatches nothing), `enabled: false` drops
/// the interaction entirely (layout is kept). A primitive that already
/// owns its interaction keeps its own handler and is left untouched.
Widget _applyGesture(
  BuildContext context,
  UiNode node,
  Widget result,
  RenderContext ctx,
) {
  if (_interactivePrimitives.contains(node.type)) return result;
  if (node.boolProp('enabled') == false) return result;
  final action = asMap(node.props['action']) ?? asMap(node.props['onTap']);
  final longPressAction = asMap(node.props['onLongPress']);
  if (action == null && longPressAction == null) return result;

  void dispatch(Map<String, dynamic> act) {
    final confirm = node.stringProp('confirm');
    if (confirm != null && confirm.isNotEmpty) {
      ctx.confirm(confirm, () => ctx.dispatch(act));
    } else {
      ctx.dispatch(act);
    }
  }

  void tap() {
    if (action != null) dispatch(action);
  }

  void longPress() {
    if (longPressAction != null) dispatch(longPressAction);
  }

  // An absent `cursor` leaves the InkWell cursor at its default; an
  // unknown literal degrades to the default cursor (§2.4), the same value
  // the outer MouseRegion gets (the §2.3 note).
  final rawCursor = node.stringProp('cursor');
  final cursor = rawCursor == null || rawCursor.isEmpty
      ? null
      : parseMouseCursor(rawCursor) ?? MouseCursor.defer;
  final onMaterial = context.findAncestorWidgetOfExactType<Material>() != null;
  if (onMaterial) {
    if (action == null) {
      return GestureDetector(onLongPress: longPress, child: result);
    }
    final ink = InkWell(onTap: tap, mouseCursor: cursor, child: result);
    return longPressAction == null
        ? ink
        : GestureDetector(onLongPress: longPress, child: ink);
  }
  return GestureDetector(
    onTap: action == null ? null : tap,
    onLongPress: longPressAction == null ? null : longPress,
    child: result,
  );
}

/// The `Focus` wrapper (`focusable`; the §2.3 note places it between the
/// gesture wrapper and `Semantics`): only `focusable: true` participates
/// in focus traversal, and `enabled: false` gates it with the rest of the
/// interaction (§2.1).
Widget _applyFocus(Widget result, UiNode node) {
  if (node.boolProp('enabled') == false) return result;
  if (node.boolProp('focusable') != true) return result;
  return Focus(child: result);
}

/// The `MouseRegion` wrapper (`cursor`; the §2.3 note places it outermost
/// in the interaction cluster): the mapped [SystemMouseCursors] literal,
/// or the default cursor for an unknown literal (§2.4) — never a throw.
Widget _applyCursor(Widget result, UiNode node) {
  final raw = node.stringProp('cursor');
  if (raw == null || raw.isEmpty) return result;
  return MouseRegion(
    cursor: parseMouseCursor(raw) ?? MouseCursor.defer,
    child: result,
  );
}

/// The `cursor`/`mouseCursor` literal set (§2.1/§2.6); unknown degrades to
/// null (the platform default) — §2.4.
MouseCursor? parseMouseCursor(String? value) {
  switch (value) {
    case 'system':
      return SystemMouseCursors.basic;
    case 'none':
      return SystemMouseCursors.none;
    case 'click':
      return SystemMouseCursors.click;
    case 'text':
      return SystemMouseCursors.text;
    case 'forbidden':
      return SystemMouseCursors.forbidden;
    case 'grab':
      return SystemMouseCursors.grab;
    case 'grabbing':
      return SystemMouseCursors.grabbing;
    case 'wait':
      return SystemMouseCursors.wait;
    case 'precise':
      return SystemMouseCursors.precise;
    case 'allScroll':
      return SystemMouseCursors.allScroll;
    case 'resizeUpDown':
      return SystemMouseCursors.resizeUpDown;
    case 'resizeLeftRight':
      return SystemMouseCursors.resizeLeftRight;
    case 'alias':
      return SystemMouseCursors.alias;
    case 'cell':
      return SystemMouseCursors.cell;
    case 'contextMenu':
      return SystemMouseCursors.contextMenu;
    case 'copy':
      return SystemMouseCursors.copy;
    case 'help':
      return SystemMouseCursors.help;
    case 'move':
      return SystemMouseCursors.move;
    case 'noDrop':
      return SystemMouseCursors.noDrop;
    case 'progress':
      return SystemMouseCursors.progress;
    case 'zoomIn':
      return SystemMouseCursors.zoomIn;
    case 'zoomOut':
      return SystemMouseCursors.zoomOut;
  }
  return null;
}

/// The `Semantics` wrapper (§2.3 step 13).
Widget _applySemantics(Widget result, UiNode node) {
  final label = node.stringProp('semanticsLabel');
  final hint = node.stringProp('semanticsHint');
  final value = node.stringProp('semanticsValue');
  final exclude = node.boolProp('excludeSemantics') == true;
  if (label == null && hint == null && value == null && !exclude) {
    return result;
  }
  return Semantics(
    label: label,
    hint: hint,
    value: value,
    excludeSemantics: exclude,
    child: result,
  );
}

/// Steps 14 + 15 of §2.3: `Flexible`/`Expanded` (`flex`/`fit`) and
/// `Padding(margin)`.
///
/// Flex wrapping only happens when [flexParent] marks the node as a direct
/// child of a `Flex` — elsewhere `flex`/`fit` degrade silently (Flutter
/// requires flex children to be direct Flex children; the client never
/// crashes on server content). When a flex wrap applies, the margin sits
/// INSIDE the flex wrapper: the documented order puts `Padding(margin)`
/// outside, but an `Expanded` under a `Padding` is a hard Flutter layout
/// error, and the client never crashes on server content.
Widget _applyFlexAndMargin(
  Widget result,
  UiNode node, {
  required JhinTokens tokens,
  required bool flexParent,
}) {
  final margin = parsePadding(node.props['margin'], tokens: tokens);
  var flex = flexParent ? node.numProp('flex')?.round() : null;
  var fit = flexParent ? _flexFit(node.stringProp('fit')) : null;
  // §2.6 defaults of the `expanded`/`flexible` primitives: an absent `flex`
  // is `1` for both, and an absent `fit` on `flexible` is `loose` — the node
  // type carries the documented default even when the wire omits the prop.
  if (flexParent && node.type == 'flexible' && fit == null) {
    fit = FlexFit.loose;
  }
  if (flexParent && flex == null && fit == null && node.type == 'expanded') {
    flex = 1;
  }
  if (flex == null && fit == null) {
    return margin == null ? result : Padding(padding: margin, child: result);
  }
  final withMargin =
      margin == null ? result : Padding(padding: margin, child: result);
  if (flex != null && fit == FlexFit.loose) {
    return Flexible(flex: flex, fit: FlexFit.loose, child: withMargin);
  }
  if (flex != null) return Expanded(flex: flex, child: withMargin);
  if (fit == FlexFit.loose) {
    return Flexible(fit: FlexFit.loose, child: withMargin);
  }
  return Expanded(child: withMargin);
}

FlexFit? _flexFit(String? value) {
  switch (value) {
    case 'loose':
      return FlexFit.loose;
    case 'tight':
      return FlexFit.tight;
  }
  return null;
}

/// Widget builder of one primitive.
typedef UiBuilder = Widget Function(
    BuildContext context, UiNode node, RenderContext ctx);

// ---------------------------------------------------------------------------
// Shared helpers (used by the primitives)
// ---------------------------------------------------------------------------

/// Parses `#RRGGBB`, `#AARRGGBB`, `0xFFRRGGBB` or an int color. A resolved
/// `$color.*` token arrives as a [Color] and passes through unchanged.
Color? parseColor(Object? value) {
  if (value is Color) return value;
  if (value is int) return Color(value);
  if (value is String) {
    var text = value.trim();
    if (text.startsWith('#')) {
      text = text.substring(1);
      if (text.length == 6) text = 'FF$text';
      if (text.length == 8) {
        final parsed = int.tryParse(text, radix: 16);
        if (parsed != null) return Color(parsed);
      }
    } else if (text.startsWith('0x') || text.startsWith('0X')) {
      final parsed = int.tryParse(text.substring(2), radix: 16);
      if (parsed != null) return Color(parsed);
    }
  }
  return null;
}

/// Parses a universal `padding`/`margin` (§2.1): a number, a 1-4 number
/// list (CSS order: `[all]`, `[v,h]`, `[t,h,b]`, `[t,r,b,l]`), or a
/// `{top,right,bottom,left}` map. Each component may be a `$token`
/// reference, resolved through [tokens]; an unresolvable component degrades
/// the whole padding to null (the node renders unpadded, never crashes).
EdgeInsets? parsePadding(Object? value, {JhinTokens? tokens}) {
  double? component(Object? item) {
    if (item is num) return item.toDouble();
    if (item is String && tokens != null) {
      final resolved = tokens.resolveToken(item);
      if (resolved is num) return resolved.toDouble();
    }
    return null;
  }

  if (value is num) return EdgeInsets.all(value.toDouble());
  if (value is String) {
    final resolved = component(value);
    return resolved == null ? null : EdgeInsets.all(resolved);
  }
  if (value is List && value.isNotEmpty && value.length <= 4) {
    final sides = <double>[];
    for (final item in value) {
      final side = component(item);
      if (side == null) return null;
      sides.add(side);
    }
    switch (sides.length) {
      case 1:
        return EdgeInsets.all(sides[0]);
      case 2:
        return EdgeInsets.symmetric(vertical: sides[0], horizontal: sides[1]);
      case 3:
        return EdgeInsets.only(
            top: sides[0], left: sides[1], right: sides[1], bottom: sides[2]);
      case 4:
        return EdgeInsets.fromLTRB(sides[3], sides[0], sides[1], sides[2]);
    }
  }
  if (value is Map) {
    final map = Map<String, dynamic>.from(value);
    var invalid = false;
    double? side(String key) {
      if (!map.containsKey(key)) return null;
      final parsed = component(map[key]);
      if (parsed == null) invalid = true;
      return parsed;
    }

    final top = side('top');
    final right = side('right');
    final bottom = side('bottom');
    final left = side('left');
    if (invalid) return null;
    if (top == null && right == null && bottom == null && left == null) {
      return null;
    }
    return EdgeInsets.fromLTRB(left ?? 0, top ?? 0, right ?? 0, bottom ?? 0);
  }
  return null;
}

/// Visible fallback for a node whose required props are missing or
/// malformed (§8.3 degrade rule): a muted box, never an empty frame.
Widget degradedBox(BuildContext context, String message) {
  final theme = Theme.of(context);
  final tokens = JhinDesignScope.of(context).tokens;
  return Container(
    padding: EdgeInsets.all(tokens.spacing.sm),
    decoration: BoxDecoration(
      color: theme.hoverColor,
      borderRadius: BorderRadius.circular(tokens.radius.sm),
    ),
    child: Text(message, style: TextStyle(color: theme.disabledColor)),
  );
}

/// Current value of a stateful field node: the live [UiState] value, or the
/// node's `value` prop, which is seeded into the state on first use so
/// actions, forms and `include` merges see what the widget displays (§8.4).
Object? fieldValue(RenderContext ctx, UiNode node) {
  final id = node.id;
  final initial = node.props['value'];
  if (id == null) return initial;
  if (ctx.state.values.containsKey(id)) return ctx.state[id];
  if (initial != null) ctx.state.seedValue(id, initial);
  return initial;
}

Widget _unsupportedCard(BuildContext context, String type, String? reason) {
  final theme = Theme.of(context);
  final tokens = JhinDesignScope.of(context).tokens;
  return Card(
    child: Padding(
      padding: EdgeInsets.all(tokens.spacing.md),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Unsupported UI element: $type',
            style: TextStyle(color: theme.disabledColor),
          ),
          if (reason != null && reason.isNotEmpty)
            Text(
              reason,
              style: theme.textTheme.bodySmall,
            ),
        ],
      ),
    ),
  );
}

List<Widget> buildChildren(
    BuildContext context, UiNode node, RenderContext ctx,
    {bool flexAware = false, Set<String>? expandTypes}) {
  return [
    for (final child in node.children)
      if (flexAware && child.numProp('flex') != null)
        // The universal flex wrap (§2.3 step 14) applies inside the
        // registry — the child is a direct Flex child here.
        ctx.build(context, child, flexParent: true)
      else if (expandTypes != null && expandTypes.contains(child.type))
        Expanded(child: ctx.build(context, child))
      else
        ctx.build(context, child),
  ];
}

List<Widget> buildNodeList(
    BuildContext context, RenderContext ctx, List<Object?>? raw) {
  return [
    if (raw != null)
      for (final item in raw) ctx.build(context, UiNode.fromJson(item)),
  ];
}

Map<String, dynamic>? asMap(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : null;

/// Resolves one icon name through the generated [kIconRegistry] (§2.6) —
/// the only icon lookup path in the client. An unknown name logs and
/// returns null, and every caller degrades to an empty icon (§2.4) — never
/// a crash.
IconData? iconFor(String? name) {
  if (name == null) return null;
  final icon = kIconRegistry[name];
  if (icon == null) {
    debugPrint('Jhin SDUI: unknown icon name "$name"');
  }
  return icon;
}
