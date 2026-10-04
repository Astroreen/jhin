import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `sheet` (§2.6): `title` (string or node), `body` (node), `footer` (node),
/// `height` (num or token), `dismissible` (bool, default `true`).
///
/// A modal bottom-sheet surface: a dismiss scrim fills the node's box and
/// the panel sits on its bottom edge with a drag handle, the optional title,
/// body and footer. Tapping the scrim dismisses the sheet unless
/// `dismissible` is `false` (the barrier absorbs the tap and the sheet
/// stays). `height` sizes the panel; it shares the wire key with the
/// universal box height (§2.3 step 5), which boxes the node to the same
/// extent — so with `height` set the panel fills the node box and the scrim
/// sits behind it (documented degrade: outside-tap dismissal applies while
/// the box is taller than the panel, i.e. without `height`). The same chrome
/// opens over the `dialog` directive with `kind: "sheet"` through
/// [buildSheetChrome].
Widget buildSheet(BuildContext context, UiNode node, RenderContext ctx) =>
    _SheetView(node: node, ctx: ctx);

/// The bottom-sheet panel chrome shared by the `sheet` primitive and the
/// `dialog` directive's `kind: "sheet"` presentation: rounded top corners
/// over a drag handle and the given content.
Widget buildSheetChrome(BuildContext context, Widget content) {
  final theme = JhinDesignScope.materialOf(context);
  final tokens = JhinDesignScope.of(context).tokens;
  return Material(
    color: theme.colorScheme.surface,
    elevation: tokens.elevation.md,
    borderRadius:
        BorderRadius.vertical(top: Radius.circular(tokens.radius.lg)),
    clipBehavior: Clip.antiAlias,
    child: Padding(
      padding: EdgeInsets.all(tokens.spacing.md),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Center(
            child: Container(
              width: 32,
              height: 4,
              decoration: BoxDecoration(
                color: theme.dividerColor,
                borderRadius: BorderRadius.circular(tokens.radius.full),
              ),
            ),
          ),
          SizedBox(height: tokens.spacing.sm),
          content,
        ],
      ),
    ),
  );
}

class _SheetView extends StatefulWidget {
  const _SheetView({required this.node, required this.ctx});

  final UiNode node;
  final RenderContext ctx;

  @override
  State<_SheetView> createState() => _SheetViewState();
}

class _SheetViewState extends State<_SheetView> {
  bool _open = true;

  @override
  Widget build(BuildContext context) {
    if (!_open) return const SizedBox.shrink();
    final node = widget.node;
    final ctx = widget.ctx;
    final dismissible = node.boolProp('dismissible') != false;
    final height = node.numProp('height')?.toDouble();
    return LayoutBuilder(builder: (context, constraints) {
      final available =
          constraints.maxHeight.isFinite ? constraints.maxHeight : double.infinity;
      final panelHeight = height == null ? null : math.min(height, available);
      return Stack(
        children: [
          Positioned.fill(
            child: ModalBarrier(
              dismissible: dismissible,
              color: Colors.black45,
              onDismiss: () => setState(() => _open = false),
            ),
          ),
          Align(
            alignment: Alignment.bottomCenter,
            child: SizedBox(
              height: panelHeight,
              child: buildSheetChrome(context, _body(context, node, ctx)),
            ),
          ),
        ],
      );
    });
  }

  Widget _body(BuildContext context, UiNode node, RenderContext ctx) {
    final titleProp = node.props['title'];
    final Widget? title = titleProp == null
        ? null
        : titleProp is String
            ? Text(titleProp, style: const TextStyle(fontWeight: FontWeight.bold))
            : buildChildProp(context, ctx, titleProp);
    final body = buildChildProp(context, ctx, node.props['body']);
    final footer = buildChildProp(context, ctx, node.props['footer']);
    final tokens = JhinDesignScope.of(context).tokens;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (title != null)
          Padding(
            padding: EdgeInsets.only(bottom: tokens.spacing.sm),
            child: title,
          ),
        ?body,
        if (footer != null)
          Padding(
            padding: EdgeInsets.only(top: tokens.spacing.sm),
            child: footer,
          ),
      ],
    );
  }
}
