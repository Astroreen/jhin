import 'package:flutter/material.dart';

import '../core/api/jhin_transport.dart';
import '../core/auth/app_storage.dart';
import '../sdui/keyboard/command_registry.dart';
import '../sdui/keyboard/command_shortcuts.dart';
import '../sdui/keyboard/composer_commands.dart';
import '../sdui/keyboard/keymap.dart';
import '../sdui/keyboard/palette.dart';
import '../sdui/keyboard/when_context.dart';
import 'boot_error.dart';
import 'empty_state.dart';
import 'screen_renderer.dart';

/// Bootstrap host (§8.1): fetches `GET /_jhin/bootstrap` for the bound
/// profile and renders the outcome.
///
/// Outcomes: `empty:true` → built-in [EmptyState]; non-empty → the SDUI tree
/// through the T22 [ScreenRenderer] seam; network failure → the cached
/// `fallbacks.offline` node when one was cached (§8.7), else [BootError]
/// with Retry and Change server. A successful fetch caches the payload and
/// its `fallbacks` on the profile.
///
/// A small overlay button is painted above the rendered tree and opens the
/// server-profile surface. It is drawn last so server UI can never suppress
/// it: changing servers must work even against a broken or hostile server
/// (D-9).
class SduiHost extends StatefulWidget {
  const SduiHost({
    super.key,
    required this.profile,
    required this.storage,
    required this.transport,
    this.renderer = const GenericScreenRenderer(),
    this.onOpenProfiles,
    this.commandRegistry,
    this.whenContext,
    this.keymapOverrides = const <Object?>[],
    this.runDirectives,
    this.onAppearanceChanged,
    this.accentPresets = const <String>[],
  });

  /// Profile the bootstrap is bound to.
  final ServerProfile profile;

  /// Storage the bootstrap payload and fallbacks are cached into.
  final AppStorage storage;

  /// Transport bound to [profile] (url, pinned certificate, token).
  final JhinTransport transport;

  /// Screen renderer seam — the T22 `SduiRuntime` plugs in here.
  final ScreenRenderer renderer;

  /// Opens the client-owned server-profile surface (overlay button, and the
  /// Change server actions of [EmptyState] / [BootError]).
  final VoidCallback? onOpenProfiles;

  /// Keyboard command registry (T67); a fresh one with the full vocabulary
  /// when omitted.
  final CommandRegistry? commandRegistry;

  /// Observable command contexts for keymap `when` expressions (T67); a
  /// fresh platform-seeded one when omitted.
  final WhenContext? whenContext;

  /// User keybinding overrides merged over the server keymap (§1). The T70
  /// persistence seam: the store rules of `StoreKeys.keybindings`
  /// (`{'rules': [{command, keys}]}`) arrive here; T67 leaves it empty.
  final List<Object?> keymapOverrides;

  /// Runs a client-directive list through the live runtime (T69): undo
  /// feedback, palette navigation and error toasts ride through it. Absent
  /// → the T69 commands degrade to silent no-ops (never a crash).
  final Future<void> Function(List<dynamic> directives)? runDirectives;

  /// Fired after the client appearance preferences change (T69) so the app
  /// shell can regenerate the theme. Absent → a no-op.
  final VoidCallback? onAppearanceChanged;

  /// The accent presets `theme.pick` cycles through (T69): the server
  /// theme's `accent` plus its `colors{}` values.
  final List<String> accentPresets;

  @override
  State<SduiHost> createState() => _SduiHostState();
}

enum _Phase { loading, tree, empty, offline, error }

class _SduiHostState extends State<SduiHost> {
  _Phase _phase = _Phase.loading;
  late ServerProfile _profile = widget.profile;
  Map<String, dynamic>? _payload;
  Map<String, dynamic>? _offlineNode;
  String? _errorText;

  late final CommandRegistry _registry =
      widget.commandRegistry ?? CommandRegistry();
  late WhenContext _when;
  bool _ownsWhen = false;
  Keymap _keymap = Keymap.empty;
  late ComposerBinding _composerBinding;
  late PaletteCommands _paletteCommands;

