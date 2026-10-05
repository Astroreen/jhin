import 'package:flutter/material.dart';

import '../sdui/primitives/progress.dart';
import 'theme.dart';

/// The sidebar status-indicator cluster (T92): the minimal client widget
/// over the `progress` duty-cycle modes — the working spinner rides the
/// `pulse` waveform, the unread dot the `ping` ring.
///
/// Upstream anchors (t3code `apps/web/src`, commit 37de6cb): the status
/// pill dot wears `animate-status-pulse` while working/connecting
/// (`components/Sidebar.logic.ts:1158-1231`, rendered by
/// `components/ThreadStatusIndicators.tsx:817-868`), the terminal-running
/// icon pulses the same way (`ThreadStatusIndicators.tsx:759-770` and
/// `:1017`), and the unseen-completion (unread) state resolves to the
/// success tone (`components/Sidebar.tsx:1305-1311`). The full row anatomy
/// lands with T97 — this widget is the client-side building block that
/// composes the two modes.
///
/// Colors come from the token surface through the contrast indirection:
/// `info` for the working spinner (the upstream sky), `success` for the
/// unread dot (the upstream emerald). Reduced motion collapses both modes
/// to the static dots (§2.1).
class ThreadStatusIndicators extends StatelessWidget {
  const ThreadStatusIndicators({
    super.key,
    this.working = false,
    this.unread = false,
    this.size = 12,
    this.spacing = 6,
  });

  /// Whether the working spinner (the `pulse` mode) shows.
  final bool working;

  /// Whether the unread dot (the `ping` mode) shows.
  final bool unread;

  /// The dot diameter in logical pixels.
  final double size;

  /// The gap between the indicators.
  final double spacing;

  @override
  Widget build(BuildContext context) {
    final design = JhinDesignScope.of(context);
    final material = JhinDesignScope.materialOf(context);
    final brightness = Theme.brightnessOf(context);
    final workingColor = design.colorOf('info', brightness: brightness) ??
        material.colorScheme.primary;
    final unreadColor = design.colorOf('success', brightness: brightness) ??
        material.colorScheme.primary;
    final indicators = <Widget>[
      if (working)
        JhinStatusIndicator(mode: 'pulse', color: workingColor, size: size),
      if (unread)
        JhinStatusIndicator(mode: 'ping', color: unreadColor, size: size),
    ];
    if (indicators.isEmpty) return const SizedBox.shrink();
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 0; i < indicators.length; i++) ...[
          if (i > 0) SizedBox(width: spacing),
          indicators[i],
        ],
      ],
    );
  }
}
