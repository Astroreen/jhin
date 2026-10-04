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
    this.root,
    this.canPop,
    this.onBack,
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

  /// The current screen root node — client-side tree lookups (the T68
  /// composer keyboard flow finds the screen's action descriptors through
  /// it). Null when the context is not backed by a screen tree.
  final UiNode Function()? root;

  /// Whether the runtime stack can pop the current screen. Absent when the
  /// context is not backed by a runtime stack.
  final bool Function()? canPop;

  /// Pops the current screen off the runtime stack; null when there is no
  /// stack to pop.
  final VoidCallback? onBack;

  /// Builds one node with patch overlays applied; every node goes through
  /// the registry so `when`, interpolation, `$token` resolution and
  /// per-node error isolation apply uniformly.
  ///
  /// [flexParent] marks the node as a direct child of a `Flex`, enabling
  /// the universal `flex`/`fit` wrap (§2.3 step 14). [stackParent] marks
  /// the node as a direct child of a `stack`, enabling the `positioned`
  /// wrap (§2.6).
  Widget build(BuildContext context, UiNode node,
      {bool flexParent = false, bool stackParent = false}) {
    final overlay = patches[node.id];
    final resolved =
        overlay == null ? node : node.copyWithProps(overlay);
    return registry.build(context, resolved, this,
        flexParent: flexParent, stackParent: stackParent);
  }
}
