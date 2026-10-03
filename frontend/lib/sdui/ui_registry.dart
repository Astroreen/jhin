import 'package:flutter/material.dart';

import 'expr.dart';
import 'primitives/button.dart';
import 'primitives/card.dart';
import 'primitives/chart_bar.dart';
import 'primitives/chart_line.dart';
import 'primitives/chart_pie.dart';
import 'primitives/checkbox.dart';
import 'primitives/container.dart';
import 'primitives/divider.dart';
import 'primitives/drawer.dart';
import 'primitives/dropdown.dart';
import 'primitives/figure.dart';
import 'primitives/form.dart';
import 'primitives/image.dart';
import 'primitives/input.dart';
import 'primitives/list.dart';
import 'primitives/markdown.dart';
import 'primitives/nav.dart';
import 'primitives/progress.dart';
import 'primitives/screen.dart';
import 'primitives/slider.dart';
import 'primitives/spacer.dart';
import 'primitives/stream_view.dart';
import 'primitives/switch.dart';
import 'primitives/table.dart';
import 'primitives/text.dart';
import 'render_context.dart';
import 'ui_node.dart';
import 'ui_state.dart';

/// Maps a node `type` to its widget builder (§8.3).
///
/// [build] wraps every node with the universal semantics: `when` / `visible`
/// hiding, `${…}` interpolation of string props, `padding`, and per-node
/// error isolation — one bad node never kills the screen. An unknown type
/// renders the muted `Unsupported UI element: <type>` card and never throws.
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
    });
    return registry;
  }

  final Map<String, UiBuilder> _builders;

  /// Registers (or overrides) one builder.
  void register(String type, UiBuilder builder) => _builders[type] = builder;

  /// Builds one node. Applies the universal fields, then the type builder,
  /// isolating any failure to this node.
  Widget build(BuildContext context, UiNode node, RenderContext ctx) {
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
    final interpolated = _interpolateNode(node, ctx);
    Widget result;
    try {
      result = builder(context, interpolated, ctx);
    } catch (error) {
      debugPrint('Jhin SDUI: failed to render "${node.type}": $error');
      return _unsupportedCard(context, node.type, '$error');
    }
    final padding = parsePadding(interpolated.props['padding']);
    if (padding != null) {
      result = Padding(padding: padding, child: result);
    }
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

/// Widget builder of one primitive.
typedef UiBuilder = Widget Function(
    BuildContext context, UiNode node, RenderContext ctx);

// ---------------------------------------------------------------------------
// Shared helpers (used by the primitives)
// ---------------------------------------------------------------------------

/// Parses `#RRGGBB`, `#AARRGGBB`, `0xFFRRGGBB` or an int color.
Color? parseColor(Object? value) {
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

/// Parses a universal `padding`: a number, or a 1-4 number list (CSS order).
EdgeInsets? parsePadding(Object? value) {
  if (value is num) return EdgeInsets.all(value.toDouble());
  if (value is List && value.isNotEmpty && value.length <= 4) {
    final sides = <double>[];
    for (final item in value) {
      if (item is! num) return null;
      sides.add(item.toDouble());
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
  return null;
}

/// Visible fallback for a node whose required props are missing or
/// malformed (§8.3 degrade rule): a muted box, never an empty frame.
Widget degradedBox(BuildContext context, String message) {
  final theme = Theme.of(context);
  return Container(
    padding: const EdgeInsets.all(8),
    decoration: BoxDecoration(
      color: theme.hoverColor,
      borderRadius: BorderRadius.circular(4),
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
  return Card(
    child: Padding(
      padding: const EdgeInsets.all(12),
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
        Expanded(
          flex: child.numProp('flex')!.round(),
          child: ctx.build(context, child),
        )
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

IconData? iconFor(String? name) {
  switch (name) {
    case 'menu':
      return Icons.menu;
    case 'home':
      return Icons.home;
    case 'settings':
      return Icons.settings;
    case 'person':
      return Icons.person;
    case 'add':
      return Icons.add;
    case 'edit':
      return Icons.edit;
    case 'delete':
      return Icons.delete;
    case 'search':
      return Icons.search;
    case 'close':
      return Icons.close;
    case 'check':
      return Icons.check;
    case 'arrow_back':
      return Icons.arrow_back;
    case 'more_vert':
      return Icons.more_vert;
    case 'share':
      return Icons.share;
    case 'star':
      return Icons.star;
    case 'warning':
      return Icons.warning;
    case 'info':
      return Icons.info;
    case 'list':
      return Icons.list;
    case 'chat':
      return Icons.chat;
    case 'send':
      return Icons.send;
  }
  return null;
}
