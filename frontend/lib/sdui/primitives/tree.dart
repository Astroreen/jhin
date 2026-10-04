import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `tree` (§2.6): `items` (nested `{label, icon?, expanded?, action?,
/// items?}`) and `onSelect` (fired with the selected item).
///
/// Each row expands/collapses its own children through the leading chevron;
/// selecting a row dispatches the item's `action` (when present) and the
/// tree's `onSelect` with the item merged into its payload. Unknown or
/// missing item fields degrade silently — a malformed tree never crashes
/// the screen (§2.4).
Widget buildTree(BuildContext context, UiNode node, RenderContext ctx) {
  final items = node.listProp('items');
  if (items == null || items.isEmpty) {
    return const SizedBox.shrink();
  }
  final onSelect = asMap(node.props['onSelect']);
  return Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      for (final raw in items)
        _TreeItem(item: raw, ctx: ctx, onSelect: onSelect, depth: 0),
    ],
  );
}

class _TreeItem extends StatefulWidget {
  const _TreeItem({
    required this.item,
    required this.ctx,
    required this.onSelect,
    required this.depth,
  });

  final Object? item;
  final RenderContext ctx;
  final Map<String, dynamic>? onSelect;
  final int depth;

  @override
  State<_TreeItem> createState() => _TreeItemState();
}

class _TreeItemState extends State<_TreeItem> {
  late bool _expanded;

  Map<String, dynamic>? get _map => asMap(widget.item);

  @override
  void initState() {
    super.initState();
    _expanded = _map?['expanded'] == true;
  }

  void _select(Map<String, dynamic> item) {
    final ctx = widget.ctx;
    final action = asMap(item['action']);
    if (action != null) ctx.dispatch(action);
    final onSelect = widget.onSelect;
    if (onSelect != null) {
      final payload = <String, dynamic>{};
      final staticPayload = onSelect['payload'];
      if (staticPayload is Map) {
        payload.addAll(Map<String, dynamic>.from(staticPayload));
      }
      payload['item'] = item;
      ctx.dispatch({
        ...onSelect,
        'payload': payload,
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final item = _map;
    if (item == null) return const SizedBox.shrink();
    final children = [
      for (final raw in item['items'] is List ? item['items'] as List : const [])
        if (asMap(raw) != null) raw,
    ];
    final label = item['label'] is String ? item['label'] as String : '';
    final icon = item['icon'];
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        InkWell(
          onTap: () => _select(item),
          child: Padding(
            padding: EdgeInsets.only(left: 16.0 * widget.depth),
            child: Row(
              children: [
                if (children.isEmpty)
                  const SizedBox(width: 24)
                else
                  InkWell(
                    onTap: () => setState(() => _expanded = !_expanded),
                    child: Icon(iconFor(_expanded ? 'expand_more' : 'chevron_right')),
                  ),
                if (icon is String && icon.isNotEmpty) ...[
                  const SizedBox(width: 4),
                  Icon(iconFor(icon)),
                ],
                const SizedBox(width: 4),
                Expanded(child: Text(label)),
              ],
            ),
          ),
        ),
        if (_expanded)
          for (final child in children)
            _TreeItem(
              item: child,
              ctx: widget.ctx,
              onSelect: widget.onSelect,
              depth: widget.depth + 1,
            ),
      ],
    );
  }
}
