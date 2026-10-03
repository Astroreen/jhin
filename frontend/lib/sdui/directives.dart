import 'package:flutter/foundation.dart';

/// The directive `op` names this client honours (§4) — exactly the ops
/// [DirectiveExecutor] runs (`undo` is a server-side lifecycle action, §3,
/// answered with directives, never sent as an inline one). Used to tell a
/// dispatchable inline action from an unknown one (`rich_text` span
/// actions).
const Set<String> kDirectiveOps = {
  'navigate',
  'back',
  'replace',
  'refresh',
  'reloadBootstrap',
  'setToken',
  'clearToken',
  'setServerUrl',
  'openProfiles',
  'toast',
  'dialog',
  'dismissDialog',
  'setState',
  'patch',
  'setScreen',
  'openUrl',
};

/// Whether [op] names a directive this client knows (§4).
bool isKnownDirectiveOp(String op) => kDirectiveOps.contains(op);

/// Side-effect sink of the client directives (§8.5), implemented by the
/// SDUI runtime. Every method maps 1:1 to one directive `op`.
abstract interface class DirectiveHost {
  /// `navigate`(screen) — pushes a screen on the stack.
  Future<void> navigate(String screen);

  /// `back` — pops the stack (no-op at the root).
  Future<void> back();

  /// `replace`(screen) — replaces the top of the stack.
  Future<void> replace(String screen);

  /// `refresh` — force re-fetch of the current screen.
  Future<void> refresh();

  /// `reloadBootstrap` — drops the screen cache and re-runs bootstrap.
  Future<void> reloadBootstrap();

  /// `setToken`(value) — stores the active profile's device token.
  Future<void> setToken(String value);

  /// `clearToken` — removes the active profile's device token.
  Future<void> clearToken();

  /// `setServerUrl`(value) — rewrites the active profile's URL only (D-9)
  /// and reboots against the new server.
  Future<void> setServerUrl(String value);

  /// `openProfiles` — opens the client-owned profile surface.
  Future<void> openProfiles();

  /// `toast`(text, style?) — shows a transient message.
  Future<void> toast(String text, String? style);

  /// `dialog`(node) — shows a modal node.
  Future<void> dialog(Map<String, dynamic> node);

  /// `dismissDialog` — closes the modal node.
  Future<void> dismissDialog();

  /// `setState`(id, value) — sets a local state value.
  Future<void> setStateValue(String id, Object? value);

  /// `patch`(id, props) — merges props into a rendered node.
  Future<void> patch(String id, Map<String, dynamic> props);

  /// `setScreen`(id, node) — installs a screen node in-memory.
  Future<void> setScreen(String id, Map<String, dynamic> node);

  /// `openUrl`(value) — opens an external URL.
  Future<void> openUrl(String value);
}

/// Runs ordered client-directive lists (§8.5) against a [DirectiveHost].
///
/// Sources: action responses and SSE events with a `client` key (§8.6).
/// An unknown `op` — or known one with malformed arguments — is ignored
/// with a debug log, and the remaining directives still run.
class DirectiveExecutor {
  DirectiveExecutor(this.host);

  final DirectiveHost host;

  Future<void> execute(List<dynamic>? directives) async {
    if (directives == null) return;
    for (final item in directives) {
      final map = item is Map ? Map<String, dynamic>.from(item) : null;
      if (map == null) {
        debugPrint('Jhin SDUI: ignoring malformed directive: $item');
        continue;
      }
      try {
        await _run(map);
      } catch (error) {
        debugPrint('Jhin SDUI: directive "${map['op']}" failed: $error');
      }
    }
  }

  Future<void> _run(Map<String, dynamic> map) async {
    final op = map['op'];
    if (op is! String) {
      debugPrint('Jhin SDUI: ignoring directive without an op: $map');
      return;
    }
    switch (op) {
      case 'navigate':
        final screen = _string(map['screen']);
        if (screen == null) return _malformed(op, map);
        return host.navigate(screen);
      case 'back':
        return host.back();
      case 'replace':
        final screen = _string(map['screen']);
        if (screen == null) return _malformed(op, map);
        return host.replace(screen);
      case 'refresh':
        return host.refresh();
      case 'reloadBootstrap':
        return host.reloadBootstrap();
      case 'setToken':
        final value = _string(map['value']);
        if (value == null) return _malformed(op, map);
        return host.setToken(value);
      case 'clearToken':
        return host.clearToken();
      case 'setServerUrl':
        final value = _string(map['value']);
        if (value == null) return _malformed(op, map);
        return host.setServerUrl(value);
      case 'openProfiles':
        return host.openProfiles();
      case 'toast':
        final text = _string(map['text']);
        if (text == null) return _malformed(op, map);
        return host.toast(text, _string(map['style']));
      case 'dialog':
        final node = map['node'];
        if (node is! Map) return _malformed(op, map);
        return host.dialog(Map<String, dynamic>.from(node));
      case 'dismissDialog':
        return host.dismissDialog();
      case 'setState':
        final id = _string(map['id']);
        if (id == null) return _malformed(op, map);
        return host.setStateValue(id, map['value']);
      case 'patch':
        final id = _string(map['id']);
        final props = map['props'];
        if (id == null || props is! Map) return _malformed(op, map);
        return host.patch(id, Map<String, dynamic>.from(props));
      case 'setScreen':
        final id = _string(map['id']);
        final node = map['node'];
        if (id == null || node is! Map) return _malformed(op, map);
        return host.setScreen(id, Map<String, dynamic>.from(node));
      case 'openUrl':
        final value = _string(map['value']);
        if (value == null) return _malformed(op, map);
        return host.openUrl(value);
      default:
        debugPrint('Jhin SDUI: ignoring unknown directive op: $op');
    }
  }

  static String? _string(Object? value) => value is String ? value : null;

  static Future<void> _malformed(String op, Map<String, dynamic> map) async {
    debugPrint('Jhin SDUI: ignoring malformed "$op" directive: $map');
  }
}
