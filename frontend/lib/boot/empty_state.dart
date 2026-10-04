import 'package:flutter/material.dart';

import '../design/theme.dart';

/// Built-in empty-server state (§8.1): a bare kernel with no UI plugin.
///
/// One of the only two widgets allowed to carry product-neutral copy (D-25);
/// the copy stays server-agnostic because the kernel bootstrap fallback
/// (`{"api":1,"empty":true,…}`) is generic by design (D-7). It doubles as
/// the client fallback art when the payload carries no `fallbacks` key.
///
/// Styling comes from the design tokens ([JhinDesignScope]) — no hardcoded
/// layout numbers or colors (T79).
class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.kernelVersion,
    required this.pluginCount,
    this.onChangeServer,
  });

  /// Kernel version reported by `/_jhin/bootstrap`, or `unknown`.
  final String kernelVersion;

  /// Number of plugins reported by `/_jhin/bootstrap`.
  final int pluginCount;

  /// Opens the client-owned server-profile surface.
  final VoidCallback? onChangeServer;

  @override
  Widget build(BuildContext context) {
    final tokens = JhinDesignScope.of(context).tokens;
    final spacing = tokens.spacing;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Padding(
          padding: EdgeInsets.symmetric(
            horizontal: spacing.xl,
            vertical: spacing.xl,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'This server has no UI plugin installed',
                textAlign: TextAlign.center,
                style: tokens.typography.h3,
              ),
              SizedBox(height: spacing.sm),
              Text('Kernel version: $kernelVersion'),
              Text('Plugins installed: $pluginCount'),
              SizedBox(height: spacing.lg),
              if (onChangeServer != null)
                FilledButton(
                  key: const Key('change-server'),
                  onPressed: onChangeServer,
                  child: const Text('Change server'),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
