import 'package:flutter/material.dart';

import '../core/api/jhin_transport.dart';
import '../core/auth/app_storage.dart';
import '../core/tls/tls_trust.dart';
import '../design/theme.dart';

/// Outcome of probing a candidate server before its profile exists.
class ProbeResult {
  const ProbeResult({required this.health, this.certFingerprint});

  /// Decoded `GET /_jhin/health` payload (§6).
  final HealthInfo health;

  /// TOFU certificate fingerprint recorded during the handshake, or null on
  /// platforms without TLS pinning (web) or over plain HTTP.
  final String? certFingerprint;
}

/// A successful probe plus the URL that actually answered.
///
/// [url] differs from the typed URL when the probe fell back to the alternate
/// scheme; [switched] records that, and [insecure] is true when the working
/// URL is plain HTTP (no TLS).
class _ProbeOutcome {
  const _ProbeOutcome({
    required this.url,
    required this.result,
    required this.switched,
    required this.insecure,
  });

  final String url;
  final ProbeResult result;
  final bool switched;
  final bool insecure;
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
/// (url + pinned fingerprint), made active and [onDone] fires. When the typed
/// scheme fails the alternate scheme is probed; a fallback to plain HTTP asks
/// for confirmation first. On failure the transport error is shown inline
/// (with a TLS hint when the handshake looks like a scheme mismatch). Edit
/// mode updates the client-owned metadata (label, url) without probing — the
/// list is client-owned (D-9) and must stay editable while a server is down.
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
    final spacing = JhinDesignScope.of(context).tokens.spacing;
    return Scaffold(
      appBar: AppBar(title: Text(_isEdit ? 'Edit server' : 'Add server')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 480),
          child: Padding(
            padding: EdgeInsets.symmetric(
              horizontal: spacing.lg,
              vertical: spacing.lg,
            ),
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
                      color: JhinDesignScope.materialOf(context).colorScheme.error,
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
      final outcome = await _probeWithFallback(parsed);
      if (outcome.result.health.status != 'ok') {
        setState(() {
          _busy = false;
          _error = 'Server reported status: ${outcome.result.health.status}';
        });
        return;
      }
      if (outcome.switched && outcome.insecure) {
        final proceed = await _confirmInsecure(outcome.url);
        if (!proceed) {
          if (!mounted) return;
          setState(() => _busy = false);
          return;
        }
      }
      final profile = await widget.storage.addProfile(
        label: label.isEmpty ? outcome.url : label,
        url: outcome.url,
        certFingerprint: outcome.result.certFingerprint,
      );
      await widget.storage.setActiveProfileId(profile.id);
      if (!mounted) return;
      widget.onDone?.call(profile);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = _describeConnectError(error);
      });
    }
  }

  /// Probes [parsed]; when the primary scheme fails, retries the alternate
  /// scheme so a plain-HTTP server behind an `https://` URL still connects.
  ///
  /// A [CertificateMismatch] is never downgraded — a pinned-certificate
  /// mismatch is a security signal, not a scheme mismatch. When both schemes
  /// fail the original error is rethrown so the caller reports the primary
  /// failure.
  Future<_ProbeOutcome> _probeWithFallback(Uri parsed) async {
    final primary = parsed.toString();
    try {
      final result = await widget.probe(primary);
      return _ProbeOutcome(
        url: primary,
        result: result,
        switched: false,
        insecure: parsed.isScheme('http'),
      );
    } catch (primaryError) {
      if (primaryError is CertificateMismatch) {
        rethrow;
      }
      final alternate = _alternateScheme(parsed);
      if (alternate == null) {
        rethrow;
      }
      try {
        final result = await widget.probe(alternate.toString());
        return _ProbeOutcome(
          url: alternate.toString(),
          result: result,
          switched: true,
          insecure: alternate.isScheme('http'),
        );
      } catch (_) {
        throw primaryError;
      }
    }
  }

  /// The same URL with the other http(s) scheme, or null when [uri] is neither.
  Uri? _alternateScheme(Uri uri) {
    if (uri.isScheme('https')) return uri.replace(scheme: 'http');
    if (uri.isScheme('http')) return uri.replace(scheme: 'https');
    return null;
  }

  /// Asks the user to confirm a plain-HTTP (unencrypted) connection.
  Future<bool> _confirmInsecure(String url) async {
    final host = Uri.parse(url).authority;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Insecure connection'),
        content: Text(
          'The server at $host does not use TLS. The connection would be sent '
          'over plain HTTP and is not encrypted. Continue anyway?',
        ),
        actions: [
          TextButton(
            key: const Key('insecure-cancel'),
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            key: const Key('insecure-continue'),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Continue'),
          ),
        ],
      ),
    );
    return confirmed ?? false;
  }

  /// Turns a probe failure into a message that names the likely cause.
  String _describeConnectError(Object error) {
    if (_looksLikeTlsHandshakeFailure(error)) {
      return 'TLS handshake failed. The server may not speak HTTPS. '
          'Tried both https:// and http://. ($error)';
    }
    return '$error';
  }

  bool _looksLikeTlsHandshakeFailure(Object error) {
    final text = error.toString().toLowerCase();
    return text.contains('handshake') ||
        text.contains('wrong_version_number') ||
        text.contains('tls') ||
        text.contains('ssl');
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
