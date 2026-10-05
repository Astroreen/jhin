import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../expr.dart' show evalWhen;
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';
import 'scroll_common.dart';

/// `list` (§2.6): `items` (node or string array — strings are the `text`
/// shorthand), `maxHeight`, `sections`, `separator`, `onReorder`,
/// `selection`, `itemExtent`, `prototypeItem`, `empty`. Built as a lazy
/// `ListView.builder`/`ListView.separated`: only visible rows materialize
/// (the T59 lazy upgrade).
///
/// `sections` switches to grouped mode: every section renders its label,
/// `collapsible` sections toggle on header tap (initial state `collapsed`),
/// and a section with empty `items` still shows its label plus the list's
/// `empty` node. `onReorder` builds a reorderable list and reports the new
/// id order through the action dispatch (flat mode only — sections and
/// selection/reorder do not combine, §2.4). `selection` makes plain entries
/// toggle a selected tint on tap. Top-level empty `items` renders the
/// `empty` node when present, else the visible placeholder.
///
/// The T96 section extensions (all optional, additive — a section without
/// them renders exactly as before): `when` gates the whole section with the
/// §8.7 expression grammar against the screen state (a failing or unset
/// expression keeps the section visible); `uppercase` renders the label
/// uppercased; `count` renders the rounded-full count badge over the
/// `badgeStyle` token surface (`sidebar-control-surface`); `storeKey`
/// persists the collapse state to the client store — the stored value wins
/// over the `collapsed` default once read, and every toggle writes it back.
///
/// `maxHeight` bounds the viewport; without it the list fills its bounded
/// slot, and in an unbounded parent it degrades to a content-sized
/// shrink-wrap scroller (`scroll_common.dart`) instead of asserting.
/// `itemExtent`/`prototypeItem` fix the row extent on the builder path;
/// with a `separator` the rows are laid out by `ListView.separated`, which
/// has no extent inference — those two props are ignored there (§2.4).
Widget buildList(BuildContext context, UiNode node, RenderContext ctx) {
  final rawSections = node.listProp('sections');
  final emptyProp = node.props['empty'];

  final Widget content;
  if (rawSections != null && rawSections.isNotEmpty) {
    content = _SectionedList(node: node, ctx: ctx);
  } else {
    final rawItems = node.listProp('items');
    if (rawItems == null || rawItems.isEmpty) {
      final empty =
          emptyProp == null ? null : buildChildProp(context, ctx, emptyProp);
      return empty ?? degradedBox(context, 'Missing items');
    }
    final items = [for (final item in rawItems) UiNode.fromJson(item)];
    content = node.boolProp('selection') == true
        ? _SelectionList(node: node, ctx: ctx, items: items)
        : _flatList(context, node, ctx, items);
  }

  final maxHeight = node.numProp('maxHeight')?.toDouble();
  if (maxHeight == null || maxHeight < 0) return content;
  return ConstrainedBox(
    constraints: BoxConstraints(maxHeight: maxHeight),
    child: content,
  );
}

/// The T59 lazy flat list, plus the `onReorder` affordance.
Widget _flatList(
  BuildContext context,
  UiNode node,
  RenderContext ctx,
  List<UiNode> items,
) {
  final separator = node.props['separator'];
  final itemExtent = node.numProp('itemExtent')?.toDouble();
  final prototype = separator == null && node.props['prototypeItem'] != null
      ? buildChildProp(context, ctx, node.props['prototypeItem'])
      : null;
  final reorderable = asMap(node.props['onReorder']) != null;
  return buildAdaptiveScroller(
    scrollDirection: Axis.vertical,
    shrinkWrap: false,
    scroller: (shrinkWrap) {
      if (reorderable) {
        return ReorderableListView.builder(
          shrinkWrap: shrinkWrap,
          itemCount: items.length,
          onReorderItem: (oldIndex, newIndex) =>
              _reportOrder(node, ctx, items, oldIndex, newIndex),
          itemBuilder: (context, index) => KeyedSubtree(
            key: ValueKey(items[index].id ?? 'list-item-$index'),
            child: ctx.build(context, items[index]),
          ),
        );
      }
      if (separator != null) {
        final separatorNode = UiNode.fromJson(separator);
        return ListView.separated(
          shrinkWrap: shrinkWrap,
          itemCount: items.length,
          itemBuilder: (context, index) => ctx.build(context, items[index]),
          separatorBuilder: (context, index) => ctx.build(context, separatorNode),
        );
      }
      return ListView.builder(
        shrinkWrap: shrinkWrap,
        itemExtent: itemExtent != null && itemExtent > 0 ? itemExtent : null,
        prototypeItem: prototype,
        itemCount: items.length,
        itemBuilder: (context, index) => ctx.build(context, items[index]),
      );
    },
  );
}

