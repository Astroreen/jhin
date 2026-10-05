import 'dart:async';

import 'package:flutter/material.dart';

import 'boot/add_server_screen.dart';
import 'boot/screen_renderer.dart';
import 'boot/server_profiles_screen.dart';
import 'boot/sdui_host.dart';
import 'boot/version_gate.dart';
import 'core/api/jhin_transport.dart';
import 'core/auth/app_storage.dart';
import 'core/tls/tls_trust.dart';
import 'design/theme.dart';
import 'sdui/keyboard/keymap.dart';
import 'sdui/keyboard/palette.dart';
import 'sdui/sdui_runtime.dart';
import 'store/migrations/migration_runner.dart';
import 'store/migrations/store_migrations.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final storage = AppStorage();
  // Rule 5 (docs/updates.md §3): the migration runner runs before anything
  // reads state — the report is awaited before JhinApp builds.
  final migration = await MigrationRunner().run(storage);
  runApp(JhinApp(
    storage: storage,
    migration: migration,
    createRenderer: createSduiRuntime,
  ));
}

/// Builds the transport bound to one stored profile: base URL, TOFU-pinned
/// certificate (when a fingerprint is recorded) and the device token.
JhinTransport createProfileTransport(ServerProfile profile) => JhinTransport(
      baseUrl: Uri.parse(profile.url),
      trustStore: TrustStore(pinnedFingerprint: profile.certFingerprint),
      token: profile.token,
    );

/// Per-profile dependencies of the [RendererFactory].
class RendererEnv {
  const RendererEnv({
    required this.storage,
    required this.profile,
    required this.transport,
    required this.createTransport,
    required this.onOpenProfiles,
    this.onTheme,
    this.keymapStore,
  });

  /// Profile storage the runtime persists tokens and caches into.
  final AppStorage storage;

  /// The active profile the runtime is bound to.
  final ServerProfile profile;

  /// Transport bound to [profile].
  final JhinTransport transport;

  /// Transport factory used after `setServerUrl` rewrites the URL.
  final JhinTransport Function(ServerProfile profile) createTransport;

  /// Opens the client-owned profile surface (`openProfiles` directive).
  final VoidCallback onOpenProfiles;

  /// Fired on every ingested bootstrap payload so the app shell can
  /// regenerate its theme from the payload's `theme`/`tokens`/`density`
  /// (§1). May fire during build; the receiver defers past the frame.
  final void Function(Map<String, dynamic> payload)? onTheme;

  /// The live user keymap (T70): keybinding actions persist through it.
  final KeymapStore? keymapStore;
}

/// Creates the screen renderer for one profile (the T22 seam of [SduiHost]).
typedef RendererFactory = ScreenRenderer Function(RendererEnv env);

/// T22 wiring: the SDUI runtime renders server-driven screens (§8).
ScreenRenderer createSduiRuntime(RendererEnv env) => SduiRuntime(
      transport: env.transport,
      storage: env.storage,
      profile: env.profile,
      createTransport: env.createTransport,
      onOpenProfiles: env.onOpenProfiles,
      onTheme: env.onTheme,
      keymapStore: env.keymapStore,
    );

/// App shell (§8.1): empty profile list → [ServerProfilesScreen] in
/// add-first mode; otherwise [SduiHost] bound to the active profile.
///
/// Dependencies are injectable so tests can supply in-memory storage,
/// fixture-backed probes and poisoned transports.
class JhinApp extends StatefulWidget {
  const JhinApp({
    super.key,
    this.storage,
    this.createTransport,
    this.probe,
    this.createRenderer,
    this.migration,
  });

  /// Profile storage; defaults to the platform-backed [AppStorage].
  final AppStorage? storage;

  /// Transport factory per profile; defaults to [createProfileTransport].
  final JhinTransport Function(ServerProfile profile)? createTransport;

  /// Server probe for the add-server flow; defaults to [probeServer].
  final ServerProbe? probe;

  /// Screen renderer factory for the bootstrap host; defaults to
  /// [createSduiRuntime] — the T22 SDUI runtime (§8).
  final RendererFactory? createRenderer;

  /// The migration report `main()` awaited before building (§3 rule 5);
  /// drives the version-gate banner for newer-schema quarantines.
  final MigrationReport? migration;

  @override
  State<JhinApp> createState() => _JhinAppState();
}

