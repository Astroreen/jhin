import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `chip` (§2.6): `label` (required), `icon`, `avatar`, `selected`,
/// `onDeleted`, `variant: assist|filter|input|action` (default `assist`).
///
/// A filter chip toggles its `selected` state on tap; every variant
/// dispatches the universal `action` (§2.1) on tap and `onLongPress` on a
/// long press through the chip's own handlers (the §2.3 gesture wrapper is
/// skipped for `chip`). `onDeleted` renders a delete affordance that
/// dispatches the delete action — without it the affordance is hidden. An
/// unknown variant degrades to `assist` (§2.4). The Flutter material set
/// has no `AssistChip` and chips take no `icon` parameter, so `assist`
/// renders the base `Chip` and an `icon` fills the avatar slot.
Widget buildChip(BuildContext context, UiNode node, RenderContext ctx) {
  return _Chip(node: node, ctx: ctx);
}

class _Chip extends StatefulWidget {
  const _Chip({required this.node, required this.ctx});

  final UiNode node;
  final RenderContext ctx;

  @override
  State<_Chip> createState() => _ChipState();
}

class _ChipState extends State<_Chip> {
  late bool _selected = widget.node.boolProp('selected') == true;

  void _dispatch(Map<String, dynamic> act) {
    final confirm = widget.node.stringProp('confirm');
    if (confirm != null && confirm.isNotEmpty) {
      widget.ctx.confirm(confirm, () => widget.ctx.dispatch(act));
    } else {
      widget.ctx.dispatch(act);
    }
  }

  @override
  Widget build(BuildContext context) {
    final node = widget.node;
    final ctx = widget.ctx;
    final label = node.stringProp('label');
    if (label == null || label.isEmpty) {
      return degradedBox(context, 'Missing label');
    }
    final variant = node.stringProp('variant') ?? 'assist';
    final icon = iconFor(node.stringProp('icon'));
    final avatar = buildChildProp(context, ctx, node.props['avatar']) ??
        (icon == null ? null : Icon(icon, size: 18));
    final enabled = node.boolProp('enabled') != false;
    final action = asMap(node.props['action']) ?? asMap(node.props['onTap']);
    final longPressAction = asMap(node.props['onLongPress']);
    final deleteAction = asMap(node.props['onDeleted']);

    void onTap() {
      if (variant == 'filter') {
        setState(() => _selected = !_selected);
      }
      if (action != null) _dispatch(action);
    }

    final Widget chip = switch (variant) {
      'filter' => FilterChip(
          label: Text(label),
          avatar: avatar,
          selected: _selected,
          onSelected: enabled ? (_) => onTap() : null,
        ),
      'input' => InputChip(
          label: Text(label),
          avatar: avatar,
          selected: _selected,
          onPressed: enabled ? onTap : null,
        ),
      'action' => ActionChip(
          label: Text(label),
          avatar: avatar,
          onPressed: enabled ? onTap : null,
        ),
      // `assist` and any unknown literal (§2.4 degrade): the base `Chip`
      // has no press handler, so the tap rides a `GestureDetector`.
      _ => Chip(label: Text(label), avatar: avatar),
    };

    Widget result = chip;
    if (variant != 'filter' && variant != 'input' && variant != 'action') {
      result = GestureDetector(
        onTap: enabled ? onTap : null,
        child: result,
      );
    }
    if (longPressAction != null) {
      result = GestureDetector(
        onLongPress: enabled ? () => _dispatch(longPressAction) : null,
        child: result,
      );
    }
    if (deleteAction != null) {
      result = Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          result,
          IconButton(
            icon: const Icon(Icons.delete),
            onPressed: enabled ? () => _dispatch(deleteAction) : null,
            tooltip: 'Delete',
            visualDensity: VisualDensity.compact,
          ),
        ],
      );
    }
    return result;
  }
}
