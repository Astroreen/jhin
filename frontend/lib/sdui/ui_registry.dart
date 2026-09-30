import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'expr.dart';
import 'primitives/button.dart';
import 'primitives/card.dart';
import 'primitives/checkbox.dart';
import 'primitives/container.dart';
import 'primitives/divider.dart';
import 'primitives/dropdown.dart';
import 'primitives/form.dart';
import 'primitives/input.dart';
import 'primitives/markdown.dart';
import 'primitives/nav.dart';
import 'primitives/screen.dart';
import 'primitives/slider.dart';
import 'primitives/spacer.dart';
import 'primitives/switch.dart';
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

  /// The fixed 25-primitive catalog (D-10). Batch-1 primitives live in
  /// `primitives/`; the batch-2 builders are still local (T24).
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
      'list': _buildList,
      'stream_view': _buildStreamView,
      'table': _buildTable,
      'divider': buildDivider,
      'spacer': buildSpacer,
      'progress': _buildProgress,
      'image': _buildImage,
      'figure': _buildFigure,
      'chart_line': _buildChartLine,
      'chart_bar': _buildChartBar,
      'chart_pie': _buildChartPie,
      'drawer': _buildDrawer,
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
// Shared helpers (used by the primitives and the batch-2 builders)
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
    {bool flexAware = false}) {
  return [
    for (final child in node.children)
      if (flexAware && child.numProp('flex') != null)
        Expanded(
          flex: child.numProp('flex')!.round(),
          child: ctx.build(context, child),
        )
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

// ---------------------------------------------------------------------------
// Batch-2 primitives (§8.3): list, stream_view, table, progress, image,
// figure, chart_line, chart_bar, chart_pie, drawer — still local, extracted
// in T24.
// ---------------------------------------------------------------------------

Widget _buildList(BuildContext context, UiNode node, RenderContext ctx) {
  final children = buildNodeList(context, ctx, node.listProp('items'));
  final column = Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: children,
  );
  final maxHeight = node.numProp('maxHeight')?.toDouble();
  if (maxHeight == null) return column;
  return ConstrainedBox(
    constraints: BoxConstraints(maxHeight: maxHeight),
    child: SingleChildScrollView(child: column),
  );
}

class _StreamView extends StatefulWidget {
  const _StreamView({required this.node, required this.ctx});

  final UiNode node;
  final RenderContext ctx;

  @override
  State<_StreamView> createState() => _StreamViewState();
}

class _StreamViewState extends State<_StreamView> {
  final List<Map<String, dynamic>> _items = [];
  final ScrollController _scroll = ScrollController();
  StreamSubscription<Map<String, dynamic>>? _subscription;

  @override
  void initState() {
    super.initState();
    final topic = widget.node.stringProp('topic') ?? '';
    if (topic.isNotEmpty) {
      _subscription = widget.ctx
          .openStream(topic)
          .listen(_onEvent, onError: (Object error) {
        debugPrint('Jhin SDUI: stream "$topic" error: $error');
      });
    }
  }

  void _onEvent(Map<String, dynamic> event) {
    if (!mounted) return;
    setState(() {
      final node = asMap(event['node']);
      if (node != null) {
        if (widget.node.stringProp('mode') == 'replace') {
          _items
            ..clear()
            ..add(node);
        } else {
          _items.add(node);
          final limit = widget.node.numProp('itemLimit');
          if (limit != null && _items.length > limit) {
            _items.removeRange(0, _items.length - limit.round());
          }
        }
        return;
      }
      final patch = asMap(event['patch']);
      if (patch != null) {
        final id = patch['id'];
        final props = asMap(patch['props']);
        if (id is String && props != null) {
          var matched = false;
          for (var i = 0; i < _items.length; i++) {
            if (_items[i]['id'] == id) {
              _items[i] = {..._items[i], ...props};
              matched = true;
            }
          }
          if (!matched) widget.ctx.patch(id, props);
        }
        return;
      }
      final client = event['client'];
      if (client is List) {
        widget.ctx.runDirectives(List<dynamic>.from(client));
        return;
      }
      final remove = event['remove'];
      if (remove is String) {
        _items.removeWhere((item) => item['id'] == remove);
      }
    });
    if (widget.node.boolProp('autoScroll') == true) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scroll.hasClients) {
          _scroll.jumpTo(_scroll.position.maxScrollExtent);
        }
      });
    }
  }

  @override
  void dispose() {
    _subscription?.cancel();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_items.isEmpty) {
      final empty = widget.node.props['empty'];
      if (empty != null) {
        return widget.ctx.build(context, UiNode.fromJson(empty));
      }
      return const SizedBox.shrink();
    }
    return ConstrainedBox(
      constraints: const BoxConstraints(maxHeight: 240),
      child: ListView.builder(
        controller: _scroll,
        shrinkWrap: true,
        itemCount: _items.length,
        itemBuilder: (context, index) =>
            widget.ctx.build(context, UiNode.fromJson(_items[index])),
      ),
    );
  }
}

