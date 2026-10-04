import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `segmented` (§2.6): `segments: [{label, value, icon?}]`, `value?`,
/// `action?` — a single-select segmented control.
///
/// Selecting a segment writes the new `value` into the screen's `UiState`
/// under the node `id` and dispatches `action` exactly once, so `include`
/// merges (§8.4) carry what the control shows. Segments without a `value`
/// entry are dropped (malformed items degrade); with no usable segments the
/// node degrades to a visible placeholder.
Widget buildSegmented(BuildContext context, UiNode node, RenderContext ctx) =>
    _SegmentedView(node: node, ctx: ctx);

class _Segment {
  const _Segment({required this.label, required this.value, this.icon});

  final String label;
  final Object value;
  final IconData? icon;
}

List<_Segment> _parseSegments(UiNode node) {
  final segments = <_Segment>[];
  for (final raw in node.listProp('segments') ?? const []) {
    final map = asMap(raw);
    if (map == null || map['value'] == null) continue;
    final label = map['label'];
    segments.add(_Segment(
      label: label is String ? label : '${map['value']}',
      value: map['value'] as Object,
      icon: iconFor(map['icon'] is String ? map['icon'] as String : null),
    ));
  }
  return segments;
}

class _SegmentedView extends StatefulWidget {
  const _SegmentedView({required this.node, required this.ctx});

  final UiNode node;
  final RenderContext ctx;

  @override
  State<_SegmentedView> createState() => _SegmentedViewState();
}

class _SegmentedViewState extends State<_SegmentedView> {
  late Object? _selected = fieldValue(widget.ctx, widget.node);

  void _select(Set<Object?> selection) {
    final value = selection.isEmpty ? null : selection.first;
    setState(() => _selected = value);
    final id = widget.node.id;
    if (id != null) {
      widget.ctx.setState(id, value);
    }
    final action = asMap(widget.node.props['action']);
    if (action != null) {
      widget.ctx.dispatch(action);
    }
  }

  @override
  Widget build(BuildContext context) {
    final segments = _parseSegments(widget.node);
    if (segments.isEmpty) {
      return degradedBox(context, 'Missing segments');
    }
    // Universal `enabled: false` (§2.1) drops the selection interaction —
    // the control keeps its layout and renders disabled.
    final enabled = widget.node.boolProp('enabled') != false;
    final current = segments.any((segment) => segment.value == _selected)
        ? _selected
        : null;
    return SegmentedButton<Object>(
      segments: [
        for (final segment in segments)
          ButtonSegment<Object>(
            value: segment.value,
            label: Text(segment.label),
            icon: segment.icon == null ? null : Icon(segment.icon),
          ),
      ],
      selected: current == null ? <Object>{} : <Object>{current},
      emptySelectionAllowed: true,
      showSelectedIcon: false,
      onSelectionChanged: enabled ? _select : null,
    );
  }
}
