import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart'
    show
        asMap,
        parseAlignmentLiteral,
        parseColor,
        parseMouseCursor,
        parsePadding;
import 'icon.dart' show buildIconValue;

/// `icon_button` (§2.6): the full [IconButton] parameter set — `icon` (an
/// icon name or an inline node), `action`, `iconSize`, `color`,
/// `disabledColor`, `highlightColor`, `splashColor`, `focusColor`,
/// `hoverColor`, `padding`, `alignment`, `constraints`, `autofocus`,
/// `isSelected`, `selectedIcon`, `mouseCursor`, `visualDensity`,
/// `enableFeedback`, `splashRadius` and `style` (a ButtonStyle map).
///
/// Without an `action` the button is disabled: `onPressed` stays null (the
/// disabled visual state) and nothing dispatches. `tooltip`/`confirm`/
/// `cursor`/`enabled` arrive through the universal surface (§2.1); `color`
/// is the icon color (§2.6), so the universal box wrapper does not paint it
/// as a background, and `padding`/`alignment` are the button's own params
/// (the universal `padding`/`alignment` wraps skip them). Every malformed
/// prop degrades to the widget default — never a crash (§2.4).
Widget buildIconButton(BuildContext context, UiNode node, RenderContext ctx) {
  final icon = _iconSlot(context, ctx, node.props['icon'], 'icon');
  final selectedIcon = node.props.containsKey('selectedIcon')
      ? _iconSlot(context, ctx, node.props['selectedIcon'], 'selectedIcon')
      : null;
  final action = asMap(node.props['action']);
  final confirm = node.stringProp('confirm');
  // Universal `enabled: false` (§2.1) gates the button's own dispatch just
  // like the gesture wrapper gates the universal one.
  final enabled = node.boolProp('enabled') != false;
  final VoidCallback? onPressed = action == null || !enabled
      ? null
      : () {
          if (confirm != null && confirm.isNotEmpty) {
            ctx.confirm(confirm, () => ctx.dispatch(action));
          } else {
            ctx.dispatch(action);
          }
        };

  final tokens = JhinDesignScope.of(context).tokens;
  return IconButton(
    onPressed: onPressed,
    icon: icon,
    isSelected: node.boolProp('isSelected'),
    selectedIcon: selectedIcon,
    iconSize: _positive(node.numProp('iconSize')?.toDouble()),
    color: parseColor(node.props['color']),
    disabledColor: parseColor(node.props['disabledColor']),
    highlightColor: parseColor(node.props['highlightColor']),
    splashColor: parseColor(node.props['splashColor']),
    focusColor: parseColor(node.props['focusColor']),
    hoverColor: parseColor(node.props['hoverColor']),
    padding: parsePadding(node.props['padding'], tokens: tokens),
    alignment: parseAlignmentLiteral(node.props['alignment']),
    constraints: _constraints(node.props['constraints']),
    autofocus: node.boolProp('autofocus') ?? false,
    mouseCursor: parseMouseCursor(node.stringProp('mouseCursor')),
    visualDensity: _visualDensity(node.stringProp('visualDensity')),
    enableFeedback: node.boolProp('enableFeedback'),
    splashRadius: _positive(node.numProp('splashRadius')?.toDouble()),
    style: _buttonStyle(
        node.props['style'],
        tokens,
        JhinDesignScope.materialOf(context).colorScheme.onSurface),
  );
}

/// The `icon`/`selectedIcon` slot (§2.6): an icon name or an inline node.
/// A missing or unknown name degrades to an empty [Icon] and logs — §2.4.
Widget _iconSlot(
    BuildContext context, RenderContext ctx, Object? value, String prop) {
  if (value == null) {
    debugPrint('Jhin SDUI: icon_button without an "$prop"');
    return const Icon(null);
  }
  return buildIconValue(context, ctx, value);
}

/// A strictly positive finite number (§2.6); anything else drops to null
/// (Flutter asserts on non-positive `iconSize`/`splashRadius`).
double? _positive(double? value) {
  if (value == null || !value.isFinite || value <= 0) return null;
  return value;
}

/// The `constraints` spec (§2.6): `{minWidth, maxWidth, minHeight,
/// maxHeight}`. A non-normalized set (max < min) degrades to none — §2.4.
BoxConstraints? _constraints(Object? value) {
  if (value is! Map) return null;
  final map = Map<String, dynamic>.from(value);
  double? number(String key) {
    final raw = map[key];
    return raw is num && raw.toDouble().isFinite ? raw.toDouble() : null;
  }

  final constraints = BoxConstraints(
    minWidth: number('minWidth') ?? 0,
    maxWidth: number('maxWidth') ?? double.infinity,
    minHeight: number('minHeight') ?? 0,
    maxHeight: number('maxHeight') ?? double.infinity,
  );
  if (constraints.minWidth == 0 &&
      constraints.maxWidth == double.infinity &&
      constraints.minHeight == 0 &&
      constraints.maxHeight == double.infinity) {
    return null;
  }
  if (!constraints.isNormalized) return null;
  return constraints;
}

