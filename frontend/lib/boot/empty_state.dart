import 'package:flutter/material.dart';

/// Built-in empty-server state (§8.1): a bare kernel with no UI plugin.
///
/// One of the only two widgets allowed to carry product-neutral copy (D-25);
/// the copy stays server-agnostic because the kernel bootstrap fallback
/// (`{"api":1,"empty":true,…}`) is generic by design (D-7).
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
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text(
                'This server has no UI plugin installed',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 12),
              Text('Kernel version: $kernelVersion'),
              Text('Plugins installed: $pluginCount'),
              const SizedBox(height: 20),
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
