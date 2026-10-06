import 'dart:math' as math;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../expr.dart' show evalWhen;
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart' show insetAll;
import 'scroll_fade.dart'
    show kScrollFadeTopbarAlphas, kScrollFadeTopbarStops, scrollFadeBandMask;
import 'split.dart' show gripHandleVisual;

/// `shell` (§2.6): `sidebar?`, `header?`, `body?`, `detail?`, `rail?`,
/// `topbar?`, `topbarCompact?`, `pageHeader?`, `terminal?`, `stageBackdrop?`,
/// `breakpoint?` (default 768 — the T95 fixed responsive breakpoint),
/// `sidebarWidth?` (default `$size.sidebar`, 280), `sidebarCollapsedWidth?`
/// (default 56), `collapsible?`, `collapsed?` (patchable via the node `id`).
///
/// The T95 chrome: the `topbar` slot renders as the fixed-height workspace
/// top bar (the `layout.topbarHeight` token, 52) padded by the workspace
/// gutters (`space.workspaceGutter`, the `sm` step 1.25rem wide, 0.5rem
/// below the breakpoint) plus the safe-area insets (`pl-safe`/`pr-safe`);
/// the body content under it wears the seven-stop topbar scroll fade (the
/// `topbar-scroll-fade` recipe, T92's band constants). `pageHeader` is the
/// title + actions row above the body; `terminal` the optional drawer below
/// the body row (its grip is visual chrome; below the breakpoint it caps at
/// 40% of the viewport height); `stageBackdrop` paints the `theme.stageArt`
/// gradient behind the sidebar under the sidebar-stage fade mask.
///
/// At or above the breakpoint the sidebar sits beside the content at its
/// expanded (or collapsed) width — the open/close rides `motion.panel` over
/// the `easeDrawer` curve (reduced motion collapses the duration to 0).
/// Below it the sidebar overlays as a drawer (`openMobile` state, backdrop,
/// tap or swipe to close), the right panel is hidden and the topbar swaps to
/// `topbarCompact` (the breadcrumb condensed to the current title). A shell
/// without `body` degrades to a card with "Missing body" (§2.6). `collapsed`
/// is honoured whenever it is `true`; `collapsible` adds the sidebar
/// collapse toggle.
Widget buildShell(BuildContext context, UiNode node, RenderContext ctx) =>
    _ShellView(node: node, ctx: ctx);

UiNode? _slot(UiNode node, String key) {
  final raw = node.props[key];
  return raw is Map ? UiNode.fromJson(raw) : null;
}

double _widthProp(UiNode node, String key, double fallback) {
  final raw = node.props[key];
  if (raw is num) return raw.toDouble();
  if (raw is String) {
    final parsed = num.tryParse(raw);
    if (parsed != null) return parsed.toDouble();
  }
  return fallback;
}

/// The narrow gutter (plan T95 step 7): 0.5rem at the resolved interface
/// size.
double _narrowGutter(JhinTheme design) => 0.5 * design.switches.fontSizes.sizeInterface;

/// The wide gutter: the `sm` step of `space.workspaceGutter` (1.25rem), rem
/// scaled. The `{base, sm}` map's `sm` entry is the layout concern the shell
/// owns (the token `resolve` collapses to `base`).
double _wideGutter(JhinTheme design) {
  final rem = design.switches.fontSizes.sizeInterface.toDouble();
  final raw = design.tokens.surface.value('space', 'workspaceGutter');
  if (raw is Map) {
    final sm = parseCssLength(raw['sm'], remPx: rem);
    if (sm != null) return sm;
  }
  return parseCssLength(raw, remPx: rem) ?? 1.25 * rem;
}

class _ShellView extends StatefulWidget {
  const _ShellView({required this.node, required this.ctx});

  final UiNode node;
  final RenderContext ctx;

  @override
  State<_ShellView> createState() => _ShellViewState();
}

class _ShellViewState extends State<_ShellView> {
  late bool _collapsed = widget.node.boolProp('collapsed') == true;

  /// The narrow drawer state (`openMobile`): the sidebar overlays with a
  /// backdrop until a tap or a swipe closes it.
  bool _openMobile = false;

