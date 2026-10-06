import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `split` (§2.6, contract level 3): `first`, `second`, `axis?`
/// (`horizontal`|`vertical`, default `horizontal`), `initial?`, `min?`,
/// `max?`, `minSecond?`, `persistKey?`, `handleStyle?` (`rail`|`grip`|
/// `invisible`, default `rail`).
///
/// A resizable two-pane layout — the resizable sidebar/panel split upstream
/// gets, with the real metrics: dragging the handle (mouse and touch) moves
/// the divider live, clamped to `min`/`max` and to `minSecond` (the second
/// pane can never shrink below it — the first pane cannot grow past
/// `extent − minSecond`), and the position persists to the client store
/// under `persistKey` at drag end — one write per interaction, not one per
/// frame (the upstream commit-on-drag-end rule). The handle resizes by
/// arrow keys in 16 px steps when focused. A divider change outside a drag
/// (restore, keyboard, snap) animates over `motion.panel` with the
/// `easeDrawer` curve; `motion.panel` defaults to 0, so the render is
/// instant unless the payload raises it.
///
/// Defaults come from the layout token family: `initial` falls back to
/// `layout.sidebarWidth` (256), `min` to `layout.sidebarMinWidth` (208) and
/// `minSecond` to `layout.mainMinWidth` (640) — the upstream thread sidebar
/// numbers (upstream default 16×16 = 256, min 13×16 = 208, main-min
/// 40×16 = 640; the dynamic upstream maximum, viewport − main-min, is the
/// `minSecond` clamp here). A missing pane degrades visibly (§8.3); an
/// unknown axis or handle style degrades to the default.
Widget buildSplit(BuildContext context, UiNode node, RenderContext ctx) =>
    _SplitView(node: node, ctx: ctx);

/// The grip handle visual (T90/T106): the 1 px divider line that brightens
/// on hover — the upstream right-panel handle. Shared by `split`'s grip mode
/// and the terminal drawer's resize grip (the T106 reuse).
Widget gripHandleVisual(BuildContext context,
    {required bool vertical, required bool hovering}) {
  final material = JhinDesignScope.materialOf(context);
  final lineColor =
      hovering ? material.colorScheme.primary : material.dividerColor;
  return Center(
    child: Container(
      width: vertical ? double.infinity : 1.0,
      height: vertical ? 1.0 : double.infinity,
      color: lineColor,
    ),
  );
}

/// The arrow-key resize step (the T90 spec: 16 px).
const double _keyboardStep = 16;

/// The drag-handle hit extent: 16 px for the rail and the invisible handle
/// (the upstream rail is `w-4`), 8 px for the grip (the upstream
/// right-panel handle is `w-2`).
const double _railHit = 16;
const double _gripHit = 8;

double? _px(Object? value) {
  if (value is num && value >= 0) return value.toDouble();
  if (value is String) {
    final parsed = double.tryParse(value);
    if (parsed != null && parsed >= 0) return parsed;
  }
  return null;
}

class _SplitView extends StatefulWidget {
  const _SplitView({required this.node, required this.ctx});

  final UiNode node;
  final RenderContext ctx;

  @override
  State<_SplitView> createState() => _SplitViewState();
}

class _SplitViewState extends State<_SplitView> {
  /// The live divider extent (px from the leading edge); null until the
  /// persisted value (if any) has been read — the node `initial` renders
  /// meanwhile.
  double? _width;

  /// Whether a drag is in progress (a drag renders without the motion
  /// transition so the divider tracks the pointer exactly).
  bool _dragging = false;

  /// Whether the pointer hovers the handle (the rail line reveals on
  /// hover, like the upstream `hover:after:bg-sidebar-border`).
  bool _hovering = false;

  double _dragStartWidth = 0;
  double _dragStartPos = 0;

  /// The main-axis extent of the split from the last layout pass — the
  /// clamp's `extent − minSecond` term for events arriving between builds.
  double _extent = double.infinity;

  String? _restoredKey;
  bool _restoreInFlight = false;
  final FocusNode _handleFocus = FocusNode();

  @override
  void initState() {
    super.initState();
    _scheduleRestore();
  }

  @override
  void didUpdateWidget(covariant _SplitView old) {
    super.didUpdateWidget(old);
    if (widget.node.stringProp('persistKey') != _restoredKey) {
      _scheduleRestore();
    }
  }

  @override
  void dispose() {
    _handleFocus.dispose();
    super.dispose();
  }

  // --- props -------------------------------------------------------------

  String? get _persistKey {
    final key = widget.node.stringProp('persistKey');
    return key == null || key.isEmpty ? null : key;
  }

  bool get _vertical =>
      widget.node.stringProp('axis')?.toLowerCase() == 'vertical';

