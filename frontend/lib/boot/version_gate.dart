import 'package:flutter/material.dart';

import '../design/theme.dart';

/// The two version-gate surfaces (docs/updates.md §3 rule 6).
enum VersionGateMode {
  /// The on-disk data schema is below the server's `contract.minSchema` —
  /// the app must be updated.
  updateRequired,

  /// Data written by a newer schema was found and quarantined (rule 3).
  newerVersion,
}

/// Client-owned version gate (docs/updates.md §3 rule 6) — chrome, not
/// product (C-10): fixed strings only, like [BootError] and [EmptyState].
///
/// - `updateRequired`: shown when the on-disk schema is below the
///   bootstrap contract's `minSchema`. Never blocks boot destructively —
///   "Continue anyway" lets the user proceed on defaults.
/// - `newerVersion`: the "some data was saved by a newer version" banner,
///   shown while newer-schema data is quarantined, until dismissed.
///
/// Styling comes from the design tokens ([JhinDesignScope]) — no hardcoded
/// layout numbers.
class VersionGate extends StatelessWidget {
  const VersionGate({
    super.key,
    required this.mode,
    this.onDiskSchema,
    this.minSchema,
    this.quarantinedKeys = const [],
    this.onDismiss,
  });

  /// Which surface to render.
  final VersionGateMode mode;

  /// The schema the client store is at (`StoreMigrations.current`).
  final int? onDiskSchema;

  /// The minimum schema the server contract requires.
  final int? minSchema;

  /// The keys quarantined as newer-schema data (banner detail line).
  final List<String> quarantinedKeys;

  /// Dismisses the surface (banner) or proceeds on defaults (update
  /// required). Never destructive.
  final VoidCallback? onDismiss;

  @override
  Widget build(BuildContext context) {
    final design = JhinDesignScope.of(context);
    final tokens = design.tokens;
    final spacing = tokens.spacing;
    switch (mode) {
      case VersionGateMode.updateRequired:
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
                    'Update required',
                    textAlign: TextAlign.center,
                    style: tokens.typography.h3,
                  ),
                  SizedBox(height: spacing.sm),
                  Text(
                    'This server requires data schema '
                    '${minSchema ?? 'unknown'}; this app provides schema '
                    '${onDiskSchema ?? 'unknown'}. Update Jhin, then reopen '
                    'this server.',
                    textAlign: TextAlign.center,
                    style: tokens.typography.body,
                  ),
                  SizedBox(height: spacing.lg),
                  if (onDismiss != null)
                    OutlinedButton(
                      key: const Key('version-gate-dismiss'),
                      onPressed: onDismiss,
                      child: const Text('Continue anyway'),
                    ),
                ],
              ),
            ),
          ),
        );
      case VersionGateMode.newerVersion:
        final scheme = JhinDesignScope.materialOf(context).colorScheme;
        return Padding(
          padding: EdgeInsets.symmetric(
            horizontal: spacing.md,
            vertical: spacing.md,
          ),
          child: Material(
            color: scheme.secondaryContainer,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(tokens.radius.md),
            ),
            child: Padding(
              padding: EdgeInsets.symmetric(
            horizontal: spacing.md,
            vertical: spacing.md,
          ),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Some data was saved by a newer version of Jhin',
                          style: tokens.typography.body.copyWith(
                            color: scheme.onSecondaryContainer,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        SizedBox(height: spacing.xs),
                        Text(
                          quarantinedKeys.isEmpty
                              ? 'It was kept unchanged and is safe. It '
                                  'migrates when you update this app.'
                              : 'Kept unchanged and safe: '
                                  '${quarantinedKeys.join(', ')}. It migrates '
                                  'when you update this app.',
                          style: tokens.typography.small.copyWith(
                            color: scheme.onSecondaryContainer,
                          ),
                        ),
                      ],
                    ),
                  ),
                  TextButton(
                    key: const Key('version-gate-dismiss'),
                    onPressed: onDismiss,
                    child: const Text('Dismiss'),
                  ),
                ],
              ),
            ),
          ),
        );
    }
  }
}