/// `visualDensity` (§2.6): the control-density literals of §1
/// (`compact`/`comfortable`/`spacious`), mapped like the density preference.
/// An unknown literal degrades to the prop's default (absent) — §2.4.
VisualDensity? _visualDensity(String? value) {
  if (value != 'compact' && value != 'comfortable' && value != 'spacious') {
    return null;
  }
  return JhinDensity.parse(value).visualDensity;
}

/// The `style` ButtonStyle map (§2.6). Tolerant: known keys land on the
/// [ButtonStyle], unknown or malformed ones are ignored (§2.4). Accepted
/// keys: `backgroundColor`, `foregroundColor`, `overlayColor`,
/// `shadowColor`, `surfaceTintColor`, `iconColor`, `elevation`, `iconSize`,
/// `padding`, `minimumSize`, `maximumSize`, `fixedSize`, `side`, `shape`,
/// `mouseCursor`, `visualDensity`, `alignment`, `enableFeedback`,
/// `animationDuration`, `tapTargetSize`.
ButtonStyle? _buttonStyle(Object? value, JhinTokens tokens, Color fallback) {
  if (value is! Map) return null;
  final map = Map<String, dynamic>.from(value);

  Color? color(String key) => parseColor(map[key]);

  double? number(String key) {
    final raw = map[key];
    return raw is num && raw.toDouble().isFinite ? raw.toDouble() : null;
  }

  Size? size(String key) {
    final raw = map[key];
    if (raw is! Map) return null;
    final spec = Map<String, dynamic>.from(raw);
    final width = spec['width'];
    final height = spec['height'];
    return Size(
      width is num ? width.toDouble() : double.infinity,
      height is num ? height.toDouble() : double.infinity,
    );
  }

  BorderSide? side(Color fallback) {
    final raw = map['side'];
    if (raw is! Map) return null;
    final spec = Map<String, dynamic>.from(raw);
    final width = spec['width'];
    return BorderSide(
      color: parseColor(spec['color']) ?? fallback,
      width: width is num && width.toDouble().isFinite && width > 0
          ? width.toDouble()
          : 1.0,
    );
  }

  OutlinedBorder? shape() {
    final raw = map['shape'];
    if (raw is! Map) return null;
    final spec = Map<String, dynamic>.from(raw);
    final radius = spec['borderRadius'];
    if (radius is! num || !radius.toDouble().isFinite || radius < 0) return null;
    return RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(radius.toDouble()),
    );
  }

  final overlayColor = color('overlayColor');
  final backgroundColor = color('backgroundColor');
  final foregroundColor = color('foregroundColor');
  final shadowColor = color('shadowColor');
  final surfaceTintColor = color('surfaceTintColor');
  final iconColor = color('iconColor');
  final elevation = number('elevation');
  final iconSize = number('iconSize');
  final padding = parsePadding(map['padding'], tokens: tokens);
  final minimumSize = size('minimumSize');
  final maximumSize = size('maximumSize');
  final fixedSize = size('fixedSize');
  final sideValue = side(fallback);
  final shapeValue = shape();
  final mouseCursor = parseMouseCursor(
      map['mouseCursor'] is String ? map['mouseCursor'] as String : null);
  final tapTargetSize = map['tapTargetSize'];
  return ButtonStyle(
    backgroundColor: backgroundColor == null
        ? null
        : WidgetStatePropertyAll(backgroundColor),
    foregroundColor: foregroundColor == null
        ? null
        : WidgetStatePropertyAll(foregroundColor),
    overlayColor:
        overlayColor == null ? null : WidgetStatePropertyAll(overlayColor),
    shadowColor:
        shadowColor == null ? null : WidgetStatePropertyAll(shadowColor),
    surfaceTintColor: surfaceTintColor == null
        ? null
        : WidgetStatePropertyAll(surfaceTintColor),
    iconColor: iconColor == null ? null : WidgetStatePropertyAll(iconColor),
    elevation: elevation == null ? null : WidgetStatePropertyAll(elevation),
    iconSize: iconSize == null ? null : WidgetStatePropertyAll(iconSize),
    padding: padding == null ? null : WidgetStatePropertyAll(padding),
    minimumSize:
        minimumSize == null ? null : WidgetStatePropertyAll(minimumSize),
    maximumSize:
        maximumSize == null ? null : WidgetStatePropertyAll(maximumSize),
    fixedSize: fixedSize == null ? null : WidgetStatePropertyAll(fixedSize),
    side: sideValue == null ? null : WidgetStatePropertyAll(sideValue),
    shape: shapeValue == null ? null : WidgetStatePropertyAll(shapeValue),
    mouseCursor:
        mouseCursor == null ? null : WidgetStatePropertyAll(mouseCursor),
    visualDensity: _visualDensity(
        map['visualDensity'] is String ? map['visualDensity'] as String : null),
    alignment: parseAlignmentLiteral(map['alignment']),
    enableFeedback: map['enableFeedback'] is bool
        ? map['enableFeedback'] as bool
        : null,
    animationDuration: number('animationDuration') == null
        ? null
        : Duration(milliseconds: number('animationDuration')!.round()),
    tapTargetSize: tapTargetSize == 'shrinkWrap'
        ? MaterialTapTargetSize.shrinkWrap
        : tapTargetSize == 'padded'
            ? MaterialTapTargetSize.padded
            : null,
  );
}