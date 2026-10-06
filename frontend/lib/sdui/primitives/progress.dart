import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `progress` (§8.3): `kind: linear|circular`, `value?`.
///
/// `kind` defaults to `linear`; without `value` the indicator is
/// indeterminate. All props are optional — `{}` renders a visible
/// indeterminate bar.
///
/// T87: the indeterminate animation is a duty-cycled animation, so the
/// reduced-motion rule (§2.1) collapses it to a static empty track — the
/// `motion-safe:` behaviour of the upstream duty cycles
/// (index.css:216-220).
///
/// T92: the level-3 `statusPulse` prop (§2.1) turns the node into the
/// duty-cycled attention indicator — `pulse` runs the 2 s stepped status
/// pulse, `ping` the 2 s ping ring, `skeleton` the 2.4 s shimmer (the
/// `tokens.motion` duty cycles). A complete indicator (`value >= 1.0`)
/// never animates: the static complete bar wins over the mode. Reduced
/// motion collapses every mode to the static dot.
const Set<String> statusPulseModes = {'pulse', 'ping', 'skeleton'};

/// The T108 browser-preview loading mode: the upstream
/// `preview-loading-progress` keyframe (index.css:2118-2151, commit 37de6cb)
/// — a 2 px bar that scales from 0.04 to 0.9 over 5.3 s with
/// `cubic-bezier(0.1, 0.5, 0.2, 1)` and holds (`forwards`). The `loading`
/// prop is the upstream `data-loading` attribute: `false` keeps the bar
/// hidden, `true` plays the animation once.
const String kPreviewLoadingMode = 'preview-loading';
const Duration kPreviewLoadingCycle = Duration(milliseconds: 5300);
const Cubic kPreviewLoadingCurve = Cubic(0.1, 0.5, 0.2, 1.0);
const double kPreviewLoadingFrom = 0.04;
const double kPreviewLoadingTo = 0.9;

Widget buildProgress(BuildContext context, UiNode node, RenderContext ctx) {
  final value = node.numProp('value')?.toDouble();
  final mode = node.stringProp('statusPulse');
  if (mode == kPreviewLoadingMode) {
    return JhinPreviewLoadingBar(
      loading: node.boolProp('loading') == true,
      color: parseColor(node.props['color']),
    );
  }
  if (mode != null &&
      statusPulseModes.contains(mode) &&
      !(value != null && value >= 1.0)) {
    return JhinStatusIndicator(
      mode: mode,
      color: parseColor(node.props['color']),
    );
  }
  if (value != null) {
    return node.stringProp('kind') == 'circular'
        ? CircularProgressIndicator(value: value)
        : LinearProgressIndicator(value: value);
  }
  final design = JhinDesignScope.of(context);
  final animated = design.switches.statusPulseEnabled &&
      design.tokens.motion.normal > Duration.zero;
  if (animated) {
    return node.stringProp('kind') == 'circular'
        ? const CircularProgressIndicator()
        : const LinearProgressIndicator();
  }
  // Reduced motion: the static empty track (never a frozen mid-state).
  return node.stringProp('kind') == 'circular'
      ? const CircularProgressIndicator(value: 0)
      : const LinearProgressIndicator(value: 0);
}

/// The duty-cycled attention indicator (T92): the `progress` `statusPulse`
/// modes rendered as a status dot — the upstream status pill wears
/// `animate-status-pulse` while working/connecting and the unread dot pings
/// (t3code `components/ThreadStatusIndicators.tsx:817-868` +
/// `components/Sidebar.logic.ts:1158-1231`, commit 37de6cb).
///
/// - `pulse` — the dot's opacity runs the stepped status-pulse waveform
///   ([JhinStatusPulseCurve], index.css:302-315: 12 discrete updates per
///   2 s cycle).
/// - `ping` — a ring bursts over the static dot: scale 0.75 → 2 and
///   opacity 0.9 → 0 with steps(8) over the first 40% of the 2 s cycle,
///   invisible for the rest ([JhinStatusPingCurve], index.css:317-327).
/// - `skeleton` — the dot's opacity runs the skeleton shimmer
///   ([JhinSkeletonCurve], index.css:283-299, 2.4 s cycle).
///
/// The duration comes from the `tokens.motion` duty cycle of the mode; the
/// reduced-motion rule (§2.1) collapses every mode to the static dot — no
/// ticker runs. An unknown mode renders the static dot too (§2.4).
class JhinStatusIndicator extends StatefulWidget {
  const JhinStatusIndicator({
    super.key,
    required this.mode,
    this.color,
    this.size = 12,
  });

  /// The duty-cycle mode: `pulse`, `ping` or `skeleton`.
  final String mode;

  /// The dot/ring color; the `info` token (the upstream working sky) when
  /// unset.
  final Color? color;

  /// The dot diameter in logical pixels (the upstream `size-3` status dot).
  final double size;

  @override
  State<JhinStatusIndicator> createState() => _JhinStatusIndicatorState();
}

