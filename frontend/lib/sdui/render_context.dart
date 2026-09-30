import 'package:flutter/widgets.dart';

import '../core/sse/sse_stream.dart';
import 'ui_node.dart';
import 'ui_registry.dart';
import 'ui_state.dart';

/// Opens the SSE stream of a `stream_view` topic (§8.6): one JSON object per
/// event; [onStatus] reports the connection lifecycle so the view can show
/// a subtle reconnect indicator.
typedef OpenStream = Stream<Map<String, dynamic>> Function(
  String topic, {
  void Function(SseConnectionStatus status)? onStatus,
});

/// Per-screen rendering context handed to [UiRegistry] builders.
///
/// Carries the screen's [state], the node builders and the four side
/// channels builders may need: action dispatch, SSE streams, client
/// directives and confirm dialogs.
class RenderContext {
  RenderContext({
    required this.state,
    required this.registry,
    required this.patches,
    required this.setState,
    required this.patch,
    required this.navigate,
    required this.dispatch,
    required this.openStream,
    required this.runDirectives,
    required this.confirm,
  });

  /// Local state of the screen being rendered (§8.7).
  final UiState state;

  /// The primitive registry children are built through.
  final UiRegistry registry;

  /// Live `patch` overlays (§8.5), id to prop overrides.
  final Map<String, Map<String, dynamic>> patches;

  /// Applies a local state change and schedules a re-render.
  final void Function(String id, Object? value) setState;

  /// Merges prop overlays into a node (`patch`, §8.5).
  final void Function(String id, Map<String, dynamic> props) patch;

  /// Pushes a screen id on the runtime's stack (`nav` items, §8.3).
  final void Function(String screen) navigate;

  /// Dispatches a §8.4 action (`payload` + `include`, validation, post).
  final Future<void> Function(Map<String, dynamic> action) dispatch;

  /// Opens the SSE stream of a `stream_view` topic (§8.6).
  final OpenStream openStream;

  /// Runs a client-directive list (§8.5) — used by SSE events.
  final Future<void> Function(List<dynamic> directives) runDirectives;

  /// Shows a confirm dialog for `button.confirm`; runs [onConfirm] on OK.
  final void Function(String message, VoidCallback onConfirm) confirm;

  /// Builds one node with patch overlays applied; every node goes through
  /// the registry so `when`, interpolation and per-node error isolation
  /// apply uniformly.
  Widget build(BuildContext context, UiNode node) {
    final overlay = patches[node.id];
    final resolved =
        overlay == null ? node : node.copyWithProps(overlay);
    return registry.build(context, resolved, this);
  }
}
