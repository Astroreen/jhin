import 'package:flutter/material.dart';

import '../sdui/primitives/progress.dart';
import '../sdui/ui_registry.dart';
import 'theme.dart';

/// The sidebar status-indicator cluster (T92 + T97): the full ten-kind set
/// over the `progress` duty-cycle modes and the icon registry.
///
/// Upstream anchors (t3code `apps/web/src`, commit 37de6cb): the status pill
/// dot wears `animate-status-pulse` while working/connecting
/// (`components/Sidebar.logic.ts:1158-1231`, rendered by
/// `components/ThreadStatusIndicators.tsx:817-868`), the unseen-completion
/// (unread) state resolves to the success tone
/// (`components/Sidebar.tsx:1305-1311`), and the resting state renders no
/// pill at all (`components/Sidebar.logic.ts:940-943`, "unlabeled resting
/// state"). The ten-kind set itself is the plan's T97 adaptation of the
/// Jhin session model (working / idle / monitoring / needs-approval /
/// needs-answer / failed / limited / snoozed / settled / unread / pinned);
/// the tooltip words are the plan's literal labels.
///
/// Colors come from the token surface through the contrast indirection:
/// `info` for the working spinner and the monitoring eye (the upstream sky),
/// `success` for the unread dot and the settled check (the upstream
/// emerald), `warning` for needs-approval and limited (the upstream amber),
/// `error` for failed, `muted-foreground` for idle, snoozed and pinned.
/// Reduced motion collapses the duty-cycle modes to the static dots (§2.1).
///
/// An unknown kind renders the fallback idle indicator and logs (§2.4) —
/// the server maps unknown statuses to `idle` too; this is the client's
/// own defense.
class ThreadStatusIndicators extends StatelessWidget {
  const ThreadStatusIndicators({
    super.key,
    this.kinds = const [],
    this.working = false,
    this.unread = false,
    this.size = 12,
    this.spacing = 6,
  });

  /// The indicator kinds to show, in render order. Unknown kinds fall back
  /// to `idle` with a debug log.
  final List<String> kinds;

  /// Whether the working spinner (the `pulse` mode) shows — the T92
  /// boolean spelling of `kinds: ['working']`.
  final bool working;

  /// Whether the unread dot (the `ping` mode) shows — the T92 boolean
  /// spelling of `kinds: ['unread']`.
  final bool unread;

  /// The dot/icon diameter in logical pixels.
  final double size;

  /// The gap between the indicators.
  final double spacing;

  /// The known kinds with their icon, color token and tooltip. `working`
  /// and `unread` ride the duty-cycle modes instead of glyphs; `idle` is
  /// the unlabeled resting dot (upstream renders no pill for it).
  static const Map<String, ({String? icon, String colorToken, String? tooltip})>
      kindSpecs = {
    'working': (icon: null, colorToken: 'info', tooltip: 'Working'),
    'idle': (icon: 'circle', colorToken: 'muted-foreground', tooltip: null),
    'monitoring': (icon: 'visibility', colorToken: 'info', tooltip: 'Monitoring'),
    'needs-approval':
        (icon: 'error_outline', colorToken: 'warning', tooltip: 'Needs approval'),
    'needs-answer': (icon: 'error_outline', colorToken: 'info', tooltip: 'Needs answer'),
    'failed': (icon: 'warning_amber', colorToken: 'error', tooltip: 'Failed'),
    'limited': (icon: 'bolt', colorToken: 'warning', tooltip: 'Limited'),
    'snoozed': (icon: 'pause_circle', colorToken: 'muted-foreground', tooltip: 'Snoozed'),
    'settled': (icon: 'check_circle', colorToken: 'muted-foreground', tooltip: 'Settled'),
    'unread': (icon: null, colorToken: 'success', tooltip: 'Unread'),
    'pinned': (icon: 'lock', colorToken: 'muted-foreground', tooltip: 'Pinned'),
  };

  @override
  Widget build(BuildContext context) {
    final design = JhinDesignScope.of(context);
    final material = JhinDesignScope.materialOf(context);
    final brightness = Theme.brightnessOf(context);
    Color colorOf(String token) =>
        design.colorOf(token, brightness: brightness) ?? material.colorScheme.primary;

    final resolved = <String>[
      if (working) 'working',
      if (unread) 'unread',
      ...kinds,
    ];
    final indicators = <Widget>[];
    for (final kind in resolved) {
      final spec = kindSpecs[kind];
      if (spec == null) {
        // Unknown kind: the fallback idle indicator plus the log (§2.4).
        debugPrint('Jhin SDUI: unknown status indicator kind "$kind", '
            'rendering the idle fallback');
        indicators.add(_labeled(
          context,
          Icon(iconFor('circle') ?? Icons.circle, size: size, color: colorOf('muted-foreground')),
          null,
        ));
        continue;
      }
      final color = colorOf(spec.colorToken);
      final Widget glyph;
      if (kind == 'working') {
        glyph = JhinStatusIndicator(mode: 'pulse', color: color, size: size);
      } else if (kind == 'unread') {
        // The filled 6 px dot with the ping ring (the plan's unread spec;
        // every other kind rides the cluster size).
        glyph = JhinStatusIndicator(mode: 'ping', color: color, size: 6);
      } else {
        glyph = Icon(iconFor(spec.icon) ?? Icons.circle, size: size, color: color);
      }
      indicators.add(_labeled(context, glyph, spec.tooltip));
    }
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

  /// Wraps one glyph with its tooltip; the unlabeled kinds (idle) pass
  /// through bare.
  Widget _labeled(BuildContext context, Widget glyph, String? tooltip) {
    if (tooltip == null || tooltip.isEmpty) return glyph;
    return Tooltip(message: tooltip, child: glyph);
  }
}
