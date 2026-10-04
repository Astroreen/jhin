import 'package:flutter/foundation.dart';

import '../core/api/jhin_transport.dart';
import 'ui_node.dart';
import 'ui_state.dart';

/// Client-side action dispatch (§8.4).
///
/// Merges the action's static `payload` with the current local values of the
/// `include`d input ids (include values win on collisions), validates the
/// included inputs first — `required`, `min`/`max`, `pattern` — and posts
/// `{"action":"<name>","payload":{…merged}}`. A failing field shows its
/// `errorText` inline and nothing is sent: zero round-trips. On a successful
/// post the response's `client` directives are executed.
///
/// An action that carries no `path` but a directive `op` is a client-side
/// effect embedded inline in a node prop (for example the server's offline
/// and error Retry buttons, §8.5): it is run as a directive directly, with no
/// round-trip.
class ActionDispatcher {
  ActionDispatcher({
    required this.transport,
    required this.state,
    required this.root,
    required this.onChanged,
    required this.runDirectives,
  });

  /// Transport the action is posted through.
  final JhinTransport transport;

  /// Local state supplying the `include` values.
  final UiState state;

  /// The current screen root — searched for included field nodes.
  final UiNode Function() root;

  /// Schedules a re-render after validation errors change.
  final VoidCallback onChanged;

  /// Runs the response's `client` directive list (§8.5).
  final Future<void> Function(List<dynamic> directives) runDirectives;

  /// Dispatches one §8.4 action object. Never throws.
  Future<void> dispatch(Map<String, dynamic> action) async {
    try {
      await _dispatch(action);
    } catch (error) {
      debugPrint('Jhin SDUI: action dispatch failed: $error');
    }
  }

  Future<void> _dispatch(Map<String, dynamic> action) async {
    final path = action['path'];
    if (path is! String || path.isEmpty) {
      // A directive-only action (`op` without `path`) is a client-side
      // effect embedded inline in a node prop — for example the server's
      // offline/error Retry buttons (§8.5). Run it directly.
      final op = action['op'];
      if (op is String && op.isNotEmpty) {
        await runDirectives([action]);
        return;
      }
      debugPrint('Jhin SDUI: ignoring action without a path: $action');
      return;
    }
    final name = action['name'] is String ? action['name'] as String : '';
    final include = <String>[
      if (action['include'] is List)
        for (final item in action['include'] as List)
          if (item is String) item,
    ];

    // Client-side validation first: a failing field blocks dispatch.
    var failed = false;
    for (final id in include) {
      final field = root().findById(id);
      final error = validateField(field, state[id]);
      state.setError(id, error);
      if (error != null) failed = true;
    }
    if (failed) {
      onChanged();
      return;
    }

    final payload = <String, dynamic>{};
    final staticPayload = action['payload'];
    if (staticPayload is Map) {
      payload.addAll(Map<String, dynamic>.from(staticPayload));
    }
    for (final id in include) {
      final value = includeValue(root().findById(id), state[id]);
      if (value != _omit) payload[id] = value;
    }

    final response =
        await transport.postJson(path, {'action': name, 'payload': payload});
    final client = response['client'];
    if (client is List) {
      await runDirectives(client);
    }
  }

  /// Validates one included field against its `value`; returns the inline
  /// error to show (its `errorText`, or a neutral default), or null when
  /// valid. Only `input`/`textarea` nodes carry validation props (§2.6).
  static String? validateField(UiNode? field, Object? value) {
    if (field == null || field.type != 'input' && field.type != 'textarea') {
      return null;
    }
    final text = value?.toString() ?? '';
    final errorText =
        field.stringProp('errorText') ?? 'Invalid value';
    if (field.boolProp('required') == true && text.isEmpty) {
      return errorText;
    }
    if (text.isEmpty) return null;
    final pattern = field.stringProp('pattern');
    if (pattern != null) {
      RegExp? regex;
      try {
        regex = RegExp(pattern);
      } catch (_) {
        regex = null;
      }
      if (regex != null && !regex.hasMatch(text)) return errorText;
    }
    final min = field.numProp('min');
    final max = field.numProp('max');
    if (min != null || max != null) {
      final asNumber = num.tryParse(text);
      if (asNumber != null) {
        if (min != null && asNumber < min) return errorText;
        if (max != null && asNumber > max) return errorText;
      } else {
        if (min != null && text.length < min) return errorText;
        if (max != null && text.length > max) return errorText;
      }
    }
    return null;
  }

  /// The typed include value of one field (§8.4): `input`/`textarea`→string,
  /// `checkbox`/`switch`→bool, `slider`→double, `dropdown`→the item's
  /// `value`; anything else is passed through as-is. Returns [_omit] when
  /// the field has no value to send (e.g. a dropdown with no selection).
  static Object? includeValue(UiNode? field, Object? value) {
    switch (field?.type) {
      case 'input':
      case 'textarea':
        return value?.toString() ?? '';
      case 'checkbox':
      case 'switch':
        return value == true;
      case 'slider':
        return value is num
            ? value.toDouble()
            : (value == null ? 0.0 : double.tryParse('$value') ?? 0.0);
      case 'dropdown':
        return value ?? _omit;
      default:
        return value ?? _omit;
    }
  }

  static const Object _omit = Object();
}
