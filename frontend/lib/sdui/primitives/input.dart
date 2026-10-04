import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import 'input_common.dart';

/// `input` (§2.6): the full TextField/InputDecoration prop set — the shared
/// field lives in `input_common.dart`; `multiline` defaults to `false` here
/// and to `true` on `textarea`.
///
/// Writes every change into the screen's `UiState` under `id` (§8.4); the
/// `required`/`min`/`max`/`pattern` rules are enforced by the
/// `ActionDispatcher` before an action fires, and the dispatcher's failure
/// text (the node's `errorText`) is shown inline. A missing `id` degrades
/// to a visible placeholder.
Widget buildInput(BuildContext context, UiNode node, RenderContext ctx) =>
    buildInputField(context, node, ctx);