/// The reorder report: `onReorderItem` hands over the already-adjusted
/// post-removal `newIndex`, and the resulting id order is dispatched on the
/// `onReorder` action as `order` (§2.6 "reports the new order").
void _reportOrder(
  UiNode node,
  RenderContext ctx,
  List<UiNode> items,
  int oldIndex,
  int newIndex,
) {
  final action = asMap(node.props['onReorder']);
  if (action == null) return;
  final reordered = [...items];
  final moved = reordered.removeAt(oldIndex);
  reordered.insert(newIndex, moved);
  ctx.dispatch({
    ...action,
    'order': [for (final item in reordered) item.id ?? ''],
  });
}

/// `selection` mode: plain entries toggle a selected tint on tap.
class _SelectionList extends StatefulWidget {
  const _SelectionList({
    required this.node,
    required this.ctx,
    required this.items,
  });

  final UiNode node;
  final RenderContext ctx;
  final List<UiNode> items;

  @override
  State<_SelectionList> createState() => _SelectionListState();
}

class _SelectionListState extends State<_SelectionList> {
  final Set<int> _selected = {};

  @override
  Widget build(BuildContext context) {
    final theme = JhinDesignScope.materialOf(context);
    final separator = widget.node.props['separator'];

    Widget entry(int index) {
      final picked = _selected.contains(index);
      return InkWell(
        key: ValueKey(widget.items[index].id ?? 'list-item-$index'),
        onTap: () => setState(
          () => picked ? _selected.remove(index) : _selected.add(index),
        ),
        child: ColoredBox(
          color: picked
              ? theme.colorScheme.secondaryContainer
              : Colors.transparent,
          child: widget.ctx.build(context, widget.items[index]),
        ),
      );
    }

    return buildAdaptiveScroller(
      scrollDirection: Axis.vertical,
      shrinkWrap: false,
      scroller: (shrinkWrap) {
        if (separator != null) {
          final separatorNode = UiNode.fromJson(separator);
          return ListView.separated(
            shrinkWrap: shrinkWrap,
            itemCount: widget.items.length,
            itemBuilder: (context, index) => entry(index),
            separatorBuilder: (context, index) =>
                widget.ctx.build(context, separatorNode),
          );
        }
        return ListView.builder(
          shrinkWrap: shrinkWrap,
          itemCount: widget.items.length,
          itemBuilder: (context, index) => entry(index),
        );
      },
    );
  }
}

/// Grouped mode (`sections`): labeled groups, collapsible headers and the
/// per-section `empty` node. Slots are computed eagerly (cheap data) and
/// built lazily by the scroller.
class _SectionedList extends StatefulWidget {
  const _SectionedList({required this.node, required this.ctx});

  final UiNode node;
  final RenderContext ctx;

  @override
  State<_SectionedList> createState() => _SectionedListState();
}

class _SectionedListState extends State<_SectionedList> {
  late List<bool> _collapsed;

  /// The store keys whose persisted collapse state has already been read
  /// (one read per key, never re-scheduled on rebuild).
  final Set<String> _restoredKeys = {};

  @override
  void initState() {
    super.initState();
    _collapsed = _initialCollapsed();
    _scheduleRestore();
  }

