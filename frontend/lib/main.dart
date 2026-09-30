import 'package:flutter/material.dart';

import 'boot/add_server_screen.dart';
import 'boot/screen_renderer.dart';
import 'boot/server_profiles_screen.dart';
import 'boot/sdui_host.dart';
import 'core/api/jhin_transport.dart';
import 'core/auth/app_storage.dart';
import 'core/tls/tls_trust.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const JhinApp());
}

/// Builds the transport bound to one stored profile: base URL, TOFU-pinned
/// certificate (when a fingerprint is recorded) and the device token.
JhinTransport createProfileTransport(ServerProfile profile) => JhinTransport(
      baseUrl: Uri.parse(profile.url),
      trustStore: TrustStore(pinnedFingerprint: profile.certFingerprint),
      token: profile.token,
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
  /// [GenericScreenRenderer] until the T22 runtime lands.
  final ScreenRenderer Function()? createRenderer;

  @override
  State<JhinApp> createState() => _JhinAppState();
}

class _JhinAppState extends State<JhinApp> {
  final GlobalKey<NavigatorState> _navigatorKey = GlobalKey<NavigatorState>();
  late final AppStorage _storage = widget.storage ?? AppStorage();
  late final JhinTransport Function(ServerProfile) _createTransport =
      widget.createTransport ?? createProfileTransport;
  late final ServerProbe _probe = widget.probe ?? probeServer;
  late final ScreenRenderer Function() _createRenderer =
      widget.createRenderer ?? (() => const GenericScreenRenderer());

  ServerProfile? _active;
  bool _ready = false;

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
    return MaterialApp(
      title: 'Jhin',
      navigatorKey: _navigatorKey,
      home: !_ready
          ? const Scaffold(body: Center(child: CircularProgressIndicator()))
          : _active == null
              ? ServerProfilesScreen(
                  storage: _storage,
                  probe: _probe,
                  addFirst: true,
                  onSwitch: _switchTo,
                  onProfilesChanged: _reload,
                )
              : SduiHost(
                  key: ValueKey(_active!.id),
                  profile: _active!,
                  storage: _storage,
                  transport: _createTransport(_active!),
                  renderer: _createRenderer(),
                  onOpenProfiles: _openProfiles,
                ),
    );
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
