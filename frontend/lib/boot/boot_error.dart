import 'package:flutter/material.dart';

import '../design/theme.dart';

/// Built-in bootstrap failure state (§8.1): the server could not be reached
/// and nothing is cached for this profile (§8.7).
///
/// One of the only two widgets allowed to carry product-neutral copy (D-25).
/// Actions: Retry re-runs the bootstrap fetch; Change server opens the
/// client-owned server-profile surface.
///
/// Styling comes from the design tokens ([JhinDesignScope]) — no hardcoded
/// layout numbers or colors (T79).
class BootError extends StatelessWidget {
  const BootError({
    super.key,
    this.error,
    this.onRetry,
    this.onChangeServer,
  });

  /// Raw transport error text, shown verbatim when present.
  final String? error;

  /// Re-runs the bootstrap fetch.
  final VoidCallback? onRetry;

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
                'Could not reach this server',
                textAlign: TextAlign.center,
                style: tokens.typography.h3,
              ),
              if (error != null) ...[
                SizedBox(height: spacing.sm),
                Text(
                  error!,
                  textAlign: TextAlign.center,
                  style: tokens.typography.mono,
                ),
              ],
              SizedBox(height: spacing.lg),
              Wrap(
                spacing: spacing.md,
                alignment: WrapAlignment.center,
                children: [
                  if (onRetry != null)
                    OutlinedButton(
                      key: const Key('boot-retry'),
                      onPressed: onRetry,
                      child: const Text('Retry'),
                    ),
                  if (onChangeServer != null)
                    FilledButton(
                      key: const Key('change-server'),
                      onPressed: onChangeServer,
                      child: const Text('Change server'),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