  @override
  void didUpdateWidget(_SectionedList oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_collapsed.length != (widget.node.listProp('sections') ?? const []).length) {
      _collapsed = _initialCollapsed();
      _restoredKeys.clear();
      _scheduleRestore();
    }
  }

  List<bool> _initialCollapsed() => [
        for (final raw in widget.node.listProp('sections') ?? const [])
          asMap(raw)?['collapsed'] == true,
      ];

  /// The T96 collapse persistence: the stored value under a section's
  /// `storeKey` wins over the `collapsed` default once read (the split's
  /// restore pattern). Fire-and-forget; without a store seam the default
  /// stands.
  void _scheduleRestore() {
    final read = widget.ctx.readPersisted;
    if (read == null) return;
    final sections = widget.node.listProp('sections') ?? const <Object?>[];
    for (var s = 0; s < sections.length; s++) {
      final key = asMap(sections[s])?['storeKey'];
      if (key is! String || key.isEmpty || !_restoredKeys.add(key)) continue;
      final index = s;
      Future<void>(() async {
        final stored = await read(key);
        if (!mounted || index >= _collapsed.length || stored is! bool) return;
        if (_collapsed[index] == stored) return;
        setState(() => _collapsed[index] = stored);
      });
    }
  }

  /// Writes the collapse state of one section back under its `storeKey`.
  void _persist(int index) {
    final sections = widget.node.listProp('sections') ?? const <Object?>[];
    if (index >= sections.length) return;
    final key = asMap(sections[index])?['storeKey'];
    final write = widget.ctx.writePersisted;
    if (key is! String || key.isEmpty || write == null) return;
    Future<void>(() => write(key, _collapsed[index]));
  }

  @override
  Widget build(BuildContext context) {
    final node = widget.node;
    final ctx = widget.ctx;
    final sections = node.listProp('sections') ?? const <Object?>[];
    final emptyProp = node.props['empty'];
    final separator = node.props['separator'];

    final slots = <Widget Function(BuildContext)>[];
    for (var s = 0; s < sections.length; s++) {
      final section = asMap(sections[s]) ?? const {};
      // The T96 `when` gate: a false evaluation removes the whole section
      // (header included); a failing or unset expression keeps it visible.
      final when = section['when'];
      if (when is String && evalWhen(when, ctx.state) == false) continue;
      final collapsible = section['collapsible'] != false;
      slots.add((context) => _header(context, section, collapsible, s));
      if (_collapsed[s]) continue;
      final rawItems =
          section['items'] is List ? section['items'] as List : const [];
      if (rawItems.isEmpty) {
        if (emptyProp != null) {
          slots.add((context) => ctx.build(context, UiNode.fromJson(emptyProp)));
        }
        continue;
      }
      final items = [for (final item in rawItems) UiNode.fromJson(item)];
      for (var i = 0; i < items.length; i++) {
        final item = items[i];
        slots.add((context) => ctx.build(context, item));
        if (separator != null && i < items.length - 1) {
          final separatorNode = UiNode.fromJson(separator);
          slots.add((context) => ctx.build(context, separatorNode));
        }
      }
    }

    return buildAdaptiveScroller(
      scrollDirection: Axis.vertical,
      shrinkWrap: false,
      scroller: (shrinkWrap) => ListView.builder(
        shrinkWrap: shrinkWrap,
        itemCount: slots.length,
        itemBuilder: (context, index) => slots[index](context),
      ),
    );
  }

  Widget _header(
    BuildContext context,
    Map<Object?, Object?> section,
    bool collapsible,
    int s,
  ) {
    final theme = JhinDesignScope.materialOf(context);
    var text = section['label'] is String
        ? section['label'] as String
        : '${section['label'] ?? ''}';
    // The T96 uppercase transform: the header renders uppercased when the
    // section asks for it (the label data stays canonical).
    if (section['uppercase'] == true) text = text.toUpperCase();
    final row = Row(
      children: [
        Expanded(
          child: Text(
            text,
            style: theme.textTheme.titleSmall
                ?.copyWith(fontWeight: FontWeight.w600),
          ),
        ),
        if (section['count'] != null) _countBadge(context, section),
        if (collapsible)
          Icon(
            _collapsed[s] ? Icons.expand_more : Icons.expand_less,
            size: 20,
          ),
      ],
    );
    return InkWell(
      onTap: collapsible
          ? () {
              setState(() => _collapsed[s] = !_collapsed[s]);
              _persist(s);
            }
          : null,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: row,
      ),
    );
  }

  /// The T96 count badge: the rounded-full pill over the section's
  /// `badgeStyle` token surface with the sidebar foreground text — the
  /// upstream `bg-sidebar-control-surface text-sidebar-foreground` pill.
  Widget _countBadge(BuildContext context, Map<Object?, Object?> section) {
    final design = JhinDesignScope.of(context);
    final theme = JhinDesignScope.materialOf(context);
    final brightness = Theme.brightnessOf(context);
    final token = section['badgeStyle'] is String
        ? section['badgeStyle'] as String
        : 'sidebar-control-surface';
    // The bootstrap palette carries the token (the server pins the full
    // PaletteGen map); without it the pill degrades to the secondary
    // surface — never null (§2.4).
    final surface = design.colorOf(token, brightness: brightness) ??
        design.colorOf('secondary', brightness: brightness) ??
        theme.colorScheme.surfaceContainerHigh;
    final foreground = design.colorOf('sidebar-foreground', brightness: brightness);
    final count = section['count'];
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
      decoration: BoxDecoration(
        color: surface,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        count is num ? '${count.toInt()}' : '$count',
        style: theme.textTheme.labelSmall
            ?.copyWith(color: foreground ?? theme.colorScheme.onSurfaceVariant),
      ),
    );
  }
}
