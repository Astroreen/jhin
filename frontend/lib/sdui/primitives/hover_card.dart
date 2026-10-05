import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `hover_card` (§2.6, contract level 3): `trigger` (node, required),
/// `content` (node, required), `delay?` (ms, default 500), `placement?`
/// (`top`|`bottom`|`left`|`right`, default `top`).
///
/// The hover-opened preview card upstream renders for thread rows
/// (t3code `components/ThreadHoverCard.tsx`, commit 37de6cb): the card
/// floats over everything from an [OverlayPortal] anchored to the trigger,
/// opens after `delay` ms of mouse hover — tap-and-hold on touch — and
/// closes when the pointer leaves both the trigger and the card (a short
/// grace bridges the 4 px gap, so the card stays interactive). Nesting-safe:
/// a `hover_card` inside another card's content gets its own overlay entry
/// above its parent's.
///
/// The card surface mirrors the upstream glass tooltip recipe's geometry
/// (`max-w-80` = 320 px, `rounded-md`, `text-left`): a popover fill at the
/// `radius.md` control radius (`--control-radius`, 8 px) with the md
/// elevation. A missing trigger degrades visibly (§8.3); a missing content
/// degrades to the bare trigger — the universal `tooltip` prop then still
/// shows, the same shape the level-2 downgrade produces server-side.
Widget buildHoverCard(BuildContext context, UiNode node, RenderContext ctx) {
  final triggerRaw = node.props['trigger'];
  final triggerNode = triggerRaw is Map ? UiNode.fromJson(triggerRaw) : null;
  if (triggerNode == null) {
    return degradedBox(context, 'Missing trigger');
  }
  final contentRaw = node.props['content'];
  final contentNode = contentRaw is Map ? UiNode.fromJson(contentRaw) : null;
  if (contentNode == null) {
    // Degrade to the trigger alone: the universal `tooltip` (kept by the
    // level-2 downgrade) still shows.
    return ctx.build(context, triggerNode);
  }
  return _HoverCard(
    node: node,
    ctx: ctx,
    trigger: triggerNode,
    content: contentNode,
  );
}

/// The hover-open grace (ms) that bridges the trigger→card gap so the card
/// stays interactive.
const Duration _hoverGrace = Duration(milliseconds: 120);

/// The card's max width: the upstream `max-w-80` (320 px).
const double _maxCardWidth = 320;

class _HoverCard extends StatefulWidget {
  const _HoverCard({
    required this.node,
    required this.ctx,
    required this.trigger,
    required this.content,
  });

  final UiNode node;
  final RenderContext ctx;
  final UiNode trigger;
  final UiNode content;

  @override
  State<_HoverCard> createState() => _HoverCardState();
}

class _HoverCardState extends State<_HoverCard> {
  final LayerLink _link = LayerLink();

  /// The open card's overlay entry; null while closed. A raw entry (not an
  /// [OverlayPortal]) because the overlay theater lays positioned children
  /// out with loose constraints — the card hugs its content — and because
  /// the portal's layout-info path cannot compute a paint transform through
  /// another card's follower layer (nesting safety).
  OverlayEntry? _entry;

  Timer? _openTimer;
  Timer? _closeTimer;
  bool _open = false;

  @override
  void dispose() {
    _openTimer?.cancel();
    _closeTimer?.cancel();
    _entry?.remove();
    _entry = null;
    super.dispose();
  }

  /// `delay` (ms) before the card opens; negative or malformed → 0.
  Duration get _delay {
    final ms = widget.node.numProp('delay');
    if (ms == null || ms < 0) return const Duration(milliseconds: 500);
    return Duration(milliseconds: ms.round());
  }

  /// The card placement around the trigger; unknown → `top` (§2.4).
  String get _placement {
    final raw = widget.node.stringProp('placement');
    return const {'top', 'bottom', 'left', 'right'}.contains(raw)
        ? raw!
        : 'top';
  }

  void _scheduleOpen() {
    _closeTimer?.cancel();
    if (_open) return;
    _openTimer?.cancel();
    final delay = _delay;
    if (delay <= Duration.zero) {
      _show();
      return;
    }
    _openTimer = Timer(delay, _show);
  }

  void _show() {
    _openTimer?.cancel();
    if (_open) return;
    final overlay = Overlay.maybeOf(context);
    if (overlay == null) {
      debugPrint('Jhin SDUI: hover_card found no Overlay to open in');
      return;
    }
    final design = JhinDesignScope.of(context);
    final theme = Theme.of(context);
    final anchors = _anchors;
    setState(() => _open = true);
    _entry = OverlayEntry(
      builder: (overlayContext) => Theme(
        data: theme,
        child: JhinDesignScope(
          design: design,
          // A positioned theater child re-loosens the overlay's tight screen
          // bounds, so the card hugs its content; the offset itself is
          // irrelevant — the follower's paint transform positions the card.
          child: Positioned(
            left: 0,
            top: 0,
            child: CompositedTransformFollower(
              link: _link,
              targetAnchor: anchors.target,
              followerAnchor: anchors.follower,
              offset: anchors.offset,
              showWhenUnlinked: false,
              child: _card(overlayContext),
            ),
          ),
        ),
      ),
    );
    overlay.insert(_entry!);
  }

