import 'package:flutter/material.dart';

/// Built-in bootstrap failure state (§8.1): the server could not be reached
/// and nothing is cached for this profile (§8.7).
///
/// One of the only two widgets allowed to carry product-neutral copy (D-25).
/// Actions: Retry re-runs the bootstrap fetch; Change server opens the
/// client-owned server-profile surface.
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
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text(
                'Could not reach this server',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
              ),
              if (error != null) ...[
                const SizedBox(height: 12),
                Text(
                  error!,
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontFamily: 'monospace'),
                ),
              ],
              const SizedBox(height: 20),
              Wrap(
                spacing: 12,
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
