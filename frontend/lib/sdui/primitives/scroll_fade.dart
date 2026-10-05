import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `scroll_fade` (§2.6, contract level 3): `child` (required), `edge?`
/// (`top`|`bottom`|`start`|`end`, default `top`), `height?` (px, default 24
/// — the 1.5rem `--workspace-titlebar-scroll-fade-height`), `mode?`
/// (`topbar`|`virtualized`, default `topbar`).
///
/// Paints an alpha fade over the wrapped scrollable's edge — the upstream
/// mask recipes (t3code `apps/web/src/index.css`, commit 37de6cb), ported
/// as a `ShaderMask` in `dstIn` mode (the CSS `mask-image` equivalent: the
/// content's alpha is multiplied, nothing paints over it):
///
/// - `topbar` — the static seven-stop band of the `topbar-scroll-fade`
///   utility (index.css:420-457): transparent 0%, 10% at 10%, 30% at 24%,
///   58% at 42%, 82% at 62%, 96% at 82%, opaque at 100% of the band. The
///   messages timeline wears it unconditionally (upstream
///   `chat/MessagesTimeline.tsx:1377`), so the mode paints always.
/// - `virtualized` — the two-stop band of the `virtualized-scroll-fade`
///   recipe (index.css:461-476 + `components/ui/scroll-area.tsx:14-20`),
///   toggled by the scroll position like upstream
///   `CommandPaletteResults.tsx:103-113`: an edge fades only while more
///   than 1 px of content hides beyond it (the leading edge when the
///   offset exceeds 1 px, the trailing edge while the remaining extent
///   does). Until the first scroll-metrics event arrives no fade paints —
///   the upstream initial `{top: false, bottom: false}` state.
///
/// `start`/`end` are the horizontal edges (leading/trailing in the reading
/// direction); `top`/`bottom` the vertical ones. The scrollbar lane the
/// upstream virtualized recipe keeps opaque (index.css:461-476) has no
/// Flutter equivalent — the scrollbar overlays the viewport and fades with
/// the content. An unknown edge or mode degrades to the default (§2.4);
/// a missing child degrades visibly.
Widget buildScrollFade(BuildContext context, UiNode node, RenderContext ctx) {
  final child = buildChildProp(context, ctx, node.props['child']);
  if (child == null) return degradedBox(context, 'Missing child');
  final design = JhinDesignScope.of(context);
  final edge = parseScrollFadeEdge(node.stringProp('edge'));
  final height = parseCssLength(
        node.props['height'],
        remPx: design.switches.fontSizes.sizeInterface.toDouble(),
      ) ??
      24.0;
  if (node.stringProp('mode') == 'virtualized') {
    return _VirtualizedFade(edge: edge, height: height, child: child);
  }
  return _EdgeFade(edge: edge, height: height, child: child);
}

/// The scrolled edge a `scroll_fade` paints at (§2.6). `start`/`end` are
/// the horizontal leading/trailing edges, `top`/`bottom` the vertical ones.
enum ScrollFadeEdge { top, bottom, start, end }

/// Parses the `edge` prop; an unknown or absent literal degrades to `top`
/// (§2.4 — never a crash).
ScrollFadeEdge parseScrollFadeEdge(String? value) {
  switch (value) {
    case 'bottom':
      return ScrollFadeEdge.bottom;
    case 'start':
      return ScrollFadeEdge.start;
    case 'end':
      return ScrollFadeEdge.end;
    default:
      return ScrollFadeEdge.top;
  }
}

/// Which scroll edges hide content at [metrics] — the upstream virtualized
/// rule (`CommandPaletteResults.tsx:110-113`): the leading edge while the
/// offset exceeds 1 px, the trailing edge while the remaining extent does.
/// Exposed for the tests (the `kbd` chord-labels precedent).
({bool leading, bool trailing}) scrollFadeEdgesScrolled(ScrollMetrics metrics) =>
    (
      leading: metrics.pixels > 1,
      trailing: metrics.maxScrollExtent - metrics.pixels > 1,
    );