  void _hide() {
    _openTimer?.cancel();
    if (!_open && _entry == null) return;
    _entry?.remove();
    _entry = null;
    if (mounted) setState(() => _open = false);
  }

  /// Pointer left the trigger: cancel a pending open, close an open card
    /// after the grace (the card's own `onEnter` cancels the close).
  void _leaveTrigger() {
    _openTimer?.cancel();
    _closeTimer?.cancel();
    if (!_open) return;
    _closeTimer = Timer(_hoverGrace, _hide);
  }

  void _enterCard() {
    _closeTimer?.cancel();
  }

  void _leaveCard() {
    _closeTimer?.cancel();
    _closeTimer = Timer(_hoverGrace, _hide);
  }

  /// Touch: the tap-and-hold opens (or closes) the card — the hold is the
  /// touch equivalent of the hover delay.
  void _toggle() {
    _openTimer?.cancel();
    _closeTimer?.cancel();
    if (_open) {
      _hide();
    } else {
      _show();
    }
  }

  /// The anchor pair of one placement: (target, follower) alignments plus
  /// the 4 px gap offset (the upstream `sideOffset: 4`).
  ({Alignment target, Alignment follower, Offset offset}) get _anchors {
    const gap = 4.0;
    switch (_placement) {
      case 'bottom':
        return (
          target: Alignment.bottomCenter,
          follower: Alignment.topCenter,
          offset: const Offset(0, gap),
        );
      case 'left':
        return (
          target: Alignment.centerLeft,
          follower: Alignment.centerRight,
          offset: const Offset(-gap, 0),
        );
      case 'right':
        return (
          target: Alignment.centerRight,
          follower: Alignment.centerLeft,
          offset: const Offset(gap, 0),
        );
      case 'top':
      default:
        return (
          target: Alignment.topCenter,
          follower: Alignment.bottomCenter,
          offset: const Offset(0, -gap),
        );
    }
  }

  Widget _card(BuildContext context) {
    final design = JhinDesignScope.of(context);
    final tokens = design.tokens;
    final material = JhinDesignScope.materialOf(context);
    final brightness = Theme.brightnessOf(context);
    final remPx = design.switches.fontSizes.sizeInterface.toDouble();
    final radius = jhinSurfaceRadius(tokens.surface, 'md', remPx: remPx) ??
        BorderRadius.circular(8);
    return MouseRegion(
      onEnter: (_) => _enterCard(),
      onExit: (_) => _leaveCard(),
      child: UnconstrainedBox(
        // The card hugs its content (the upstream card is auto-height);
        // the width stays capped at the upstream `max-w-80`.
        child: Material(
          type: MaterialType.card,
          color: design.colorOf('popover', brightness: brightness) ??
              material.colorScheme.surfaceContainerHighest,
          shadowColor: material.colorScheme.shadow,
          elevation: tokens.elevation.md,
          borderRadius: radius,
          clipBehavior: Clip.antiAlias,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: _maxCardWidth),
            child: Padding(
              padding: insetAll(tokens.spacing.sm),
              child: DefaultTextStyle.merge(
                // The upstream card body is text-xs, left-aligned, wrapping.
                style: TextStyle(
                  fontSize: _textTokenPx(tokens.surface, 'xs', remPx) ?? 12,
                  color: material.colorScheme.onSurface,
                ),
                textAlign: TextAlign.left,
                child: widget.ctx.build(context, widget.content),
              ),
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return CompositedTransformTarget(
      link: _link,
      child: RawGestureDetector(
        behavior: HitTestBehavior.opaque,
        gestures: {
          LongPressGestureRecognizer:
              GestureRecognizerFactoryWithHandlers<LongPressGestureRecognizer>(
            () => LongPressGestureRecognizer(),
            (instance) => instance.onLongPress = _toggle,
          ),
        },
        child: MouseRegion(
          onEnter: (_) => _scheduleOpen(),
          onExit: (_) => _leaveTrigger(),
          child: widget.ctx.build(context, widget.trigger),
        ),
      ),
    );
  }
}

/// One §4.3 text token's px size (`text.xs` → 12); null when malformed.
double? _textTokenPx(JhinTokenSurface surface, String key, double remPx) {
  final raw = surface.value('text', key);
  if (raw is Map && raw['size'] != null) {
    return parseCssLength(raw['size'], remPx: remPx);
  }
  return null;
}