  String get _handleStyle {
    final raw = widget.node.stringProp('handleStyle');
    return const {'rail', 'grip', 'invisible'}.contains(raw) ? raw! : 'rail';
  }

  /// `min` — the token default is `layout.sidebarMinWidth` (208).
  double get _min =>
      _px(widget.node.props['min']) ?? _layoutToken('sidebarMinWidth', 208);

  /// `minSecond` — the token default is `layout.mainMinWidth` (640).
  double get _minSecond =>
      _px(widget.node.props['minSecond']) ?? _layoutToken('mainMinWidth', 640);

  /// `max` — absent or degenerate means unbounded; the `minSecond` clamp
  /// applies regardless.
  double? get _maxProp => _px(widget.node.props['max']);

  /// `initial` — the token default is `layout.sidebarWidth` (256).
  double get _initial =>
      _px(widget.node.props['initial']) ?? _layoutToken('sidebarWidth', 256);

  double _layoutToken(String key, double fallback) {
    final raw = JhinDesignScope.of(context).tokens.surface.value('layout', key);
    return raw is num && raw >= 0 ? raw.toDouble() : fallback;
  }

  /// The effective first-pane clamp at [extent]: `[min, hi]` with
  /// `hi = min(max, extent − minSecond)` — never below `min` (a drag below
  /// `min` leaves the divider at `min`, the asserted clamp).
  ({double lo, double hi}) _boundsAt(double extent) {
    final lo = _min;
    var hi = _maxProp ?? double.infinity;
    final secondCap = extent - _minSecond;
    if (secondCap < hi) hi = secondCap;
    if (hi < lo) hi = lo;
    return (lo: lo, hi: hi);
  }

  double _clamp(double value, {double? extent}) {
    final bounds = _boundsAt(extent ?? _extent);
    return value.clamp(bounds.lo, bounds.hi);
  }

  // --- persistence -------------------------------------------------------

  void _scheduleRestore() {
    final key = _persistKey;
    final read = widget.ctx.readPersisted;
    if (key == null || read == null || _restoreInFlight) return;
    _restoreInFlight = true;
    _restoredKey = key;
    Future<void>(() async {
      final stored = await read(key);
      _restoreInFlight = false;
      if (!mounted) return;
      final value = stored is num
          ? stored.toDouble()
          : (stored is String ? double.tryParse(stored) : null);
      if (value == null || value < 0) return;
      setState(() => _width = _clamp(value));
    });
  }

  void _persist(double width) {
    final key = _persistKey;
    final write = widget.ctx.writePersisted;
    if (key == null || write == null) return;
    Future<void>(() => write(key, width));
  }

  // --- interaction -------------------------------------------------------

  void _dragStart(DragStartDetails details) {
    setState(() {
      _dragging = true;
      _dragStartWidth = _clamp(_width ?? _initial);
      _dragStartPos =
          _vertical ? details.globalPosition.dy : details.globalPosition.dx;
      _width = _dragStartWidth;
    });
  }

  void _dragUpdate(DragUpdateDetails details) {
    final delta = _vertical
        ? details.globalPosition.dy - _dragStartPos
        : details.globalPosition.dx - _dragStartPos;
    setState(() {
      _width = _clamp(_dragStartWidth + delta);
    });
  }

  void _dragEnd([DragEndDetails? details]) {
    if (!_dragging) return;
    setState(() => _dragging = false);
    _persist(_width ?? _initial);
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final increase = _vertical
        ? event.logicalKey == LogicalKeyboardKey.arrowDown
        : event.logicalKey == LogicalKeyboardKey.arrowRight;
    final decrease = _vertical
        ? event.logicalKey == LogicalKeyboardKey.arrowUp
        : event.logicalKey == LogicalKeyboardKey.arrowLeft;
    if (!increase && !decrease) return KeyEventResult.ignored;
    final current = _width ?? _initial;
    final next =
        _clamp(current + (increase ? _keyboardStep : -_keyboardStep));
    if (next == current) return KeyEventResult.handled;
    setState(() => _width = next);
    _persist(next);
    return KeyEventResult.handled;
  }

  // --- build -------------------------------------------------------------

  Widget _pane(UiNode? node, String missing) => node == null
      ? degradedBox(context, missing)
      : widget.ctx.build(context, node);

  /// The hit extent of the handle along the divider axis.
  double get _hit => _handleStyle == 'grip' ? _gripHit : _railHit;