Widget _buildStreamView(BuildContext context, UiNode node, RenderContext ctx) {
  return _StreamView(node: node, ctx: ctx);
}

Widget _buildTable(BuildContext context, UiNode node, RenderContext ctx) {
  final columns = node.listProp('columns') ?? const [];
  final rows = node.listProp('rows') ?? const [];
  final flexes = <int>[];
  final headers = <String>[];
  for (final raw in columns) {
    final map = asMap(raw);
    headers.add('${map?['label'] ?? ''}');
    final width = map?['width'];
    flexes.add(width is num && width > 0 ? width.round() : 1);
  }
  return Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Row(
        children: [
          for (var i = 0; i < headers.length; i++)
            Expanded(
              flex: i < flexes.length ? flexes[i] : 1,
              child: Text(headers[i],
                  style: const TextStyle(fontWeight: FontWeight.bold)),
            ),
        ],
      ),
      const Divider(height: 1),
      for (final raw in rows)
        if (raw is List)
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (var i = 0; i < raw.length; i++)
                Expanded(
                  flex: i < flexes.length ? flexes[i] : 1,
                  child: ctx.build(context, UiNode.fromJson(raw[i])),
                ),
            ],
          ),
    ],
  );
}

Widget _buildProgress(BuildContext context, UiNode node, RenderContext ctx) {
  final value = node.numProp('value')?.toDouble();
  return node.stringProp('kind') == 'circular'
      ? CircularProgressIndicator(value: value)
      : LinearProgressIndicator(value: value);
}

Widget _buildImage(BuildContext context, UiNode node, RenderContext ctx) {
  final width = node.numProp('width')?.toDouble();
  final height = node.numProp('height')?.toDouble();
  final fit = switch (node.stringProp('fit')) {
    'cover' => BoxFit.cover,
    'fill' => BoxFit.fill,
    'fitWidth' => BoxFit.fitWidth,
    'fitHeight' => BoxFit.fitHeight,
    _ => BoxFit.contain,
  };
  Widget errorBuilder(BuildContext context, Object error, StackTrace? trace) {
    return SizedBox(
      width: width,
      height: height,
      child: Center(
        child: Icon(Icons.broken_image_outlined,
            color: Theme.of(context).disabledColor),
      ),
    );
  }

  final dataUri = node.stringProp('dataUri');
  if (dataUri != null && dataUri.startsWith('data:')) {
    final comma = dataUri.indexOf(',');
    if (comma > 0) {
      try {
        final bytes = base64Decode(dataUri.substring(comma + 1));
        return Image.memory(bytes, width: width, height: height, fit: fit);
      } catch (_) {}
    }
  }
  final src = node.stringProp('src');
  if (src == null || src.isEmpty) {
    return errorBuilder(context, 'missing src', null);
  }
  return Image.network(src,
      width: width, height: height, fit: fit, errorBuilder: errorBuilder);
}

Widget _buildFigure(BuildContext context, UiNode node, RenderContext ctx) {
  final color =
      parseColor(node.props['color']) ?? Theme.of(context).disabledColor;
  final width = node.numProp('width')?.toDouble() ?? 64;
  final height = node.numProp('height')?.toDouble() ?? 64;
  switch (node.stringProp('shape')) {
    case 'circle':
      return Container(
        width: width,
        height: height,
        decoration: BoxDecoration(shape: BoxShape.circle, color: color),
      );
    case 'triangle':
      return CustomPaint(
        size: Size(width, height),
        painter: _TrianglePainter(color),
      );
    default:
      return Container(width: width, height: height, color: color);
  }
}

class _TrianglePainter extends CustomPainter {
  const _TrianglePainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()..color = color;
    final path = Path()
      ..moveTo(size.width / 2, 0)
      ..lineTo(size.width, size.height)
      ..lineTo(0, size.height)
      ..close();
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(_TrianglePainter oldDelegate) => oldDelegate.color != color;
}

const List<Color> _chartPalette = [
  Color(0xFF7E57C2),
  Color(0xFF26A69A),
  Color(0xFFFF7043),
  Color(0xFF42A5F5),
  Color(0xFFEC407A),
  Color(0xFF9CCC65),
];

