import 'package:flutter/material.dart';

import 'boot/add_server_screen.dart';
import 'boot/screen_renderer.dart';
import 'boot/server_profiles_screen.dart';
import 'boot/sdui_host.dart';
import 'core/api/jhin_transport.dart';
import 'core/auth/app_storage.dart';
import 'core/tls/tls_trust.dart';
import 'sdui/sdui_runtime.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const JhinApp(createRenderer: createSduiRuntime));
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

  @override
  State<JhinApp> createState() => _JhinAppState();
}

class _JhinAppState extends State<JhinApp> {
  final GlobalKey<NavigatorState> _navigatorKey = GlobalKey<NavigatorState>();
  late final AppStorage _storage = widget.storage ?? AppStorage();
  late final JhinTransport Function(ServerProfile) _createTransport =
      widget.createTransport ?? createProfileTransport;
  late final ServerProbe _probe = widget.probe ?? probeServer;
  late final RendererFactory _createRenderer =
      widget.createRenderer ?? createSduiRuntime;

  ServerProfile? _active;
  bool _ready = false;
  ScreenRenderer? _renderer;
  String? _rendererProfileId;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    final profiles = await _storage.readProfiles();
    final activeId = await _storage.readActiveProfileId();
    ServerProfile? active;
    for (final profile in profiles) {
      if (profile.id == activeId) active = profile;
    }
    active ??= profiles.isEmpty ? null : profiles.first;
    if (!mounted) return;
    setState(() {
      _active = active;
      _ready = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    final active = _active;
    return MaterialApp(
      title: 'Jhin',
      navigatorKey: _navigatorKey,
      home: !_ready
          ? const Scaffold(body: Center(child: CircularProgressIndicator()))
          : active == null
              ? ServerProfilesScreen(
                  storage: _storage,
                  probe: _probe,
                  addFirst: true,
                  onSwitch: _switchTo,
                  onProfilesChanged: _reload,
                )
              : SduiHost(
                  key: ValueKey(active.id),
                  profile: active,
                  storage: _storage,
                  transport: _createTransport(active),
                  renderer: _rendererFor(active),
                  onOpenProfiles: _openProfiles,
                ),
    );
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
        transport: _createTransport(profile),
        createTransport: _createTransport,
        onOpenProfiles: _openProfiles,
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