  /// The drag handle: mouse and touch (and stylus) through a raw drag
  /// recognizer — [GestureDetector] alone ignores mouse drags — with the
  /// keyboard surface and the style visuals on top.
  Widget _handle() {
    final style = _handleStyle;
    final material = JhinDesignScope.materialOf(context);
    final isGrip = style == 'grip';
    final showLine = isGrip || (style == 'rail' && _hovering);
    final lineColor = isGrip
        ? (_hovering ? material.colorScheme.primary : material.dividerColor)
        : material.hoverColor;
    final cursor = _vertical
        ? SystemMouseCursors.resizeUpDown
        : SystemMouseCursors.resizeLeftRight;

    // The rail reveals a 2px line on hover (the upstream
    // `hover:after:bg-sidebar-border`), the grip keeps a 1px divider line
    // that brightens on hover (the upstream right-panel handle), the
    // invisible handle paints nothing.
    final visuals = showLine
        ? (isGrip
            ? gripHandleVisual(context, vertical: _vertical, hovering: _hovering)
            : Center(
                child: Container(
                  width: _vertical ? double.infinity : 2.0,
                  height: _vertical ? 2.0 : double.infinity,
                  color: lineColor,
                ),
              ))
        : const SizedBox.shrink();

    final hitArea = RawGestureDetector(
      behavior: HitTestBehavior.opaque,
      gestures: {
        if (_vertical)
          VerticalDragGestureRecognizer:
              _dragFactory<VerticalDragGestureRecognizer>(
                  () => VerticalDragGestureRecognizer(
                      supportedDevices: _dragDevices))
        else
          HorizontalDragGestureRecognizer:
              _dragFactory<HorizontalDragGestureRecognizer>(
                  () => HorizontalDragGestureRecognizer(
                      supportedDevices: _dragDevices)),
      },
      child: MouseRegion(
        cursor: cursor,
        onEnter: (_) => setState(() => _hovering = true),
        onExit: (_) => setState(() => _hovering = false),
        child: visuals,
      ),
    );
    return Semantics(
      label: 'Resize divider',
      hint: 'Arrow keys resize by ${_keyboardStep.round()} px',
      child: Focus(
        focusNode: _handleFocus,
        onKeyEvent: _onKey,
        child: hitArea,
      ),
    );
  }

  /// The pointer kinds the drag recognizer accepts (mouse + touch + stylus).
  static const Set<PointerDeviceKind> _dragDevices = {
    PointerDeviceKind.mouse,
    PointerDeviceKind.touch,
    PointerDeviceKind.stylus,
  };

  /// The recognizer factory wiring the drag callbacks for one axis.
  GestureRecognizerFactory<T> _dragFactory<T extends DragGestureRecognizer>(
          T Function() create) =>
      GestureRecognizerFactoryWithHandlers<T>(create, (instance) {
        instance
          ..dragStartBehavior = DragStartBehavior.down
          ..onStart = _dragStart
          ..onUpdate = _dragUpdate
          ..onEnd = _dragEnd
          ..onCancel = () => _dragEnd();
      });

  @override
  Widget build(BuildContext context) {
    final node = widget.node;
    final firstRaw = node.props['first'];
    final secondRaw = node.props['second'];
    final firstNode = firstRaw is Map ? UiNode.fromJson(firstRaw) : null;
    final secondNode = secondRaw is Map ? UiNode.fromJson(secondRaw) : null;
    if (firstNode == null || secondNode == null) {
      return degradedBox(
        context,
        firstNode == null ? 'Missing first pane' : 'Missing second pane',
      );
    }
    final design = JhinDesignScope.of(context);
    final panel = design.tokens.motion.panel;
    final curve = jhinEaseDrawerCurve(design.tokens.surface);

    return LayoutBuilder(builder: (context, constraints) {
      final extent =
          _vertical ? constraints.maxHeight : constraints.maxWidth;
      _extent = extent.isFinite ? extent : double.infinity;
      final bounds = _boundsAt(_extent);
      final width = (_width ?? _initial).clamp(bounds.lo, bounds.hi);
      _width = width;

      // The transition rides `motion.panel` + `easeDrawer` for every
      // non-drag change (restore, keyboard, snap); a drag tracks instantly.
      final first = AnimatedContainer(
        duration: _dragging ? Duration.zero : panel,
        curve: curve,
        width: _vertical ? null : width,
        height: _vertical ? width : null,
        child: _pane(firstNode, 'Missing first pane'),
      );
      final second = Expanded(
        child: _pane(secondNode, 'Missing second pane'),
      );
      // The handle overlays the divider like the upstream rail and the
      // right-panel handle (both absolutely positioned) — it consumes no
      // layout extent, so the second pane is exactly `extent − width` and
      // `minSecond` holds to the pixel.
      final layout = _vertical
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [first, second],
            )
          : Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [first, second],
            );
      final hit = _hit;
      return Stack(
        children: [
          Positioned.fill(child: layout),
          PositionedDirectional(
            top: _vertical ? width - hit / 2 : 0,
            bottom: _vertical ? extent - width - hit / 2 : 0,
            start: _vertical ? 0 : width - hit / 2,
            end: _vertical ? 0 : extent - width - hit / 2,
            child: _handle(),
          ),
        ],
      );
    });
  }
}

