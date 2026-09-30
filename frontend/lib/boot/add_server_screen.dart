import 'package:flutter/material.dart';

import '../core/api/jhin_transport.dart';
import '../core/auth/app_storage.dart';

/// Outcome of probing a candidate server before its profile exists.
class ProbeResult {
  const ProbeResult({required this.health, this.certFingerprint});

  /// Decoded `GET /_jhin/health` payload (§6).
  final HealthInfo health;

  /// TOFU certificate fingerprint recorded during the handshake, or null on
  /// platforms without TLS pinning (web) or over plain HTTP.
  final String? certFingerprint;
}

/// Probes `GET {url}/_jhin/health` and reports the TOFU fingerprint pinned
/// during the handshake.
typedef ServerProbe = Future<ProbeResult> Function(String url);

/// Production [ServerProbe]: a throwaway TOFU transport, closed afterwards.
Future<ProbeResult> probeServer(String url) async {
  final transport = JhinTransport(baseUrl: Uri.parse(url));
  try {
    final health = await transport.health(url);
    return ProbeResult(
      health: health,
      certFingerprint: transport.trustStore.pendingFingerprint,
    );
  } finally {
    transport.close();
  }
}

/// Client-authored add / edit server screen (§8.1) — the only place a server
/// is probed before a profile exists.
///
/// Add mode: URL field (defaults to `https://`) + label field + Connect. The
/// probe `GET /_jhin/health` runs on submit; on success the profile is stored
/// (url + pinned fingerprint), made active and [onDone] fires. On failure the
/// transport error is shown verbatim inline. Edit mode updates the
/// client-owned metadata (label, url) without probing — the list is
/// client-owned (D-9) and must stay editable while a server is down.
class AddServerScreen extends StatefulWidget {
  const AddServerScreen({
    super.key,
    required this.storage,
    this.probe = probeServer,
    this.existing,
    this.onDone,
  });

  /// Profile storage (add / update).
  final AppStorage storage;

  /// Server probe used in add mode.
  final ServerProbe probe;

  /// Non-null in edit mode: pre-fills the fields and updates this profile.
  final ServerProfile? existing;

  /// Called with the stored profile after a successful connect (add mode) or
  /// save (edit mode).
  final void Function(ServerProfile profile)? onDone;

  @override
  State<AddServerScreen> createState() => _AddServerScreenState();
}

class _AddServerScreenState extends State<AddServerScreen> {
  late final TextEditingController _url =
      TextEditingController(text: widget.existing?.url ?? 'https://');
  late final TextEditingController _label =
      TextEditingController(text: widget.existing?.label ?? '');
  bool _busy = false;
  String? _error;

  bool get _isEdit => widget.existing != null;

  @override
  void dispose() {
    _url.dispose();
    _label.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_isEdit ? 'Edit server' : 'Add server')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 480),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextField(
                  key: const Key('url-field'),
                  controller: _url,
                  enabled: !_busy,
                  keyboardType: TextInputType.url,
                  autocorrect: false,
                  decoration: const InputDecoration(
                    labelText: 'Server URL',
                    hintText: 'https://',
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const Key('label-field'),
                  controller: _label,
                  enabled: !_busy,
                  decoration: const InputDecoration(labelText: 'Label'),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Text(
                    _error!,
                    key: const Key('connect-error'),
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                      fontFamily: 'monospace',
                    ),
                  ),
                ],
                const SizedBox(height: 20),
                FilledButton(
                  key: const Key('connect-button'),
                  onPressed: _busy ? null : (_isEdit ? _save : _connect),
                  child: Text(_isEdit ? 'Save' : 'Connect'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _connect() async {
    final url = _url.text.trim();
    final label = _label.text.trim();
    final parsed = Uri.tryParse(url);
    if (parsed == null ||
        !(parsed.isScheme('https') || parsed.isScheme('http')) ||
        parsed.host.isEmpty) {
      setState(() => _error = 'Enter a valid http(s) URL');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await widget.probe(url);
      if (result.health.status != 'ok') {
        setState(() {
          _busy = false;
          _error = 'Server reported status: ${result.health.status}';
        });
        return;
      }
      final profile = await widget.storage.addProfile(
        label: label.isEmpty ? url : label,
        url: url,
        certFingerprint: result.certFingerprint,
      );
      await widget.storage.setActiveProfileId(profile.id);
      if (!mounted) return;
      widget.onDone?.call(profile);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = '$error';
      });
    }
  }

  Future<void> _save() async {
    final url = _url.text.trim();
    final label = _label.text.trim();
    final parsed = Uri.tryParse(url);
    if (parsed == null ||
        !(parsed.isScheme('https') || parsed.isScheme('http')) ||
        parsed.host.isEmpty) {
      setState(() => _error = 'Enter a valid http(s) URL');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final updated = widget.existing!.copyWith(
      label: label.isEmpty ? url : label,
      url: url,
    );
    await widget.storage.updateProfile(updated);
    if (!mounted) return;
    widget.onDone?.call(updated);
  }
}
