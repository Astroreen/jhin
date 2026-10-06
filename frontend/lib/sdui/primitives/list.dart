import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

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
/// The T97 sidebar extensions (all optional): `header`/`footer` render a
/// node pinned above/below the scrollable (outside it — the sidebar's
/// header and footer blocks stay visible while the sections scroll);
/// `search` (`{key, fields?, empty?}`) filters the section items client-side
/// against the UiState string under `key` — a row stays when its title or
/// subtitle (the `fields` list, default `title`/`subtitle`) contains the
/// query ASCII case-folded (the upstream `foldAsciiCase`,
/// `apps/web/src/components/ThreadSearchMatch.tsx:1-4`, commit 37de6cb) —
/// and a match-count line renders above the sections while the query is
/// non-empty (`N matches`, or the `empty` text — the upstream
/// "No threads found", `apps/web/src/components/Sidebar.tsx:5040-5046` —
/// when nothing matches).
///
/// The T99 drag choreography (sectioned mode only — the flat list ignores
/// the props): rows carrying `draggable: true` can be picked up with a
/// long-press. While a drag is active the list drives the upstream
/// sidebar choreography (t3code commit 37de6cb):
/// - the dragged row renders as the lifted card (`dragging`) with its
///   trailing cluster replaced by the reveal-label chip — the `dragLabel`
///   template with the hovered target's badge word and icon swapped in
///   (the upstream `dropVerbBadge`, `Sidebar.tsx:1041-1070`);
/// - sections carrying a `boundaryLabel` render their header as the
///   boundary anatomy (label + divider line — the upstream
///   `.sidebar-drag-boundary-label`, `Sidebar.tsx:723-754`) once the
///   reveal delay has passed; the reveal is the port of
///   `@keyframes sidebar-drag-label-reveal` (`index.css:2154-2165`,
///   upstream a fixed 200 ms step-end) timed by the `motion.panel`
///   duration (the plan's T99 step 2; the Jhin token default is 0 ms, so
///   the reveal is immediate unless the host raises the panel duration);
/// - a section whose id is in the dragged row's `dropTargets` takes the
///   accent colour on its header/boundary while hovered
///   (`accentWhenHovered`);
/// - dropping on a target dispatches the target's `action` exactly once;
///   dropping anywhere else cancels and dispatches nothing;
/// - `Escape` cancels the drag and restores the resting tree.
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
  final header = node.props['header'];
  final footer = node.props['footer'];

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

  // The T97 header/footer: pinned outside the scrollable, above and below
  // it (the sidebar chrome stays visible while the sections scroll).
  Widget wrap(Widget child) {
    var wrapped = child;
    final footerWidget =
        footer == null ? null : buildChildProp(context, ctx, footer);
    final headerWidget =
        header == null ? null : buildChildProp(context, ctx, header);
    if (headerWidget != null || footerWidget != null) {
      wrapped = Column(
        children: [
          ?headerWidget,
          Expanded(child: wrapped),
          ?footerWidget,
        ],
      );
    }
    return wrapped;
  }

  final maxHeight = node.numProp('maxHeight')?.toDouble();
  if (maxHeight == null || maxHeight < 0) return wrap(content);
  return ConstrainedBox(
    constraints: BoxConstraints(maxHeight: maxHeight),
    child: wrap(content),
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

/// One resolved drop target of a draggable row (the `dropTargets[]` entry):
/// the section `id`, the badge `label` shown while hovered, whether the
/// hovered header takes the accent colour, and the action the drop
/// dispatches (absent for a purely decorative drag).
class _DropTarget {
  _DropTarget(Map<Object?, Object?> raw)
      : id = raw['id'] is String ? raw['id'] as String : '',
        label = raw['label'] is String ? raw['label'] as String : '',
        accentWhenHovered = raw['accentWhenHovered'] == true,
        action = raw['action'] is Map
            ? Map<String, dynamic>.from(raw['action'] as Map)
            : null;

  final String id;
  final String label;
  final bool accentWhenHovered;
  final Map<String, dynamic>? action;
}

/// The live drag session of the sectioned list: the dragged row, its
/// resolved targets, the pointer, the hovered target and the reveal state.
class _DragSession {
  _DragSession(
    this.rowId,
    this.targets,
    this.dragLabel,
    this.grabOffset, {
    required this.cardWidth,
    required this.design,
  });

  /// The dragged row node id.
  final String rowId;

  /// The row's drop targets by section id.
  final Map<String, _DropTarget> targets;

  /// The reveal-label chip template (the row's `dragLabel` node), or null
  /// when the row carries none (the client builds the default chip).
  final UiNode? dragLabel;

  /// The pointer offset inside the dragged row at pickup (the feedback
  /// card hangs from the grab point, the dnd-kit grab anchor).
  final Offset grabOffset;

  /// The dragged row's width at pickup (the feedback card keeps it).
  final double cardWidth;

  /// The design scope at pickup (re-injected above the root overlay).
  final JhinTheme design;

  /// The pointer position, driven through a notifier so the overlay
  /// feedback follows without rebuilding the list.
  final ValueNotifier<Offset> pointer = ValueNotifier<Offset>(Offset.zero);

  /// The hovered drop-target section id, or null when the pointer is over
  /// no valid target (no badge, no accent — the upstream resting drag).
  String? hover;

  /// Whether the reveal delay has passed (the
  /// `sidebar-drag-label-reveal` step-end flip).
  bool revealed = false;

  /// The exactly-once guard: the first accepted drop dispatches, every
  /// later event (a second target under the pointer, a repeated callback)
  /// is ignored.
  bool dispatched = false;
}

/// The badge icon of a drop-target word (the upstream `dropVerbBadge`
/// icons, `Sidebar.tsx:1041-1070`, mapped onto the client registry — the
/// lucide `PinOff` has no Material counterpart, so `highlight_off` stands
/// in; the mapping is recorded in `evidence/T99/icon-map.json`).
const Map<String, String> _dragBadgeIcons = {
  'Pin': 'push_pin',
  'Unpin': 'highlight_off',
  'Settle': 'check_circle',
  'Un-settle': 'undo',
  'Wake': 'alarm_off',
};

/// Grouped mode (`sections`): labeled groups, collapsible headers and the
/// per-section `empty` node. Slots are computed eagerly (cheap data) and
/// built lazily by the scroller. Since T99 the sectioned list also drives
/// the drag choreography of its `draggable` rows (see the `list` doc).
class _SectionedList extends StatefulWidget {
  const _SectionedList({required this.node, required this.ctx});

  final UiNode node;
  final RenderContext ctx;

  @override
  State<_SectionedList> createState() => _SectionedListState();
}

class _SectionedListState extends State<_SectionedList> {
  late List<bool> _collapsed;

  /// The T99 drag session (null while no drag is active).
  _DragSession? _drag;

  /// The reveal-delay timer (the `motion.panel` step-end flip).
  Timer? _revealTimer;

  /// The Escape handler installed while a drag is active (the upstream
  /// `SidebarPointerSensor` keydown cancel, `Sidebar.pointer.ts:115`).
  bool Function(KeyEvent)? _escapeHandler;

  /// The scroll viewport box (the last section's hit region ends at its
  /// bottom, so a drop on the pinned footer never settles).
  final GlobalKey _viewportKey = GlobalKey();

  /// One header key per section id — the hit-test anchors of the drag
  /// regions (a section spans from its header top to the next header top).
  final Map<String, GlobalKey> _sectionKeys = {};

  /// The overlay entry carrying the dragged card (removed on drop/cancel).
  OverlayEntry? _overlay;

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

  @override
  void dispose() {
    // The quiet teardown: no setState on a defunct element.
    _revealTimer?.cancel();
    _revealTimer = null;
    final handler = _escapeHandler;
    if (handler != null) {
      HardwareKeyboard.instance.removeHandler(handler);
      _escapeHandler = null;
    }
    _overlay?.remove();
    _overlay = null;
    _drag = null;
    super.dispose();
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
    final search = asMap(node.props['search']);

    // The T97 client-side search: the UiState query under `search.key`
    // filters every section's items against the row's `fields` (default
    // title/subtitle), ASCII case-folded. An empty query shows everything.
    final queryKey = search == null ? null : search['key'];
    final query = queryKey is String
        ? (ctx.state.values[queryKey] ?? '')?.toString() ?? ''
        : '';
    final searching = search != null && query.isNotEmpty;
    final fields = search == null
        ? const ['title', 'subtitle']
        : (search['fields'] is List && (search['fields'] as List).isNotEmpty
            ? [for (final f in search['fields'] as List) f.toString()]
            : const ['title', 'subtitle']);
    final foldedQuery = _foldAscii(query);

    var matches = 0;
    final slots = <Widget Function(BuildContext)>[];
    for (var s = 0; s < sections.length; s++) {
      final section = asMap(sections[s]) ?? const {};
      // The T96 `when` gate: a false evaluation removes the whole section
      // (header included); a failing or unset expression keeps it visible.
      final when = section['when'];
      if (when is String && evalWhen(when, ctx.state) == false) continue;
      final collapsible = section['collapsible'] != false;
      final sectionId = _sectionId(section, s);
      slots.add((context) => _header(context, section, collapsible, s, sectionId));
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
        if (searching && !_matches(item, fields, foldedQuery)) continue;
        matches++;
        slots.add((context) => _itemSlot(context, item, sectionId));
        if (separator != null && i < items.length - 1) {
          final separatorNode = UiNode.fromJson(separator);
          slots.add((context) => ctx.build(context, separatorNode));
        }
      }
    }

    // The match-count line above the sections while searching (the plan's
    // T97 step 1c; the zero-matches text is the upstream
    // "No threads found", Sidebar.tsx:5040-5046).
    if (searching) {
      final line = matches == 0 ? 'No threads found' : '$matches matches';
      slots.insert(
        0,
        (context) => Semantics(
          label: 'Find work',
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            child: Text(
              line,
              style: JhinDesignScope.materialOf(context)
                  .textTheme
                  .bodySmall
                  ?.copyWith(
                    color: JhinDesignScope.materialOf(context)
                        .colorScheme
                        .onSurfaceVariant,
                  ),
            ),
          ),
        ),
      );
    }

    return KeyedSubtree(
      key: _viewportKey,
      child: buildAdaptiveScroller(
        scrollDirection: Axis.vertical,
        shrinkWrap: false,
        scroller: (shrinkWrap) => ListView.builder(
          shrinkWrap: shrinkWrap,
          itemCount: slots.length,
          itemBuilder: (context, index) => slots[index](context),
        ),
      ),
    );
  }

  /// The section id of one section spec (the drop-target identity; a
  /// section without an explicit id falls back to its index).
  String _sectionId(Map<Object?, Object?> section, int index) {
    final id = section['id'];
    return id is String && id.isNotEmpty ? id : 'section-$index';
  }

  /// Whether one row node matches the folded query on any of the `fields`
  /// string props (a string prop or a flat text node's `text`).
  bool _matches(UiNode item, List<String> fields, String foldedQuery) {
    for (final field in fields) {
      final value = item.props[field];
      final text = value is String ? value : asMap(value)?['text']?.toString();
      if (text != null && _foldAscii(text).contains(foldedQuery)) return true;
    }
    return false;
  }

  Widget _header(
    BuildContext context,
    Map<Object?, Object?> section,
    bool collapsible,
    int s,
    String sectionId,
  ) {
    final drag = _drag;
    final boundary = section['boundaryLabel'] is String
        ? section['boundaryLabel'] as String
        : null;
    Widget header;
    if (drag != null && boundary != null && drag.revealed) {
      // The T99 boundary anatomy (the upstream `.sidebar-drag-boundary-label`
      // row: label + divider line, `Sidebar.tsx:736-752`): it replaces the
      // resting header while the drag is revealed — the upstream markers
      // exist only during a drag.
      header = _boundaryRow(context, boundary, drag, sectionId);
    } else {
      header = _restingHeader(context, section, collapsible, s, drag, sectionId);
    }
    // The hit-test anchor of this section's drag region.
    return KeyedSubtree(
      key: _sectionKeys.putIfAbsent(sectionId, GlobalKey.new),
      child: header,
    );
  }

  /// The boundary row of one section during a revealed drag: the label
  /// (accent while this section is the hovered target) over the divider
  /// line (`text-primary` / `bg-primary/50` vs `text-sidebar-foreground/80`
  /// / `bg-sidebar-foreground/25`, `Sidebar.tsx:738-750`).
  Widget _boundaryRow(
    BuildContext context,
    String label,
    _DragSession drag,
    String sectionId,
  ) {
    final theme = JhinDesignScope.materialOf(context);
    final design = JhinDesignScope.of(context);
    final brightness = Theme.brightnessOf(context);
    final target = drag.hover == null ? null : drag.targets[drag.hover!];
    final accent = target != null &&
        target.accentWhenHovered &&
        drag.hover == sectionId;
    final foreground = design.colorOf('sidebar-foreground', brightness: brightness);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: SizedBox(
        height: 18,
        child: Row(
          children: [
            Text(
              label,
              style: theme.textTheme.labelMedium?.copyWith(
                fontWeight: FontWeight.w500,
                color: accent
                    ? theme.colorScheme.primary
                    : (foreground ?? theme.colorScheme.onSurface)
                        .withValues(alpha: 0.8),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Container(
                height: 1,
                color: accent
                    ? theme.colorScheme.primary.withValues(alpha: 0.5)
                    : (foreground ?? theme.colorScheme.onSurface)
                        .withValues(alpha: 0.25),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// The resting header (the T96 chrome), with the T99 accent tint while a
  /// drag hovers this section (the upstream shelf-header `accent` tone,
  /// `Sidebar.tsx:784-787`).
  Widget _restingHeader(
    BuildContext context,
    Map<Object?, Object?> section,
    bool collapsible,
    int s,
    _DragSession? drag,
    String sectionId,
  ) {
    final theme = JhinDesignScope.materialOf(context);
    var text = section['label'] is String
        ? section['label'] as String
        : '${section['label'] ?? ''}';
    // The T96 uppercase transform: the header renders uppercased when the
    // section asks for it (the label data stays canonical).
    if (section['uppercase'] == true) text = text.toUpperCase();
    final target = drag == null ? null : drag.targets[sectionId];
    final accent = target != null &&
        target.accentWhenHovered &&
        drag!.hover == sectionId;
    final row = Row(
      children: [
        Expanded(
          child: Text(
            text,
            style: theme.textTheme.titleSmall?.copyWith(
              fontWeight: FontWeight.w600,
              color: accent ? theme.colorScheme.primary : null,
            ),
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
      onTap: drag == null && collapsible
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

  // --- The T99 drag choreography ---

  /// One item slot: draggable rows get the long-press pickup; the dragged
  /// row renders as the lifted card with the reveal-label chip in its
  /// trailing slot (the hover actions hide during a drag, the upstream
  /// `Sidebar.tsx:1594-1600` behaviour). The dragged row keeps its
  /// detector — the rebuild must not dispose the recognizer that owns the
  /// active pointer.
  Widget _itemSlot(BuildContext context, UiNode item, String sectionId) {
    final drag = _drag;
    final dragged = drag != null && item.id != null && item.id == drag.rowId;
    if (drag == null && item.boolProp('draggable') != true) {
      return widget.ctx.build(context, item);
    }
    final child = dragged
        ? widget.ctx.build(context, _draggedNode(context, item, drag))
        : widget.ctx.build(context, item);
    return Builder(
      builder: (rowContext) => RawGestureDetector(
        // The long-press pickup with unlimited post-acceptance travel (the
        // upstream dnd-kit sensor keeps tracking across sections; the
        // default kTouchSlop tolerance would cancel the drag on the first
        // long move).
        gestures: {
          LongPressGestureRecognizer:
              GestureRecognizerFactoryWithHandlers<
                  LongPressGestureRecognizer>(
            () => LongPressGestureRecognizer(postAcceptSlopTolerance: null),
            (LongPressGestureRecognizer instance) {
              instance.onLongPressStart = (details) =>
                  _startDrag(rowContext, item, sectionId, details);
              instance.onLongPressMoveUpdate = (details) =>
                  _moveDrag(details.globalPosition);
              instance.onLongPressEnd = (details) =>
                  _endDrag(details.globalPosition);
              instance.onLongPressCancel = _cancelDrag;
            },
          ),
        },
        child: child,
      ),
    );
  }

  /// Starts a drag session for one row: the targets resolve from the
  /// row's `dropTargets`, the overlay card mounts at the grab point, the
  /// reveal timer schedules the `motion.panel` step-end flip and the
  /// Escape handler installs (the upstream `Sidebar.pointer.ts:115`
  /// keydown cancel).
  void _startDrag(BuildContext rowContext, UiNode item, String sectionId,
      LongPressStartDetails details) {
    if (_drag != null) return;
    final rowId = item.id;
    if (rowId == null || rowId.isEmpty) return;
    final targets = <String, _DropTarget>{};
    for (final raw in item.listProp('dropTargets') ?? const <Object?>[]) {
      if (raw is! Map) continue;
      final target = _DropTarget(Map<Object?, Object?>.from(raw));
      if (target.id.isNotEmpty) targets[target.id] = target;
    }
    final box = rowContext.findRenderObject() as RenderBox?;
    final size = box != null && box.hasSize ? box.size : Size.zero;
    final grab = Offset(
      details.localPosition.dx.clamp(0.0, size.width),
      details.localPosition.dy.clamp(0.0, size.height),
    );
    final drag = _DragSession(
      rowId,
      targets,
      item.props['dragLabel'] is Map
          ? UiNode.fromJson(item.props['dragLabel'])
          : null,
      grab,
      cardWidth: size.width,
      design: JhinDesignScope.of(rowContext),
    );
    drag.pointer.value = details.globalPosition;
    setState(() => _drag = drag);
    _installEscape();
    _overlay = OverlayEntry(builder: (context) => _feedback(context, drag));
    Overlay.of(rowContext).insert(_overlay!);
    // The reveal delay: the `sidebar-drag-label-reveal` step-end flip
    // timed by the `motion.panel` duration (the plan's T99 step 2; the
    // token default is 0 ms, so the reveal is immediate unless the host
    // raises the panel duration — upstream runs a fixed 200 ms step-end,
    // `index.css:2154-2165`).
    _revealTimer = Timer(JhinDesignScope.of(rowContext).tokens.motion.panel,
        () {
      if (_drag != null) {
        setState(() => _drag!.revealed = true);
        _overlay?.markNeedsBuild();
      }
    });
  }

  /// Pointer move: the feedback follows and the hovered drop target
  /// resolves from the section regions (the header-top anchors).
  void _moveDrag(Offset global) {
    final drag = _drag;
    if (drag == null) return;
    drag.pointer.value = global;
    final section = _sectionAt(global);
    if (section != drag.hover) {
      setState(() => drag.hover = section);
      _overlay?.markNeedsBuild();
    }
  }

  /// Pointer up: the drop position resolves the target — a valid target
  /// with an action dispatches exactly once, anything else cancels and
  /// dispatches nothing (the plan's T99 failure path).
  void _endDrag(Offset global) {
    final drag = _drag;
    if (drag == null) return;
    drag.pointer.value = global;
    final section = _sectionAt(global);
    final target = section == null ? null : drag.targets[section];
    if (target != null && target.action != null && !drag.dispatched) {
      drag.dispatched = true;
      widget.ctx.dispatch(target.action!);
    }
    _teardownDrag();
  }

  /// Cancels the active drag (Escape or pointer cancel): no dispatch, the
  /// resting tree restores — the drag itself never mutated anything.
  void _cancelDrag() => _teardownDrag();

  /// Tears the drag session down: overlay out, Escape handler out, reveal
  /// timer cancelled, state cleared.
  void _teardownDrag() {
    _revealTimer?.cancel();
    _revealTimer = null;
    final handler = _escapeHandler;
    if (handler != null) {
      HardwareKeyboard.instance.removeHandler(handler);
      _escapeHandler = null;
    }
    _overlay?.remove();
    _overlay = null;
    if (_drag != null && mounted) {
      setState(() => _drag = null);
    }
  }
  /// Installs the Escape cancel handler; active only while a drag is live.
  void _installEscape() {
    bool handler(KeyEvent event) {
      if (event is KeyDownEvent &&
          event.logicalKey == LogicalKeyboardKey.escape) {
        _cancelDrag();
        return true;
      }
      return false;
    }

    HardwareKeyboard.instance.addHandler(handler);
    _escapeHandler = handler;
  }

  /// The section id under the pointer (the drag hit-test): a section spans
  /// from its header top to the next header top, the last one to the
  /// viewport bottom; the pointer must sit inside the viewport. Null
  /// outside every region (the plan's non-target areas).
  String? _sectionAt(Offset global) {
    final viewportBox =
        _viewportKey.currentContext?.findRenderObject() as RenderBox?;
    if (viewportBox == null || !viewportBox.attached || !viewportBox.hasSize) {
      return null;
    }
    final viewportRect = viewportBox.localToGlobal(Offset.zero) & viewportBox.size;
    if (!viewportRect.contains(global)) return null;
    final anchors = <MapEntry<double, String>>[];
    for (final entry in _sectionKeys.entries) {
      final box = entry.value.currentContext?.findRenderObject() as RenderBox?;
      if (box == null || !box.attached || !box.hasSize) continue;
      anchors.add(MapEntry(box.localToGlobal(Offset.zero).dy, entry.key));
    }
    if (anchors.isEmpty) return null;
    anchors.sort((a, b) => a.key.compareTo(b.key));
    for (var i = 0; i < anchors.length; i++) {
      final bottom =
          i + 1 < anchors.length ? anchors[i + 1].key : viewportRect.bottom;
      if (global.dy >= anchors[i].key && global.dy < bottom) {
        return anchors[i].value;
      }
    }
    return null;
  }

  /// The dragged row's render node: the lifted card (`dragging`) with the
  /// hover reveal off and the trailing slot replaced by the reveal-label
  /// chip (no hovered target — no chip, the upstream resting drag).
  UiNode _draggedNode(BuildContext context, UiNode item, _DragSession drag) {
    final props = Map<String, dynamic>.from(item.props);
    props['dragging'] = true;
    props['hoverReveal'] = false;
    final chip = _chipNode(context, drag);
    if (chip == null) {
      props.remove('trailing');
    } else {
      props['trailing'] = chip.toJson();
    }
    return UiNode(type: item.type, props: props, children: item.children);
  }

  /// The reveal-label chip node: the primary-tinted pill (the upstream
  /// `border-primary/40 bg-primary/10 text-primary` badge,
  /// `Sidebar.tsx:1586-1592`) around the `dragLabel` template with the
  /// hovered target's word and icon swapped in. Null while no target is
  /// hovered. The surface colours ride as resolved [Color] values — the
  /// token palette has no alpha-suffixed names.
  UiNode? _chipNode(BuildContext context, _DragSession drag) {
    final target = drag.hover == null ? null : drag.targets[drag.hover!];
    if (target == null || target.label.isEmpty) return null;
    final theme = JhinDesignScope.materialOf(context);
    final tokens = JhinDesignScope.of(context).tokens;
    final primary = theme.colorScheme.primary;
    final icon = _dragBadgeIcons[target.label];
    final content = _swapChipContent(drag.dragLabel, target.label, icon) ??
        UiNode(
          type: 'row',
          props: const {'gap': 4},
          children: [
            if (icon != null)
              UiNode(type: 'icon', props: {'icon': icon, 'size': 12}),
            UiNode(type: 'text', props: {'text': target.label}),
          ],
        );
    return UiNode(
      type: 'box',
      props: {
        'id': 'drag-label',
        'direction': 'row',
        'padding': const {'left': 6, 'right': 6, 'top': 2, 'bottom': 2},
        'borderRadius': tokens.radius.sm,
        'color': primary.withValues(alpha: 0.10),
        'border': primary.withValues(alpha: 0.40),
        'borderWidth': 1,
        'child': content.toJson(),
      },
    );
  }

  /// The `dragLabel` template with the hovered target's word and icon
  /// swapped in: every descendant `text` node takes the word (and the
  /// primary colour), every `icon` node the mapped glyph. Returns null
  /// without a template (the caller builds the default chip).
  UiNode? _swapChipContent(UiNode? template, String word, String? icon) {
    if (template == null) return null;
    UiNode swap(UiNode node) {
      final props = Map<String, dynamic>.from(node.props);
      if (node.type == 'text') {
        props['text'] = word;
        props['color'] = r'$color.primary';
      } else if (node.type == 'icon' && icon != null) {
        props['icon'] = icon;
        props['color'] = r'$color.primary';
      }
      return UiNode(
        type: node.type,
        props: props,
        children: [for (final child in node.children) swap(child)],
      );
    }

    return swap(template);
  }

  /// The row node of the dragged id, re-read from the sections (a patch
  /// may have replaced the node mid-drag).
  UiNode? _rowNodeById(String rowId) {
    for (final raw in widget.node.listProp('sections') ?? const <Object?>[]) {
      final section = asMap(raw);
      final items = section?['items'];
      if (items is! List) continue;
      for (final item in items) {
        final node = UiNode.fromJson(item);
        if (node.id == rowId) return node;
      }
    }
    return null;
  }

  /// The overlay card: the dragged row rebuilt as the lifted card, hanging
  /// from the grab point (the dnd-kit drag preview). The design scope is
  /// re-injected — the root overlay sits above the app's scope.
  Widget _feedback(BuildContext context, _DragSession drag) {
    return IgnorePointer(
      child: JhinDesignScope(
        design: drag.design,
        child: Material(
          type: MaterialType.transparency,
          child: ValueListenableBuilder<Offset>(
            valueListenable: drag.pointer,
            builder: (context, pointer, _) {
              final item = _rowNodeById(drag.rowId);
              final card = item == null
                  ? const SizedBox.shrink()
                  : widget.ctx.build(
                      context, _draggedNode(context, item, drag));
              return Stack(
                children: [
                  Positioned(
                    left: pointer.dx - drag.grabOffset.dx,
                    top: pointer.dy - drag.grabOffset.dy,
                    width: drag.cardWidth > 0 ? drag.cardWidth : null,
                    child: card,
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

/// The ASCII case fold of the upstream `foldAsciiCase`
/// (`apps/web/src/components/ThreadSearchMatch.tsx:1-4`): A–Z lower to a–z,
/// everything else passes through.
String _foldAscii(String value) {
  final buffer = StringBuffer();
  for (final code in value.codeUnits) {
    buffer.writeCharCode(code >= 0x41 && code <= 0x5A ? code + 0x20 : code);
  }
  return buffer.toString();
}