  @override
  void didUpdateWidget(covariant _ShellView old) {
    super.didUpdateWidget(old);
    final overlay =
        widget.node.id == null ? null : widget.ctx.patches[widget.node.id];
    var next = _collapsed;
    var changed = false;
    if (overlay != null && overlay.containsKey('collapsed')) {
      next = overlay['collapsed'] == true;
      changed = true;
    } else if (widget.node.props['collapsed'] != old.node.props['collapsed']) {
      next = widget.node.boolProp('collapsed') == true;
      changed = true;
    }
    if (changed && next != _collapsed) {
      setState(() => _collapsed = next);
    }
  }

  void _toggleCollapsed() {
    setState(() => _collapsed = !_collapsed);
    final id = widget.node.id;
    if (id != null) {
      widget.ctx.patch(id, {'collapsed': _collapsed});
    }
  }

  void _openDrawer() => setState(() => _openMobile = true);

  void _closeDrawer() => setState(() => _openMobile = false);

  @override
  Widget build(BuildContext context) {
    final node = widget.node;
    final ctx = widget.ctx;
    final bodyNode = _slot(node, 'body');
    if (bodyNode == null) {
      return _missingBody(context);
    }
    final design = JhinDesignScope.of(context);
    final tokens = design.tokens;
    final width = MediaQuery.sizeOf(context).width;
    final breakpoint = node.numProp('breakpoint')?.toDouble() ?? 768;
    final sidebarWidth = _widthProp(node, 'sidebarWidth', tokens.sidebarWidth);
    final collapsedWidth =
        _widthProp(node, 'sidebarCollapsedWidth', 56);
    final sidebarNode = _slot(node, 'sidebar');
    final headerNode = _slot(node, 'header');
    final detailNode = _slot(node, 'detail');
    final railNode = _slot(node, 'rail');
    final topbarWide = _slot(node, 'topbar');
    final topbarCompact = _slot(node, 'topbarCompact');
    final pageHeaderNode = _slot(node, 'pageHeader');
    final terminalNode = _slot(node, 'terminal');
    final stageBackdrop = node.boolProp('stageBackdrop') == true;

    final narrow = width < breakpoint;
    final topbarNode = narrow ? (topbarCompact ?? topbarWide) : topbarWide;
    // The legacy `header` slot below the breakpoint: consumed by the top
    // bar row (the T65 behaviour — hamburger + header, no fixed height)
    // unless a T95 top bar slot already occupies it.
    final headerInBar = narrow && topbarNode == null && headerNode != null;
    final gutter = narrow ? _narrowGutter(design) : _wideGutter(design);
    final topbarHeight =
        (design.resolve('layout', 'topbarHeight') as num?)?.toDouble() ?? 52;
    // The panel animation: `motion.panel` over the `easeDrawer` curve;
    // reduced motion collapses the duration to 0 (the scope does it).
    final panel = tokens.motion.panel;
    final curve = jhinEaseDrawerCurve(tokens.surface);

    final body = ctx.build(context, bodyNode);
    // Below the breakpoint the right panel is hidden by default (T95).
    final detail = narrow ? null : (detailNode == null ? null : ctx.build(context, detailNode));
    final main = Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(flex: 2, child: body),
        if (detail != null) Expanded(flex: 1, child: detail),
      ],
    );

    final content = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (headerNode != null && !headerInBar) ctx.build(context, headerNode),
        if (pageHeaderNode != null)
          Padding(
            padding: EdgeInsets.only(
              left: gutter + _safeInset(context, left: true),
              right: gutter + _safeInset(context, right: true),
            ),
            child: ctx.build(context, pageHeaderNode),
          ),
        Expanded(
          // The topbar scroll fade: the seven-stop band over the content
          // under the top bar (the upstream timeline wears it unconditionally).
          child: topbarNode == null
              ? main
              : _TopbarFade(height: 24, child: main),
        ),
        if (terminalNode != null)
          _terminalDrawer(context, terminalNode, narrow),
      ],
    );

    if (narrow) {
      return Material(
        type: MaterialType.transparency,
        child: _narrow(
          context,
          design: design,
          sidebarNode: sidebarNode,
          railNode: railNode,
          topbarNode: topbarNode,
          headerInBar: headerInBar,
          headerNode: headerNode,
          topbarHeight: topbarHeight,
          gutter: gutter,
          panel: panel,
          curve: curve,
          content: content,
        ),
      );
    }

    final sidebar = sidebarNode == null
        ? null
        : _sidebarPane(
            context,
            design: design,
            node: node,
            sidebarNode: sidebarNode,
            width: _collapsed ? collapsedWidth : sidebarWidth,
            panel: panel,
            curve: curve,
            stageBackdrop: stageBackdrop,
          );
    return Material(
      type: MaterialType.transparency,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (topbarNode != null)
            SizedBox(
              height: topbarHeight,
              child: Padding(
                padding: EdgeInsets.only(
                  left: gutter + _safeInset(context, left: true),
                  right: gutter + _safeInset(context, right: true),
                ),
                child: ctx.build(context, topbarNode),
              ),
            ),
          Expanded(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (railNode != null) ctx.build(context, railNode),
                ?sidebar,
                Expanded(child: content),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// The safe-area inset of one horizontal side (`pl-safe`/`pr-safe`,
  /// index.css:1037-1042): `max(env(safe-area-inset-*), 0px)`.
  double _safeInset(BuildContext context, {bool left = false, bool right = false}) {
    final padding = MediaQuery.paddingOf(context);
    final value = left ? padding.left : padding.right;
    return value.isFinite && value > 0 ? value : 0;
  }

  /// The wide sidebar pane: the stage backdrop behind it, the collapse
  /// toggle above, the width animating over `motion.panel` + `easeDrawer`.
  Widget _sidebarPane(
    BuildContext context, {
    required JhinTheme design,
    required UiNode node,
    required UiNode sidebarNode,
    required double width,
    required Duration panel,
    required Curve curve,
    required bool stageBackdrop,
  }) {
    final ctx = widget.ctx;
    final content = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (node.boolProp('collapsible') == true)
          Align(
            alignment: Alignment.centerRight,
            child: IconButton(
              icon: Icon(_collapsed
                  ? Icons.chevron_right
                  : Icons.chevron_left),
              tooltip: _collapsed ? 'Expand sidebar' : 'Collapse sidebar',
              onPressed: _toggleCollapsed,
            ),
          ),
        Expanded(child: ctx.build(context, sidebarNode)),
      ],
    );
    // The stage backdrop paints behind the sidebar content (T95); without
    // it the pane is the plain column (the T65 golden path, byte-identical).
    final pane = stageBackdrop
        ? Stack(
            children: [
              Positioned.fill(child: _StageBackdrop(design: design)),
              Positioned.fill(child: content),
            ],
          )
        : content;
    // The open/close rides `motion.panel` + `easeDrawer`; the default 0 ms
    // keeps the plain box (no animation machinery, the T65 goldens hold).
    if (panel <= Duration.zero) {
      return SizedBox(width: width, child: pane);
    }
    return AnimatedContainer(
      duration: panel,
      curve: curve,
      width: width,
      child: pane,
    );
  }

  /// The terminal drawer below the body row: the visual grip above the
  /// server-authored content; below the breakpoint the drawer caps at 40% of
  /// the viewport height (plan T95 step 7). The drawer height is the
  /// terminal node's `height` prop when it carries one, 240 otherwise.
  ///
  /// A terminal node carrying a `persistKey` (the T106 drawer) owns its own
  /// resize grip and persistence: the client renders [_TerminalDrawer],
  /// which drags between `minDrawerHeight` and `maxDrawerRatio` of the
  /// viewport and persists under the key. The node's `when` gates the whole
  /// drawer (grip included).
  Widget _terminalDrawer(BuildContext context, UiNode terminalNode, bool narrow) {
    final when = terminalNode.when;
    if (when != null && evalWhen(when, widget.ctx.state) == false) {
      return const SizedBox.shrink();
    }
    if (terminalNode.stringProp('persistKey') != null) {
      return _TerminalDrawer(node: terminalNode, ctx: widget.ctx);
    }
    final theme = JhinDesignScope.materialOf(context);
    var drawerHeight = terminalNode.numProp('height')?.toDouble() ?? 240;
    if (narrow) {
      drawerHeight =
          math.min(drawerHeight, MediaQuery.sizeOf(context).height * 0.4);
    }
    return SizedBox(
      height: drawerHeight,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              margin: const EdgeInsets.symmetric(vertical: 4),
              width: 32,
              height: 4,
              decoration: BoxDecoration(
                color: theme.colorScheme.outlineVariant,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          Expanded(child: widget.ctx.build(context, terminalNode)),
        ],
      ),
    );
  }

  /// Below the breakpoint the sidebar overlays as a drawer: the `openMobile`
  /// state, a fading backdrop (tap to close), a swipe on the panel edge and
  /// the slide-in over `motion.panel` + `easeDrawer`. A hamburger in the
  /// top bar (or a slim bar when the shell has none) opens it. The T95 top
  /// bar slots render at the fixed height with the gutters; the legacy
  /// `header` slot keeps the unconstrained T65 row.
  Widget _narrow(
    BuildContext context, {
    required JhinTheme design,
    required UiNode? sidebarNode,
    required UiNode? railNode,
    required UiNode? topbarNode,
    required bool headerInBar,
    required UiNode? headerNode,
    required double topbarHeight,
    required double gutter,
    required Duration panel,
    required Curve curve,
    required Widget content,
  }) {
    final ctx = widget.ctx;
    final theme = JhinDesignScope.materialOf(context);
    final hamburger = Builder(
      builder: (context) => IconButton(
        icon: const Icon(Icons.menu),
        tooltip: 'Open navigation',
        onPressed: _openDrawer,
      ),
    );
    final Widget bar;
    if (topbarNode != null) {
      bar = SizedBox(
        height: topbarHeight,
        child: Padding(
          padding: EdgeInsets.only(
            left: _safeInset(context, left: true),
            right: gutter + _safeInset(context, right: true),
          ),
          child: Row(
            children: [
              hamburger,
              Expanded(child: ctx.build(context, topbarNode)),
            ],
          ),
        ),
      );
    } else if (headerInBar && headerNode != null) {
      bar = Row(
        children: [
          hamburger,
          Expanded(child: ctx.build(context, headerNode)),
        ],
      );
    } else {
      bar = SizedBox(
        height: 48,
        child: Align(alignment: Alignment.centerLeft, child: hamburger),
      );
    }
    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        bar,
        Expanded(child: content),
      ],
    );
    final stack = railNode == null
        ? body
        : Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [ctx.build(context, railNode), Expanded(child: body)],
          );
    if (sidebarNode == null) {
      return stack;
    }
    final sidebarWidth = _widthProp(
        widget.node, 'sidebarWidth', design.tokens.sidebarWidth);
    return Stack(
      children: [
        stack,
        // The backdrop: fades in over `motion.panel`, tap closes.
        Positioned.fill(
          child: IgnorePointer(
            ignoring: !_openMobile,
            child: AnimatedOpacity(
              duration: panel,
              opacity: _openMobile ? 1 : 0,
              child: GestureDetector(
                onTap: _closeDrawer,
                child: ColoredBox(
                  color: theme.colorScheme.scrim.withValues(alpha: 0.54),
                ),
              ),
            ),
          ),
        ),
        // The overlay panel: slides in from the leading edge; a swipe left
        // past a third of the width closes it.
        AnimatedPositioned(
          duration: panel,
          curve: curve,
          left: _openMobile ? 0 : -sidebarWidth,
          top: 0,
          bottom: 0,
          width: sidebarWidth,
          child: GestureDetector(
            onHorizontalDragEnd: (details) {
              if (details.primaryVelocity != null &&
                  details.primaryVelocity! < 100) {
                _closeDrawer();
              }
            },
            child: Material(
              elevation: 16,
              color: theme.colorScheme.surfaceContainerLow,
              child: ctx.build(context, sidebarNode),
            ),
          ),
        ),
      ],
    );
  }

  Widget _missingBody(BuildContext context) {
    final theme = JhinDesignScope.materialOf(context);
    final tokens = JhinDesignScope.of(context).tokens;
    return Card(
      child: Padding(
        padding: insetAll(tokens.spacing.md),
        child: Text('Missing body', style: TextStyle(color: theme.disabledColor)),
      ),
    );
  }
}