/// Whether the chosen edge hides content at [metrics].
bool scrollFadeEdgeScrolled(ScrollFadeEdge edge, ScrollMetrics metrics) {
  final edges = scrollFadeEdgesScrolled(metrics);
  return switch (edge) {
    ScrollFadeEdge.top || ScrollFadeEdge.start => edges.leading,
    ScrollFadeEdge.bottom || ScrollFadeEdge.end => edges.trailing,
  };
}

/// The `topbar-scroll-fade` band (index.css:424-431): band-relative stops
/// and the mask alpha at each.
const List<double> kScrollFadeTopbarStops = [0.0, 0.10, 0.24, 0.42, 0.62, 0.82, 1.0];
const List<double> kScrollFadeTopbarAlphas = [0.0, 0.10, 0.30, 0.58, 0.82, 0.96, 1.0];

/// The `virtualized-scroll-fade` band (scroll-area.tsx:14-20): a plain
/// transparent → opaque ramp over the fade extent.
const List<double> kScrollFadeVirtualizedStops = [0.0, 1.0];
const List<double> kScrollFadeVirtualizedAlphas = [0.0, 1.0];

/// Whether the edge hugs the trailing side (bottom/right) — the mask
/// gradient mirrors.
bool scrollFadeEdgeTrailing(ScrollFadeEdge edge) =>
    edge == ScrollFadeEdge.bottom || edge == ScrollFadeEdge.end;

/// Whether the band runs along the horizontal axis (the `start`/`end`
/// edges).
bool scrollFadeEdgeHorizontal(ScrollFadeEdge edge) =>
    edge == ScrollFadeEdge.start || edge == ScrollFadeEdge.end;

/// The dstIn mask gradient of one edge band: [bandStops]/[bandAlphas] are
/// band-relative, scaled into the [fraction] of the bounds the band covers;
/// the rest of the bounds stays opaque. A trailing edge mirrors the ramp to
/// hug the far side. Exposed for the tests (the `kbd` chord-labels
/// precedent) — the widgets below consume it through their shader
/// callbacks.
({List<Color> colors, List<double> stops}) scrollFadeBandMask({
  required List<double> bandStops,
  required List<double> bandAlphas,
  required double fraction,
  required bool trailing,
}) {
  final f = fraction.clamp(0.0, 1.0);
  final colors = <Color>[];
  final stops = <double>[];
  for (var i = 0; i < bandStops.length; i++) {
    final stop = (bandStops[i] * f).clamp(0.0, 1.0);
    if (stops.isNotEmpty && stop <= stops.last) continue;
    colors.add(Color.fromRGBO(255, 255, 255, bandAlphas[i]));
    stops.add(stop);
  }
  if (f < 1.0) {
    colors.add(const Color.fromRGBO(255, 255, 255, 1.0));
    stops.add(1.0);
  }
  if (trailing) {
    return (
      colors: colors.reversed.toList(growable: false),
      stops: [for (final s in stops.reversed) 1.0 - s],
    );
  }
  return (colors: colors, stops: stops);
}

/// The static fade of the `topbar` mode: the band paints unconditionally.
class _EdgeFade extends StatelessWidget {
  const _EdgeFade({
    required this.edge,
    required this.height,
    required this.child,
  });