class _JhinAppState extends State<JhinApp> {
  final GlobalKey<NavigatorState> _navigatorKey = GlobalKey<NavigatorState>();
  late final AppStorage _storage = widget.storage ?? AppStorage();
  late final KeymapStore _keymapStore = KeymapStore(_storage);
  late final JhinTransport Function(ServerProfile) _createTransport =
      widget.createTransport ?? createProfileTransport;
  late final ServerProbe _probe = widget.probe ?? probeServer;
  late final RendererFactory _createRenderer =
      widget.createRenderer ?? createSduiRuntime;

  ServerProfile? _active;
  bool _ready = false;
  ScreenRenderer? _renderer;
  String? _rendererProfileId;

  /// The minimum schema the server contract requires (§3 rule 6), extracted
  /// from the bootstrap payload's `contract` block; null until one arrives.
  int? _minSchema;

  /// Dismissal state of the two version-gate surfaces (per session; the
  /// quarantined data itself is never destroyed).
  bool _newerDismissed = false;
  bool _requiredDismissed = false;

  /// The generated design (§1): the ThemeData pair + tokens. Starts at the
  /// built-in defaults and is regenerated whenever a bootstrap payload
  /// arrives (via [RendererEnv.onTheme]).
  JhinTheme _design = JhinTheme.fallback();

  /// The bootstrap payload the current [_design] was generated from (T69);
  /// kept so an appearance change can regenerate the design in place.
  Map<String, dynamic>? _lastPayload;

  /// Client appearance overrides (T69) from `StoreKeys.appearance`:
  /// `themeMode` / `accent` win over the server theme when set.
  Map<String, dynamic> _appearance = const {};