List<Map<String, dynamic>> _chartItems(UiNode node) {
  final out = <Map<String, dynamic>>[];
  for (final source in [node.listProp('items'), node.listProp('series')]) {
    if (source == null) continue;
    for (final raw in source) {
      final map = asMap(raw);
      if (map != null) out.add(map);
    }
  }
  return out;
}

List<double> _seriesPoints(Map<String, dynamic> series) {
  final raw = series['points'] ?? series['values'];
  return [
    if (raw is List)
      for (final item in raw)
        if (item is num) item.toDouble(),
  ];
}

Widget _buildChartLine(BuildContext context, UiNode node, RenderContext ctx) {
  final series = _chartItems(node);
  return SizedBox(
    height: 160,
    child: CustomPaint(
      painter: _LineChartPainter([
        for (var i = 0; i < series.length; i++)
          _LineSeries(
            color: parseColor(series[i]['color']) ??
                _chartPalette[i % _chartPalette.length],
            points: _seriesPoints(series[i]),
          ),
      ]),
    ),
  );
}

class _LineSeries {
  const _LineSeries({required this.color, required this.points});

  final Color color;
  final List<double> points;
}

class _LineChartPainter extends CustomPainter {
  const _LineChartPainter(this.series);

  final List<_LineSeries> series;

  @override
  void paint(Canvas canvas, Size size) {
    final axis = Paint()
      ..color = const Color(0xFF9E9E9E)
      ..strokeWidth = 1;
    canvas.drawLine(Offset.zero, Offset(0, size.height), axis);
    canvas.drawLine(
        Offset(0, size.height), Offset(size.width, size.height), axis);
    for (final line in series) {
      if (line.points.length < 2) continue;
      var min = line.points.first;
      var max = line.points.first;
      for (final point in line.points) {
        min = math.min(min, point);
        max = math.max(max, point);
      }
      final span = max - min == 0 ? 1 : max - min;
      final paint = Paint()
        ..color = line.color
        ..strokeWidth = 2
        ..style = PaintingStyle.stroke;
      final path = Path();
      for (var i = 0; i < line.points.length; i++) {
        final x = size.width * i / (line.points.length - 1);
        final y = size.height - ((line.points[i] - min) / span) * size.height;
        if (i == 0) {
          path.moveTo(x, y);
        } else {
          path.lineTo(x, y);
        }
      }
      canvas.drawPath(path, paint);
    }
  }

  @override
  bool shouldRepaint(_LineChartPainter oldDelegate) =>
      oldDelegate.series != series;
}

Widget _buildChartBar(BuildContext context, UiNode node, RenderContext ctx) {
  final items = _chartItems(node);
  var max = 0.0;
  for (final item in items) {
    final value = item['value'];
    if (value is num) max = math.max(max, value.toDouble());
  }
  if (max == 0) max = 1;
  return Row(
    crossAxisAlignment: CrossAxisAlignment.end,
    children: [
      for (var i = 0; i < items.length; i++)
        Expanded(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  height: (items[i]['value'] is num
                          ? (items[i]['value'] as num).toDouble()
                          : 0) /
                      max *
                      100,
                  width: 24,
                  color: parseColor(items[i]['color']) ??
                      _chartPalette[i % _chartPalette.length],
                ),
                Text('${items[i]['label'] ?? ''}',
                    style: Theme.of(context).textTheme.bodySmall),
              ],
            ),
          ),
        ),
    ],
  );
}

Widget _buildChartPie(BuildContext context, UiNode node, RenderContext ctx) {
  final items = _chartItems(node);
  return Wrap(
    spacing: 12,
    runSpacing: 8,
    children: [
      for (var i = 0; i < items.length; i++)
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 12,
              height: 12,
              color: parseColor(items[i]['color']) ??
                  _chartPalette[i % _chartPalette.length],
            ),
            const SizedBox(width: 4),
            Text('${items[i]['label'] ?? ''}: ${items[i]['value'] ?? ''}'),
          ],
        ),
    ],
  );
}

Widget _buildDrawer(BuildContext context, UiNode node, RenderContext ctx) {
  final title = node.stringProp('title');
  return Container(
    decoration: BoxDecoration(
      border: Border.all(color: Theme.of(context).dividerColor),
      borderRadius: BorderRadius.circular(8),
    ),
    padding: const EdgeInsets.all(12),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (title != null && title.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(title,
                style: const TextStyle(fontWeight: FontWeight.bold)),
          ),
        ...buildChildren(context, node, ctx),
      ],
    ),
  );
}