  final ScrollFadeEdge edge;
  final double height;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final trailing = scrollFadeEdgeTrailing(edge);
    final horizontal = scrollFadeEdgeHorizontal(edge);
    return ShaderMask(
      blendMode: BlendMode.dstIn,
      shaderCallback: (bounds) {
        final extent = horizontal ? bounds.width : bounds.height;
        final mask = scrollFadeBandMask(
          bandStops: kScrollFadeTopbarStops,
          bandAlphas: kScrollFadeTopbarAlphas,
          fraction: extent <= 0 ? 1.0 : height / extent,
          trailing: trailing,
        );
        return LinearGradient(
          begin: horizontal
              ? (trailing ? Alignment.centerRight : Alignment.centerLeft)
              : (trailing ? Alignment.bottomCenter : Alignment.topCenter),
          end: horizontal
              ? (trailing ? Alignment.centerLeft : Alignment.centerRight)
              : (trailing ? Alignment.topCenter : Alignment.bottomCenter),
          colors: mask.colors,
          stops: mask.stops,
        ).createShader(bounds);
      },
      child: child,
    );
  }
}

/// The scroll-aware fade of the `virtualized` mode: the band paints only
/// while the chosen edge actually hides content (upstream
/// `CommandPaletteResults.tsx:103-113` — `scrollTop > 1` / the remaining
/// extent > 1).
class _VirtualizedFade extends StatefulWidget {
  const _VirtualizedFade({
    required this.edge,
    required this.height,
    required this.child,
  });

  final ScrollFadeEdge edge;
  final double height;
  final Widget child;

  @override
  State<_VirtualizedFade> createState() => _VirtualizedFadeState();
}

class _VirtualizedFadeState extends State<_VirtualizedFade> {
  /// Whether content hides beyond the leading/trailing scroll edge. Both
  /// start false — the upstream initial state — until the first
  /// scroll-metrics event reports the position.
  bool _leading = false;
  bool _trailing = false;

  bool _onNotification(Notification notification) {
    final metrics = switch (notification) {
      ScrollMetricsNotification(:final metrics) => metrics,
      ScrollUpdateNotification(:final metrics) => metrics,
      ScrollEndNotification(:final metrics) => metrics,
      _ => null,
    };
    if (metrics == null) return false;
    final edges = scrollFadeEdgesScrolled(metrics);
    if (edges.leading != _leading || edges.trailing != _trailing) {
      setState(() {
        _leading = edges.leading;
        _trailing = edges.trailing;
      });
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    final scrolled = switch (widget.edge) {
      ScrollFadeEdge.top || ScrollFadeEdge.start => _leading,
      ScrollFadeEdge.bottom || ScrollFadeEdge.end => _trailing,
    };
    final trailing = scrollFadeEdgeTrailing(widget.edge);
    final horizontal = scrollFadeEdgeHorizontal(widget.edge);
    // The mask stays mounted with an all-opaque shader while the edge is at
    // rest: mounting/unmounting it would re-depth the scrollable subtree
    // and drop the scroll position on every toggle.
    return NotificationListener<Notification>(
      onNotification: _onNotification,
      child: ShaderMask(
        blendMode: BlendMode.dstIn,
        shaderCallback: (bounds) {
          if (!scrolled) {
            // All-opaque: the mask is a no-op while the edge is at rest.
            return const LinearGradient(
              colors: [
                Color.fromRGBO(255, 255, 255, 1.0),
                Color.fromRGBO(255, 255, 255, 1.0),
              ],
              stops: [0.0, 1.0],
            ).createShader(bounds);
          }
          final extent = horizontal ? bounds.width : bounds.height;
          final mask = scrollFadeBandMask(
            bandStops: kScrollFadeVirtualizedStops,
            bandAlphas: kScrollFadeVirtualizedAlphas,
            fraction: extent <= 0 ? 1.0 : widget.height / extent,
            trailing: trailing,
          );
          return LinearGradient(
            begin: horizontal
                ? (trailing ? Alignment.centerRight : Alignment.centerLeft)
                : (trailing ? Alignment.bottomCenter : Alignment.topCenter),
            end: horizontal
                ? (trailing ? Alignment.centerLeft : Alignment.centerRight)
                : (trailing ? Alignment.topCenter : Alignment.bottomCenter),
            colors: mask.colors,
            stops: mask.stops,
          ).createShader(bounds);
        },
        child: widget.child,
      ),
    );
  }
}