class _JhinStatusIndicatorState extends State<JhinStatusIndicator>
    with SingleTickerProviderStateMixin {
  AnimationController? _controller;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _syncMotion();
  }

  @override
  void didUpdateWidget(JhinStatusIndicator oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.mode != widget.mode) {
      _syncMotion();
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  void _syncMotion() {
    final design = JhinDesignScope.of(context);
    final enabled = switch (widget.mode) {
      'pulse' => design.switches.statusPulseEnabled,
      'ping' => design.switches.statusPingEnabled,
      'skeleton' => design.switches.skeletonEnabled,
      _ => false,
    };
    final animated =
        enabled && design.tokens.motion.normal > Duration.zero;
    if (!animated) {
      _controller?.dispose();
      _controller = null;
      return;
    }
    final (token, fallback) = switch (widget.mode) {
      'ping' => ('statusPing', kStatusPingCycle),
      'skeleton' => ('skeleton', kSkeletonCycle),
      _ => ('statusPulse', kStatusPulseCycle),
    };
    final duration = jhinDutyCycleDuration(
      design.tokens.surface,
      token,
      fallback: fallback,
    );
    if (_controller == null) {
      _controller = AnimationController(vsync: this, duration: duration)
        ..repeat();
    } else {
      _controller!.duration = duration;
    }
  }

  @override
  Widget build(BuildContext context) {
    final design = JhinDesignScope.of(context);
    final material = JhinDesignScope.materialOf(context);
    final color = widget.color ??
        design.colorOf('info', brightness: Theme.brightnessOf(context)) ??
        material.colorScheme.primary;
    final dot = Container(
      width: widget.size,
      height: widget.size,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );
    final controller = _controller;
    if (controller == null) {
      // Reduced motion (or an unknown mode): the static dot — never a
      // frozen mid-state.
      return widget.mode == 'ping'
          ? SizedBox(width: widget.size, height: widget.size, child: dot)
          : dot;
    }
    if (widget.mode == 'ping') {
      return AnimatedBuilder(
        animation: controller,
        builder: (context, child) {
          final progress =
              const JhinStatusPingCurve().valueAt(controller.value);
          final ring = Transform.scale(
            scale: JhinStatusPingCurve.scaleAt(progress),
            child: Opacity(
              opacity: JhinStatusPingCurve.opacityAt(progress),
              child: Container(
                width: widget.size,
                height: widget.size,
                decoration:
                    BoxDecoration(color: color, shape: BoxShape.circle),
              ),
            ),
          );
          return SizedBox(
            width: widget.size,
            height: widget.size,
            child: Stack(
              fit: StackFit.expand,
              alignment: Alignment.center,
              children: [ring, child!],
            ),
          );
        },
        child: dot,
      );
    }
    final curve = widget.mode == 'skeleton'
        ? const JhinSkeletonCurve()
        : const JhinStatusPulseCurve();
    return AnimatedBuilder(
      animation: controller,
      builder: (context, child) =>
          Opacity(opacity: curve.valueAt(controller.value), child: child),
      child: dot,
    );
  }
}

/// The T108 browser-preview loading bar (the upstream
/// `preview-loading-progress`, index.css:2118-2151, commit 37de6cb): a 2 px
/// full-width bar, origin-left, rounded on the right, tinted `primary` with
/// the ring glow. `loading: false` keeps it hidden (opacity 0, scaleX 1);
/// `loading: true` plays the 5.3 s scaleX 0.04 → 0.9 animation once and
/// holds at 0.9 (`forwards`). Reduced motion collapses to the static 0.9
/// bar (index.css:2141-2151) — no ticker runs.
class JhinPreviewLoadingBar extends StatefulWidget {
  const JhinPreviewLoadingBar({
    super.key,
    required this.loading,
    this.color,
  });

  /// The upstream `data-loading` attribute: whether the bar plays.
  final bool loading;

  /// The bar color; the `primary` token when unset.
  final Color? color;

  @override
  State<JhinPreviewLoadingBar> createState() => _JhinPreviewLoadingBarState();
}

class _JhinPreviewLoadingBarState extends State<JhinPreviewLoadingBar>
    with SingleTickerProviderStateMixin {
  AnimationController? _controller;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(JhinPreviewLoadingBar oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.loading != widget.loading) {
      _sync();
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  void _sync() {
    final design = JhinDesignScope.of(context);
    final animated = design.switches.statusPulseEnabled &&
        design.tokens.motion.normal > Duration.zero;
    if (!widget.loading || !animated) {
      _controller?.dispose();
      _controller = null;
      return;
    }
    if (_controller == null) {
      _controller = AnimationController(
        vsync: this,
        duration: kPreviewLoadingCycle,
      )..forward();
    } else {
      _controller!
        ..reset()
        ..forward();
    }
  }

  @override
  Widget build(BuildContext context) {
    final design = JhinDesignScope.of(context);
    final material = JhinDesignScope.materialOf(context);
    final color = widget.color ??
        design.colorOf('primary', brightness: Theme.brightnessOf(context)) ??
        material.colorScheme.primary;
    final ring = design.colorOf('ring', brightness: Theme.brightnessOf(context));
    final controller = _controller;
    Widget bar(double scale) => Opacity(
          opacity: widget.loading ? 1.0 : 0.0,
          child: Transform.scale(
            scaleX: scale,
            alignment: Alignment.centerLeft,
            child: Container(
              height: 2,
              decoration: BoxDecoration(
                color: color,
                borderRadius: const BorderRadius.horizontal(
                  right: Radius.circular(999),
                ),
                boxShadow: [
                  BoxShadow(
                    color: ring ?? color,
                    blurRadius: 6,
                    spreadRadius: 1,
                  ),
                ],
              ),
            ),
          ),
        );
    if (controller == null) {
      // Hidden (not loading) or the reduced-motion static hold.
      return bar(widget.loading ? kPreviewLoadingTo : 1.0);
    }
    return AnimatedBuilder(
      animation: controller,
      builder: (context, child) => bar(
        kPreviewLoadingFrom +
            (kPreviewLoadingTo - kPreviewLoadingFrom) *
                kPreviewLoadingCurve.transform(controller.value),
      ),
    );
  }
}
