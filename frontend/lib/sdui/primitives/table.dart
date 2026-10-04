import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `table` v2 (§2.6): `columns: [{label, width?, sortable?, align?}]`,
/// `rows: [[UiNode|string]]` plus `zebra`, `hoverable`, `onRowTap`,
/// `stickyHeader`, `sort` and `empty`.
///
/// `width` is a flex weight (default 1). A cell may be a node or a string
/// (`text`). A sortable column header tap dispatches `onSort` with
/// `{column, ascending}` merged into its payload; a row tap dispatches
/// `onRowTap` exactly once. Missing `columns` degrades to a visible
/// placeholder; missing/empty `rows` renders the header plus the `empty`
/// node (§2.6).
Widget buildTable(BuildContext context, UiNode node, RenderContext ctx) {
  final columns = node.listProp('columns');
  if (columns == null || columns.isEmpty) {
    return degradedBox(context, 'Missing columns');
  }
  final rows = node.listProp('rows');
  final flexes = <int>[];
  final headers = <String>[];
  final aligns = <String?>[];
  final sortable = <bool>[];
  for (final raw in columns) {
    final map = asMap(raw);
    headers.add('${map?['label'] ?? ''}');
    final width = map?['width'];
    flexes.add(width is num && width > 0 ? width.round() : 1);
    aligns.add(map?['align'] is String ? map!['align'] as String : null);
    sortable.add(map?['sortable'] == true);
  }
  final onSort = asMap(node.props['onSort']);
  final onRowTap = asMap(node.props['onRowTap']);
  final sort = asMap(node.props['sort']);
  final zebra = node.boolProp('zebra') == true;
  final hoverable = node.boolProp('hoverable') == true;
  final enabled = node.boolProp('enabled') != false;

  final header = Row(
    children: [
      for (var i = 0; i < headers.length; i++)
        Expanded(
          flex: i < flexes.length ? flexes[i] : 1,
          child: _headerCell(
            context,
            label: headers[i],
            align: i < aligns.length ? aligns[i] : null,
            sortable: i < sortable.length && sortable[i],
            sorted: sort != null && sort['column'] == headers[i],
            ascending: sort?['ascending'] != false,
            enabled: enabled,
            onSort: onSort,
            onTap: () {
              final next = sort != null && sort['column'] == headers[i]
                  ? sort['ascending'] == false
                  : true;
              _dispatchSort(ctx, onSort!, headers[i], next);
            },
          ),
        ),
    ],
  );

  if (rows == null || rows.isEmpty) {
    final empty = node.props['empty'];
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        header,
        const Divider(height: 1),
        if (empty != null) ctx.build(context, UiNode.fromJson(empty)),
      ],
    );
  }

  final body = <Widget>[
    for (var r = 0; r < rows.length; r++)
      if (rows[r] is List)
        _row(
          context,
          ctx,
          cells: (rows[r] as List).cast<Object?>(),
          flexes: flexes,
          aligns: aligns,
          tint: zebra && r.isOdd ? JhinDesignScope.materialOf(context).hoverColor : null,
          hoverable: hoverable,
          onRowTap: enabled ? onRowTap : null,
        ),
  ];

  if (node.boolProp('stickyHeader') != true) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [header, const Divider(height: 1), ...body],
    );
  }
  // `stickyHeader` (§2.6): the header stays outside the scrollable rows.
  return LayoutBuilder(
    builder: (context, constraints) {
      final maxHeight =
          constraints.hasBoundedHeight ? constraints.maxHeight : double.infinity;
      return Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          header,
          const Divider(height: 1),
          ConstrainedBox(
            constraints: BoxConstraints(maxHeight: maxHeight),
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: body,
              ),
            ),
          ),
        ],
      );
    },
  );
}

Widget _headerCell(
  BuildContext context, {
  required String label,
  required String? align,
  required bool sortable,
  required bool sorted,
  required bool ascending,
  required bool enabled,
  required Map<String, dynamic>? onSort,
  required VoidCallback onTap,
}) {
  final text = Text(
    label,
    style: const TextStyle(fontWeight: FontWeight.bold),
    textAlign: _textAlign(align),
  );
  if (!sortable || onSort == null || !enabled) {
    return _aligned(align, text);
  }
  return _aligned(
    align,
    InkWell(
      onTap: onTap,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Flexible(child: text),
          if (sorted)
            Icon(iconFor(ascending ? 'arrow_upward' : 'arrow_downward')),
        ],
      ),
    ),
  );
}

void _dispatchSort(
  RenderContext ctx,
  Map<String, dynamic> action,
  String column,
  bool ascending,
) {
  final payload = <String, dynamic>{};
  final staticPayload = action['payload'];
  if (staticPayload is Map) {
    payload.addAll(Map<String, dynamic>.from(staticPayload));
  }
  payload['column'] = column;
  payload['ascending'] = ascending;
  ctx.dispatch({
    ...action,
    'payload': payload,
  });
}

Widget _row(
  BuildContext context,
  RenderContext ctx, {
  required List<Object?> cells,
  required List<int> flexes,
  required List<String?> aligns,
  required Color? tint,
  required bool hoverable,
  required Map<String, dynamic>? onRowTap,
}) {
  final content = Container(
    color: tint,
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < cells.length; i++)
          Expanded(
            flex: i < flexes.length ? flexes[i] : 1,
            child: _aligned(
              i < aligns.length ? aligns[i] : null,
              ctx.build(context, UiNode.fromJson(cells[i])),
            ),
          ),
      ],
    ),
  );
  if (onRowTap == null && !hoverable) {
    return content;
  }
  return InkWell(
    onTap: onRowTap == null ? null : () => ctx.dispatch(onRowTap),
    hoverColor: hoverable ? null : Colors.transparent,
    child: content,
  );
}

Widget _aligned(String? align, Widget child) {
  final alignment = _alignment(align);
  return alignment == null ? child : Align(alignment: alignment, child: child);
}

Alignment? _alignment(String? align) {
  switch (align) {
    case 'left':
    case 'start':
    case 'justify':
      return Alignment.centerLeft;
    case 'right':
    case 'end':
      return Alignment.centerRight;
    case 'center':
      return Alignment.center;
  }
  return null;
}

TextAlign? _textAlign(String? align) {
  switch (align) {
    case 'left':
      return TextAlign.left;
    case 'right':
      return TextAlign.right;
    case 'center':
      return TextAlign.center;
    case 'justify':
      return TextAlign.justify;
    case 'start':
      return TextAlign.start;
    case 'end':
      return TextAlign.end;
  }
  return null;
}
