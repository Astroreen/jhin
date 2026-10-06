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

/// The no-active-thread hero (T114): the t3code `NoActiveThreadState` shape
/// (`components/NoActiveThreadState.tsx:6-35`) — the "Pick a thread to
/// continue" title over the description and the "Start a conversation"
/// action. Styling comes from the design tokens ([JhinDesignScope]) — no
/// hardcoded layout numbers or colors.
class NoActiveThreadState extends StatelessWidget {
  const NoActiveThreadState({super.key, this.onStartConversation});

  /// Starts a new conversation (navigates to the new-chat screen).
  final VoidCallback? onStartConversation;

  @override
  Widget build(BuildContext context) {
    final tokens = JhinDesignScope.of(context).tokens;
    final spacing = tokens.spacing;
    final muted = Theme.of(context).colorScheme.onSurfaceVariant;
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
              Icon(Icons.forum_outlined, size: 40, color: muted),
              SizedBox(height: spacing.sm),
              Text(
                'Pick a thread to continue',
                textAlign: TextAlign.center,
                style: tokens.typography.h3,
              ),
              SizedBox(height: spacing.sm),
              Text(
                'Select an existing thread or create a new one to get started.',
                textAlign: TextAlign.center,
                style: tokens.typography.body,
              ),
              SizedBox(height: spacing.lg),
              if (onStartConversation != null)
                FilledButton.icon(
                  key: const Key('start-conversation'),
                  onPressed: onStartConversation,
                  icon: const Icon(Icons.add_comment_outlined),
                  label: const Text('Start a conversation'),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The no-projects hero (T114): the t3code `NoProjectsHero` shape
/// (`components/NoProjectsHero.tsx:13-55`) — the "What should we work on?"
/// title over the description and the "Add project" / "Start without a
/// project" actions. Styling comes from the design tokens
/// ([JhinDesignScope]) — no hardcoded layout numbers or colors.
class NoProjectsHero extends StatelessWidget {
  const NoProjectsHero({
    super.key,
    this.onAddProject,
    this.onStartWithoutProject,
  });

  /// Opens the add-project flow.
  final VoidCallback? onAddProject;

  /// Starts a thread without a project.
  final VoidCallback? onStartWithoutProject;

  @override
  Widget build(BuildContext context) {
    final tokens = JhinDesignScope.of(context).tokens;
    final spacing = tokens.spacing;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 512),
        child: Padding(
          padding: EdgeInsets.symmetric(
            horizontal: spacing.xxl,
            vertical: spacing.xxl,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'What should we work on?',
                textAlign: TextAlign.center,
                style: tokens.typography.h3,
              ),
              SizedBox(height: spacing.sm),
              Text(
                'Add a project to start your first thread.',
                textAlign: TextAlign.center,
                style: tokens.typography.body,
              ),
              SizedBox(height: spacing.xl),
              Wrap(
                spacing: spacing.sm,
                alignment: WrapAlignment.center,
                children: [
                  if (onAddProject != null)
                    FilledButton.icon(
                      key: const Key('add-project'),
                      onPressed: onAddProject,
                      icon: const Icon(Icons.add),
                      label: const Text('Add project'),
                    ),
                  if (onStartWithoutProject != null)
                    OutlinedButton.icon(
                      key: const Key('start-without-project'),
                      onPressed: onStartWithoutProject,
                      icon: const Icon(Icons.chat_bubble_outline),
                      label: const Text('Start without a project'),
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