/// The topbar scroll fade (T95): the static seven-stop band of the
/// `topbar-scroll-fade` recipe over the content's top edge — the same mask
/// constants the `scroll_fade` `topbar` mode paints (T92), applied by the
/// shell whenever a top bar is present.
class _TopbarFade extends StatelessWidget {
  const _TopbarFade({required this.height, required this.child});

  final double height;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ShaderMask(
      blendMode: BlendMode.dstIn,
      shaderCallback: (bounds) {
        final mask = scrollFadeBandMask(
          bandStops: kScrollFadeTopbarStops,
          bandAlphas: kScrollFadeTopbarAlphas,
          fraction: bounds.height <= 0 ? 1.0 : height / bounds.height,
          trailing: false,
        );
        return LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: mask.colors,
          stops: mask.stops,
        ).createShader(bounds);
      },
      child: child,
    );
  }
}

/// The sidebar stage backdrop (T95): the `SidebarStageBackdrop` equivalent —
/// the vertical gradient of the `theme.stageArt` tokens (deep at the top
/// edge so the wordmark keeps contrast, upstream `DevBlueprintArt`'s paper
/// gradient), the highlight band at the top edge, the line-colored rule at
/// the art's bottom edge, all dissolving into the sidebar surface through
/// the `--sidebar-stage-fade` mask (a dstIn ramp over the lower half).
class _StageBackdrop extends StatelessWidget {
  const _StageBackdrop({required this.design});

