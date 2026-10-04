import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import 'input_common.dart';

/// `textarea` (§2.6): the full `input` prop set with `multiline` defaulting
/// to `true` — the multi-line field (the composer uses `minLines: 1` /
/// `maxLines: 8`).
///
/// Shares the `input` field machinery (`input_common.dart`): state writes,
/// validation and the degrade rules are identical. The field carrying the
/// reserved id `messageInput` additionally attaches itself as the composer
/// host of the T68 keyboard flow (`ComposerScope`).
Widget buildTextarea(BuildContext context, UiNode node, RenderContext ctx) =>
    buildInputField(context, node, ctx);
