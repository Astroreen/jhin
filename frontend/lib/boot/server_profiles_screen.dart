import 'package:flutter/material.dart';

import '../core/auth/app_storage.dart';
import 'add_server_screen.dart';

/// Client-owned server profile list (§8.1, D-9): switch, add, edit and
/// remove stored profiles. The list is never server-controlled.
///
/// Tap a profile to switch to it: the caller tears down the current SDUI
/// tree and re-runs bootstrap against the new server. Add / edit open
/// [AddServerScreen]; remove deletes the profile and its token.
class ServerProfilesScreen extends StatefulWidget {
  const ServerProfilesScreen({
    super.key,
    required this.storage,
    this.probe = probeServer,
    this.addFirst = false,
    this.onSwitch,
    this.onClosed,
    this.onProfilesChanged,
  });

  /// Profile storage.
  final AppStorage storage;

  /// Server probe handed to [AddServerScreen].
  final ServerProbe probe;

  /// Add-first mode — shown when the profile list is empty: the add screen
  /// opens automatically so a fresh install lands directly on "add server".
  final bool addFirst;

  /// Called after a profile is selected or freshly added (which makes it
  /// active); the host rebinds to it and re-runs bootstrap.
  final void Function(ServerProfile profile)? onSwitch;

  /// Non-null when the screen is opened over a live host — shows a Done
  /// action that returns to it.
  final VoidCallback? onClosed;

  /// Called whenever the stored list changed (edit, remove) so the host can
  /// re-resolve the active profile.
  final VoidCallback? onProfilesChanged;

  @override
  State<ServerProfilesScreen> createState() => _ServerProfilesScreenState();
}

class _ServerProfilesScreenState extends State<ServerProfilesScreen> {
  List<ServerProfile> _profiles = const [];

  @override
  void initState() {
    super.initState();
    _reload().then((_) {
      if (!mounted) return;
      if (widget.addFirst && _profiles.isEmpty) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) _openAdd();
        });
      }
    });
  }

  Future<void> _reload() async {
    final profiles = await widget.storage.readProfiles();
    if (!mounted) return;
    setState(() => _profiles = profiles);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Servers'),
        actions: [
          if (widget.onClosed != null)
            TextButton(
              key: const Key('profiles-done'),
              onPressed: widget.onClosed,
              child: const Text('Done'),
            ),
        ],
      ),
      body: _profiles.isEmpty
          ? const Center(child: Text('No servers stored'))
          : ListView.builder(
              itemCount: _profiles.length,
              itemBuilder: (context, index) {
                final profile = _profiles[index];
                return ListTile(
                  key: Key('profile-tile-${profile.id}'),
                  title: Text(profile.label),
                  subtitle: Text(profile.url),
                  trailing: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      IconButton(
                        key: Key('profile-edit-${profile.id}'),
                        icon: const Icon(Icons.edit_outlined),
                        tooltip: 'Edit',
                        onPressed: () => _openEdit(profile),
                      ),
                      IconButton(
                        key: Key('profile-remove-${profile.id}'),
                        icon: const Icon(Icons.delete_outline),
                        tooltip: 'Remove',
                        onPressed: () => _remove(profile),
                      ),
                    ],
                  ),
                  onTap: () => _select(profile),
                );
              },
            ),
      floatingActionButton: FloatingActionButton.extended(
        key: const Key('add-server-button'),
        onPressed: _openAdd,
        icon: const Icon(Icons.add),
        label: const Text('Add server'),
      ),
    );
  }

  Future<void> _select(ServerProfile profile) async {
    await widget.storage.setActiveProfileId(profile.id);
    if (!mounted) return;
    widget.onSwitch?.call(profile);
  }

  Future<void> _remove(ServerProfile profile) async {
    await widget.storage.removeProfile(profile.id);
    await _reload();
    widget.onProfilesChanged?.call();
  }

  Future<void> _openAdd() async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (addContext) => AddServerScreen(
          storage: widget.storage,
          probe: widget.probe,
          onDone: (profile) {
            Navigator.of(addContext).pop();
            widget.onSwitch?.call(profile);
          },
        ),
      ),
    );
    if (!mounted) return;
    await _reload();
  }

  Future<void> _openEdit(ServerProfile profile) async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (editContext) => AddServerScreen(
          storage: widget.storage,
          probe: widget.probe,
          existing: profile,
          onDone: (_) {
            Navigator.of(editContext).pop();
            widget.onProfilesChanged?.call();
          },
        ),
      ),
    );
    if (!mounted) return;
    await _reload();
  }
}