  final JhinTheme design;

  /// The art height: the upstream `h-20` band (80 px).
  static const double _artHeight = 80;

  Color? _art(String suffix) => design.stageArt['stage-art-$suffix'];

  @override
  Widget build(BuildContext context) {
    final top = _art('top');
    final mid = _art('mid');
    final bottom = _art('bottom');
    final highlight = _art('highlight');
    final line = _art('line');
    if (top == null || mid == null || bottom == null) {
      return const SizedBox.shrink();
    }
    return ShaderMask(
      blendMode: BlendMode.dstIn,
      shaderCallback: (bounds) => const LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [
          Color.fromRGBO(255, 255, 255, 1),
          Color.fromRGBO(255, 255, 255, 1),
          Color.fromRGBO(255, 255, 255, 0),
        ],
        stops: [0.0, 0.5, 1.0],
      ).createShader(bounds),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            height: _artHeight,
            child: CustomPaint(
              painter: _StageBackdropPainter(
                top: top,
                mid: mid,
                bottom: bottom,
                highlight: highlight,
                line: line,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The gradient painter: the paper ramp (bottom → mid → top over the band),
/// the highlight band at the top edge and the line-colored rule at the
/// bottom edge.
class _StageBackdropPainter extends CustomPainter {
  const _StageBackdropPainter({
    required this.top,
    required this.mid,
    required this.bottom,
    required this.highlight,
    required this.line,
  });

  final Color top;
  final Color mid;
  final Color bottom;
  final Color? highlight;
  final Color? line;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    canvas.drawRect(
      rect,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [bottom, mid, top],
          stops: const [0.0, 0.5, 1.0],
        ).createShader(rect),
    );
    final highlight = this.highlight;
    if (highlight != null) {
      canvas.drawRect(
        Offset.zero & Size(size.width, 2),
        Paint()..color = highlight.withValues(alpha: 0.35),
      );
    }
    final line = this.line;
    if (line != null) {
      canvas.drawRect(
        Offset(0, size.height - 1) & Size(size.width, 1),
        Paint()..color = line.withValues(alpha: 0.5),
      );
    }
  }

  @override
  bool shouldRepaint(_StageBackdropPainter old) =>
      old.top != top ||
      old.mid != mid ||
      old.bottom != bottom ||
      old.highlight != highlight ||
      old.line != line;
}

/// The T106 terminal drawer: the resizable bottom drawer of the shell. The
/// grip drag resizes the height between `minDrawerHeight` (default 100) and
/// `maxDrawerRatio` of the viewport (default 0.5), persisted under
/// `persistKey` through the same store seam `split` uses (T90) — one write
/// per drag end. `Escape` and `mod+w` close the focused terminal first (the
/// upstream precedence): the drawer is the focused surface while it is open,
/// so the chord closes it and never falls through to the right panel.
class _TerminalDrawer extends StatefulWidget {
  const _TerminalDrawer({required this.node, required this.ctx});

  final UiNode node;
  final RenderContext ctx;

  @override
  State<_TerminalDrawer> createState() => _TerminalDrawerState();
}

class _TerminalDrawerState extends State<_TerminalDrawer> {
  static const double _defaultHeight = 240;
  static const double _defaultMin = 100;
  static const double _defaultMaxRatio = 0.5;

  /// The live drawer height; null until the persisted value (if any) has
  /// been read — the node `initialHeight` renders meanwhile.
  double? _height;

  bool _dragging = false;
  bool _hovering = false;
  double _dragStartHeight = 0;
  double _dragStartY = 0;

  String? _restoredKey;
  bool _restoreInFlight = false;

  @override
  void initState() {
    super.initState();
    _scheduleRestore();
    HardwareKeyboard.instance.addHandler(_onKey);
  }

  @override
  void didUpdateWidget(covariant _TerminalDrawer old) {
    super.didUpdateWidget(old);
    if (widget.node.stringProp('persistKey') != _restoredKey) {
      _scheduleRestore();
    }
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_onKey);
    super.dispose();
  }

  // --- props -------------------------------------------------------------

  String? get _persistKey {
    final key = widget.node.stringProp('persistKey');
    return key == null || key.isEmpty ? null : key;
  }

  double get _min =>
      widget.node.numProp('minDrawerHeight')?.toDouble() ?? _defaultMin;

  double get _maxRatio =>
      widget.node.numProp('maxDrawerRatio')?.toDouble() ?? _defaultMaxRatio;

  double get _initial =>
      widget.node.numProp('initialHeight')?.toDouble() ?? _defaultHeight;

  double _maxHeight(BuildContext context) {
    final viewport = MediaQuery.sizeOf(context).height;
    return math.max(_min, viewport * _maxRatio);
  }

  double _clamp(double value, BuildContext context) =>
      value.clamp(_min, _maxHeight(context));

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
      setState(() => _height = value);
    });
  }

  void _persist(double height) {
    final key = _persistKey;
    final write = widget.ctx.writePersisted;
    if (key == null || write == null) return;
    Future<void>(() => write(key, height));
  }

  // --- interaction -------------------------------------------------------

  void _dragStart(DragStartDetails details) {
    setState(() {
      _dragging = true;
      _dragStartHeight = _height ?? _initial;
      _dragStartY = details.globalPosition.dy;
    });
  }

  void _dragUpdate(DragUpdateDetails details) {
    final delta = _dragStartY - details.globalPosition.dy;
    setState(() {
      _height = _clamp(_dragStartHeight + delta, context);
    });
  }

  void _dragEnd([DragEndDetails? details]) {
    if (!_dragging) return;
    setState(() => _dragging = false);
    _persist(_height ?? _initial);
  }

  /// The drawer key handler: `Escape` and `mod+w` close the focused
  /// terminal first. Any other chord is ignored so it falls through to the
  /// rest of the app (the upstream precedence).
  bool _onKey(KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) return false;
    final keyboard = HardwareKeyboard.instance;
    final mod = keyboard.isMetaPressed || keyboard.isControlPressed;
    final key = event.logicalKey;
    if (key == LogicalKeyboardKey.escape) {
      _close();
      return true;
    }
    if (mod && key == LogicalKeyboardKey.keyW) {
      _close();
      return true;
    }
    return false;
  }

  void _close() {
    final stateId = widget.node.stringProp('closeState');
    if (stateId != null && stateId.isNotEmpty) {
      widget.ctx.setState(stateId, false);
    }
  }

  // --- build -------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final height = _height ?? _initial;
    return SizedBox(
      key: const Key('terminal-drawer-surface'),
      height: height,
      child: Stack(
        children: [
          Positioned.fill(child: widget.ctx.build(context, widget.node)),
          Positioned(
            top: 0,
            left: 0,
            width: 48,
            height: 32,
            child: _grip(context),
          ),
        ],
      ),
    );
  }

  /// The resize grip: the shared grip visual (T90) over a raw vertical drag
  /// recognizer (mouse + touch + stylus) with the row-resize cursor.
  Widget _grip(BuildContext context) {
    return RawGestureDetector(
      behavior: HitTestBehavior.opaque,
      gestures: {
        VerticalDragGestureRecognizer:
            GestureRecognizerFactoryWithHandlers<VerticalDragGestureRecognizer>(
          () => VerticalDragGestureRecognizer(supportedDevices: _dragDevices),
          (instance) {
            instance
              ..dragStartBehavior = DragStartBehavior.down
              ..onStart = _dragStart
              ..onUpdate = _dragUpdate
              ..onEnd = _dragEnd
              ..onCancel = () => _dragEnd();
          },
        ),
      },
      child: MouseRegion(
        cursor: SystemMouseCursors.resizeUpDown,
        onEnter: (_) => setState(() => _hovering = true),
        onExit: (_) => setState(() => _hovering = false),
        child: Semantics(
          label: 'Resize terminal',
          child: SizedBox.expand(
            key: const Key('terminal-drawer-grip'),
            child: gripHandleVisual(context, vertical: true, hovering: _hovering),
          ),
        ),
      ),
    );
  }

  static const Set<PointerDeviceKind> _dragDevices = {
    PointerDeviceKind.mouse,
    PointerDeviceKind.touch,
    PointerDeviceKind.stylus,
  };
}