  /// Regenerates the design from a bootstrap payload. The runtime fires
  /// this during build (the host hands the payload to the renderer), so the
  /// rebuild is deferred past the current frame. Also extracts the
  /// contract's `minSchema` for the version gate (§3 rule 6).
  void _applyTheme(Map<String, dynamic> payload) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      setState(() {
        _lastPayload = payload;
        _design = _designFrom(payload);
        final contract = payload['contract'];
        if (contract is Map) {
          final minSchema = contract['minSchema'];
          if (minSchema is int) _minSchema = minSchema;
        }
      });
    });
  }

  /// The design of [payload] with the client appearance overrides (T69)
  /// applied over the server `theme` block — the persisted `themeMode` /
  /// `accent` win when set. The rebuild rides the existing theme mechanism
  /// ([JhinTheme.fromBootstrap] over the patched payload). The whole
  /// appearance map also feeds the runtime switches (T86): the contrast
  /// pref, chat width, diff colour scheme, density, reduced motion and the
  /// font prefs.
  JhinTheme _designFrom(Map<String, dynamic> payload) {
    final patched = Map<String, dynamic>.from(payload);
    final theme = <String, dynamic>{};
    final rawTheme = payload['theme'];
    if (rawTheme is Map) {
      theme.addAll(Map<String, dynamic>.from(rawTheme));
    }
    final mode = _appearance['themeMode'];
    if (mode is String && mode.isNotEmpty) theme['appearance'] = mode;
    final accent = _appearance['accent'];
    if (accent is String && accent.isNotEmpty) theme['accent'] = accent;
    patched['theme'] = theme;
    return JhinTheme.fromBootstrap(patched, prefs: _appearance);
  }

  /// Re-reads the persisted appearance and regenerates the design (T69:
  /// `appearance.cycle` / `theme.pick`).
  Future<void> _reloadAppearance() async {
    final prefs = await AppearancePrefs.read(_storage);
    if (!mounted) return;
    setState(() {
      _appearance = prefs;
      final payload = _lastPayload;
      _design =
          payload == null ? _designFrom(const {}) : _designFrom(payload);
    });
  }

  /// Runs a client-directive list through the live runtime (T69); a no-op
  /// when the renderer is not the SDUI runtime.
  Future<void> _runDirectives(List<dynamic> directives) {
    final renderer = _renderer;
    if (renderer is SduiRuntime) return renderer.runDirectives(directives);
    return Future<void>.value();
  }

  /// The accent presets `theme.pick` cycles through (T69): the server
  /// theme's `accent` plus its `colors{}` values, in payload order.
  List<String> _accentPresets() {
    final theme = _lastPayload?['theme'];
    if (theme is! Map) return const [];
    final out = <String>[];
    final accent = theme['accent'];
    if (accent is String && accent.isNotEmpty) out.add(accent);
    final colors = theme['colors'];
    if (colors is Map) {
      for (final value in colors.values) {
        if (value is String && value.isNotEmpty && !out.contains(value)) {
          out.add(value);
        }
      }
    }
    return out;
  }

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    final prefs = await AppearancePrefs.read(_storage);
    // T70: the user keymap is loaded before the first bootstrap so the
    // effective keymap starts with the persisted overrides in place.
    await _keymapStore.load();
    final profiles = await _storage.readProfiles();
    final activeId = await _storage.readActiveProfileId();
    ServerProfile? active;
    for (final profile in profiles) {
      if (profile.id == activeId) active = profile;
    }
    active ??= profiles.isEmpty ? null : profiles.first;
    if (!mounted) return;
    setState(() {
      _appearance = prefs;
      _active = active;
      _ready = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    final active = _active;
    final minSchema = _minSchema;
    final updateRequired =
        minSchema != null && StoreMigrations.current < minSchema;
    final newerKeys = widget.migration?.newerQuarantined ?? const <String>[];
    final showNewerBanner = newerKeys.isNotEmpty && !_newerDismissed;

    Widget home;
    if (!_ready) {
      home = const Scaffold(body: Center(child: CircularProgressIndicator()));
    } else if (updateRequired && !_requiredDismissed) {
      // Rule 6: the "update required" surface — client-owned chrome, never
      // destructive ("Continue anyway" proceeds on defaults).
      home = VersionGate(
        mode: VersionGateMode.updateRequired,
        onDiskSchema: StoreMigrations.current,
        minSchema: minSchema,
        onDismiss: () => setState(() => _requiredDismissed = true),
      );
    } else if (active == null) {
      home = ServerProfilesScreen(
        storage: _storage,
        probe: _probe,
        addFirst: true,
        onSwitch: _switchTo,
        onProfilesChanged: _reload,
      );
    } else {
      home = SduiHost(
        key: ValueKey(active.id),
        profile: active,
        storage: _storage,
        transport: _boundTransport(active),
        renderer: _rendererFor(active),
        onOpenProfiles: _openProfiles,
        runDirectives: _runDirectives,
        onAppearanceChanged: () => unawaited(_reloadAppearance()),
        accentPresets: _accentPresets(),
        keymapStore: _keymapStore,
      );
    }

    return MaterialApp(
      title: 'Jhin',
      navigatorKey: _navigatorKey,
      theme: _design.light,
      darkTheme: _design.dark,
      themeMode: _design.themeMode,
      builder: (context, child) => JhinDesignScope(
        design: _design,
        child: child ?? const SizedBox.shrink(),
      ),
      home: showNewerBanner
          ? Scaffold(
              body: Column(
                children: [
                  VersionGate(
                    mode: VersionGateMode.newerVersion,
                    quarantinedKeys: newerKeys,
                    onDismiss: () => setState(() => _newerDismissed = true),
                  ),
                  Expanded(child: home),
                ],
              ),
            )
          : home,
    );
  }

  /// Creates one profile transport with the T70 `X-Jhin-Keybindings` hook
  /// bound: every JSON request carries the current user keymap overrides.
  JhinTransport _boundTransport(ServerProfile profile) {
    final transport = _createTransport(profile);
    transport.keybindingsJson = () => _keymapStore.headerJson;
    return transport;
  }

  /// Builds — and memoizes — the renderer of one profile. The runtime is
  /// stateful (screen stack, local state), so it must survive app rebuilds
  /// and only be recreated when the active profile changes.
  ScreenRenderer _rendererFor(ServerProfile profile) {
    if (_renderer == null || _rendererProfileId != profile.id) {
      final old = _renderer;
      if (old is SduiRuntime) old.dispose();
      _renderer = _createRenderer(RendererEnv(
        storage: _storage,
        profile: profile,
        transport: _boundTransport(profile),
        createTransport: _boundTransport,
        onOpenProfiles: _openProfiles,
        onTheme: _applyTheme,
        keymapStore: _keymapStore,
      ));
      _rendererProfileId = profile.id;
    }
    return _renderer!;
  }

  void _switchTo(ServerProfile profile) {
    setState(() => _active = profile);
  }

  void _openProfiles() {
    _navigatorKey.currentState!.push<void>(
      MaterialPageRoute(
        builder: (profilesContext) => ServerProfilesScreen(
          storage: _storage,
          probe: _probe,
          onSwitch: (profile) {
            Navigator.of(profilesContext).pop();
            _switchTo(profile);
          },
          onClosed: () => Navigator.of(profilesContext).pop(),
          onProfilesChanged: _reload,
        ),
      ),
    );
  }
}
