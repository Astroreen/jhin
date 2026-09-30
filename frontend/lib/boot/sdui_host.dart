import 'package:flutter/material.dart';

import '../core/api/jhin_transport.dart';
import '../core/auth/app_storage.dart';
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

  @override
  void initState() {
    super.initState();
    _load();
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
    return Scaffold(
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
        ],
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
