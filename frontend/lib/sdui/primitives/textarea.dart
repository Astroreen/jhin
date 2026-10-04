import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import 'input_common.dart';

/// `textarea` (§2.6): the full `input` prop set with `multiline` defaulting
/// to `true` — the multi-line field (the composer uses `minLines: 1` /
/// `maxLines: 8`).
///
/// Shares the `input` field machinery (`input_common.dart`): state writes,
/// validation and the degrade rules are identical.
Widget buildTextarea(BuildContext context, UiNode node, RenderContext ctx) =>
    buildInputField(context, node, ctx);
