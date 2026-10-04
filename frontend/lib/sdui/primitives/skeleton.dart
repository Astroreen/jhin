import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../render_context.dart';
import '../ui_node.dart';

/// `skeleton` (§2.6): `variant: text|circle|rect|list` (default `text`),
/// `lines` (default 3), `width`, `height`, `shimmer` (default `true`).
///
/// The shimmer animation runs on the JhinDesignScope motion tokens and
/// collapses to a static placeholder when `shimmer` is off or
/// `MediaQuery.disableAnimations` zeroes the motion (the §2.1 reduced-motion
/// rule) — no ticker runs in that mode.
Widget buildSkeleton(BuildContext context, UiNode node, RenderContext ctx) {
  return _Skeleton(node: node);
}

class _Skeleton extends StatefulWidget {
  const _Skeleton({required this.node});

  final UiNode node;

  @override
  State<_Skeleton> createState() => _SkeletonState();
}

class _SkeletonState extends State<_Skeleton>
    with SingleTickerProviderStateMixin {
  AnimationController? _controller;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _syncMotion();
  }

  @override
  void didUpdateWidget(_Skeleton oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.node.boolProp('shimmer') != widget.node.boolProp('shimmer')) {
      _syncMotion();
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  void _syncMotion() {
    final shimmer = widget.node.boolProp('shimmer') != false;
    final motion = JhinDesignScope.of(context).tokens.motion;
    final animated = shimmer && motion.normal > Duration.zero;
    if (animated) {
      _controller ??= AnimationController(
        vsync: this,
        duration: const Duration(milliseconds: 1200),
      )..repeat();
    } else {
      _controller?.dispose();
      _controller = null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final node = widget.node;
    final theme = Theme.of(context);
    final base = theme.colorScheme.surfaceContainerHighest;
    final highlight = theme.colorScheme.surfaceContainerLow;
    final variant = node.stringProp('variant') ?? 'text';
    final width = node.numProp('width')?.toDouble();
    final height = node.numProp('height')?.toDouble();
    final rawLines = node.numProp('lines')?.toInt() ?? 3;
    final lines = rawLines < 1 ? 1 : rawLines;

    // `width`/`height` size the `rect`/`circle` bones; on `text`/`list`
    // the bar extent is fixed so a small `height` degrades to a clipped
    // viewport instead of a flex overflow (§2.4). The body rides a
    // non-scrollable viewport so combined props can never overflow the
    // skeleton's slot — the client never crashes on server content.
    const barHeight = 12.0;

    final Widget body = LayoutBuilder(builder: (context, constraints) {
      // A bone fills its slot when no `width` is set; an unbounded parent
      // falls back to the built-in default extent (§2.4 — no assertion).
      final fill = width ??
          (constraints.maxWidth.isFinite ? constraints.maxWidth : 120.0);

      Widget bone(double w, double h, {bool circle = false}) => _bone(
            width: w,
            height: h,
            base: base,
            highlight: highlight,
            circle: circle,
          );

      return switch (variant) {
        'circle' => bone(
            height ?? width ?? 40,
            height ?? width ?? 40,
            circle: true,
          ),
        'rect' => bone(fill, height ?? 16),
        'list' => Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (var i = 0; i < lines; i++)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Row(
                    children: [
                      bone(40, 40, circle: true),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            bone(double.infinity, barHeight),
                            const SizedBox(height: 6),
                            bone(double.infinity, barHeight),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        // `text` and any unknown literal (§2.4 degrade).
        _ => Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (var i = 0; i < lines; i++)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: bone(i == lines - 1 ? fill * 0.6 : fill, barHeight),
                ),
            ],
          ),
      };
    });

    final Widget sized = SingleChildScrollView(
      physics: const NeverScrollableScrollPhysics(),
      child: body,
    );

    final controller = _controller;
    if (controller == null) return sized;
    return AnimatedBuilder(
      animation: controller,
      builder: (context, child) => ShaderMask(
        blendMode: BlendMode.srcATop,
        shaderCallback: (rect) {
          final value = controller.value;
          return LinearGradient(
            begin: Alignment.centerLeft,
            end: Alignment.centerRight,
            colors: [base, highlight, base],
            stops: [
              (value - 0.3).clamp(0.0, 1.0),
              value.clamp(0.0, 1.0),
              (value + 0.3).clamp(0.0, 1.0),
            ],
          ).createShader(rect);
        },
        child: child,
      ),
      child: sized,
    );
  }

  Widget _bone({
    required double width,
    required double height,
    required Color base,
    required Color highlight,
    bool circle = false,
  }) {
    return Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: base,
        shape: circle ? BoxShape.circle : BoxShape.rectangle,
        borderRadius: circle ? null : BorderRadius.circular(4),
      ),
    );
  }
}