  @override
  void initState() {
    super.initState();
    if (widget.whenContext == null) {
      _when = WhenContext();
      _ownsWhen = true;
    } else {
      _when = widget.whenContext!;
    }
    _composerBinding = ComposerBinding(whenContext: _when);
    // Registers the five composer commands on the registry (T68); the
    // instance is retained by the registered handlers.
    ComposerCommands(
      registry: _registry,
      binding: _composerBinding,
      history: ComposerHistory(
        storage: widget.storage,
        profileId: widget.profile.id,
      ),
      post: widget.transport.postJson,
    );
    // Registers the T69 commands (palette, thread jumping, undo,
    // appearance/theme) and owns the palette overlay model.
    _paletteCommands = PaletteCommands(
      registry: _registry,
      whenContext: _when,
      post: widget.transport.postJson,
      getList: widget.transport.getJsonList,
      storage: widget.storage,
      runDirectives: widget.runDirectives ?? _noDirectives,
      onAppearanceChanged: widget.onAppearanceChanged ?? () {},
      accentPresets: widget.accentPresets,
    );
    _load();
  }

  static Future<void> _noDirectives(List<dynamic> directives) async {}

  @override
  void dispose() {
    if (_ownsWhen) _when.dispose();
    super.dispose();
  }

  /// Resolves the effective keymap (§1): the payload's server defaults
  /// merged with the user overrides (last matching rule wins), with the
  /// client fallback chords (T68) appended for commands no rule binds yet.
  void _resolveKeymap(Map<String, dynamic> payload) {
    final rawKeymap = payload['keymap'];
    _keymap = Keymap
        .resolve(
          rawKeymap is List ? rawKeymap : const <Object?>[],
          widget.keymapOverrides,
        )
        .withDefaults(ComposerCommands.defaultKeymapRules)
        .withDefaults(PaletteCommands.defaultKeymapRules);
  }

  Future<void> _load() async {
    setState(() {
      _phase = _Phase.loading;
      _errorText = null;
    });
    try {
      final payload = await widget.transport.getJson('/_jhin/bootstrap');
      final fallbacks = _asMap(payload['fallbacks']);
      final updated = _profile.copyWith(
        cachedBootstrap: payload,
        fallbacks: fallbacks,
      );
      await widget.storage.updateProfile(updated);
      if (!mounted) return;
      _resolveKeymap(payload);
      setState(() {
        _profile = updated;
        _payload = payload;
        _phase = payload['empty'] == true ? _Phase.empty : _Phase.tree;
      });
    } catch (error) {
      if (!mounted) return;
      final offline = _asMap(_profile.fallbacks?['offline']);
      setState(() {
        _errorText = '$error';
        _offlineNode = offline;
        _phase = offline == null ? _Phase.error : _Phase.offline;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return ComposerScope(
      binding: _composerBinding,
      child: CommandShortcuts(
        registry: _registry,
        whenContext: _when,
        keymap: _keymap,
        child: Scaffold(
          body: Stack(
            children: [
              Positioned.fill(child: _body()),
              Positioned(
                top: 8,
                right: 8,
                child: SafeArea(
                  child: Material(
                    key: const Key('sdui-host-overlay'),
                    elevation: 2,
                    shape: const CircleBorder(),
                    child: IconButton(
                      tooltip: 'Change server',
                      icon: const Icon(Icons.dns_outlined),
                      onPressed: widget.onOpenProfiles,
                    ),
                  ),
                ),
              ),
              // The command palette (T69): client-owned chrome painted last,
              // exactly like the Change-server button — a hostile server can
              // never suppress it. Positioned so an open overlay covers the
              // body without a closed one collapsing the stack's sizing.
              Positioned.fill(
                child: ListenableBuilder(
                  listenable: _paletteCommands.controller,
                  builder: (context, _) {
                    if (!_paletteCommands.controller.isOpen) {
                      return const SizedBox.shrink();
                    }
                    return CommandPalette(
                        controller: _paletteCommands.controller);
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _body() {
    switch (_phase) {
      case _Phase.loading:
        return const Center(child: CircularProgressIndicator());
      case _Phase.tree:
        return widget.renderer.buildScreen(context, _payload!);
      case _Phase.empty:
        final payload = _payload!;
        final kernel = payload['kernel'];
        final plugins = payload['plugins'];
        return EmptyState(
          kernelVersion: kernel is String ? kernel : 'unknown',
          pluginCount: plugins is List ? plugins.length : 0,
          onChangeServer: widget.onOpenProfiles,
        );
      case _Phase.offline:
        return widget.renderer.buildNode(context, _offlineNode!);
      case _Phase.error:
        return BootError(
          error: _errorText,
          onRetry: _load,
          onChangeServer: widget.onOpenProfiles,
        );
    }
  }

  static Map<String, dynamic>? _asMap(Object? value) {
    if (value is Map<String, dynamic>) {
      return value;
    }
    if (value is Map) {
      return Map<String, dynamic>.from(value);
    }
    return null;
  }
}
