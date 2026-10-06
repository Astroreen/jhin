import 'package:flutter/material.dart';

import '../../design/status_indicators.dart';
import '../../design/theme.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';
import '../ui_state.dart';

/// `list_row` (§2.6): `leading`, `title`, `subtitle`, `trailing`, `badge`,
/// `selected`, `dragHandle` — plus the T97 thread-row extensions:
/// `statusIndicators` (kind names rendered as the leading
/// `ThreadStatusIndicators` cluster), `hoverReveal` (the trailing cluster
/// fades in on hover/focus — the upstream group-hover reveal), `searchMatch`
/// (`{key, minChars}` — the client-side match pill shown when the UiState
/// query under `key` is at least `minChars` characters and matches this
/// row's title/subtitle) and `dragging` (the lifted-card look).
/// `title`/`subtitle` accept a node or the string shorthand.
///
/// The T99 drag-choreography props (consumed by the sectioned `list`,
/// which drives the whole interaction — this primitive only renders what
/// the list hands it): `draggable` (the row can be picked up by a
/// long-press), `dragLabel` (the reveal-label chip template shown on the
/// dragged row while a drop target is hovered — the client swaps the
/// template's icon and text with the hovered target's badge word, the
/// upstream `dropVerbBadge` port) and `dropTargets`
/// (`[{id, label, accentWhenHovered, action?}]` — the section ids the row
/// may be dropped on, the badge word per target, whether the hovered
/// header takes the accent colour and the lifecycle action the drop
/// dispatches exactly once).
///
/// `action`/`onLongPress` come from the universal Interaction cluster (§2.1)
/// but dispatch through the row's own `InkWell` — the §2.3 gesture wrapper
/// for this primitive — so the registry wrapper is skipped for `list_row`
/// and a tap fires `action` exactly once while a long press fires only
/// `onLongPress`.
///
/// Row states (T97): the resting row is transparent; hover paints the
/// `sidebar-row-hover` token (falling back to the theme hover color);
/// `selected` paints the `sidebar-row-active` token with a 1 px inset ring
/// (the upstream `bg-sidebar-row-active` + focus ring,
/// `apps/web/src/components/Sidebar.tsx:1512-1527`, commit 37de6cb);
/// `dragging` lifts the row into an opaque card with a shadow (the upstream
/// dragged-row surface, `Sidebar.tsx:1524-1527`).
Widget buildListRow(BuildContext context, UiNode node, RenderContext ctx) {
  final tokens = JhinDesignScope.of(context).tokens;
  final design = JhinDesignScope.of(context);
  final theme = JhinDesignScope.materialOf(context);
  final brightness = Theme.brightnessOf(context);
  final leading = buildChildProp(context, ctx, node.props['leading']);
  final statusKinds = node.listProp('statusIndicators');
  final title = buildChildProp(context, ctx, node.props['title']);
  final subtitle = buildChildProp(context, ctx, node.props['subtitle']);
  final trailing = buildChildProp(context, ctx, node.props['trailing']);
  final badge = buildChildProp(context, ctx, node.props['badge']);
  final selected = node.boolProp('selected') == true;
  final dragging = node.boolProp('dragging') == true;
  final hoverReveal = node.boolProp('hoverReveal') == true;
  final dragHandle = node.boolProp('dragHandle') == true;
  final enabled = node.boolProp('enabled') != false;
  final action = asMap(node.props['action']) ?? asMap(node.props['onTap']);
  final longPressAction = asMap(node.props['onLongPress']);

  // The T97 hover reveal: one row-level hover surface drives the trailing
  // cluster's fade (the upstream group-hover reveal).
  final ValueNotifier<bool>? reveal =
      hoverReveal && trailing != null ? ValueNotifier<bool>(false) : null;

  final row = Row(
    children: [
      if (statusKinds != null && statusKinds.isNotEmpty) ...[
        ThreadStatusIndicators(
          kinds: [for (final kind in statusKinds) '$kind'],
        ),
        SizedBox(width: tokens.spacing.md),
      ],
      if (leading != null) ...[
        leading,
        SizedBox(width: tokens.spacing.md),
      ],
      Expanded(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ?title,
            ?subtitle,
          ],
        ),
      ),
      if (badge != null) ...[
        SizedBox(width: tokens.spacing.sm),
        badge,
      ],
      if (trailing != null) ...[
        SizedBox(width: tokens.spacing.sm),
        _trailingCluster(
          context,
          node,
          ctx.state,
          reveal,
          asMap(node.props['searchMatch']),
          trailing,
        ),
      ],
      if (dragHandle) ...[
        SizedBox(width: tokens.spacing.sm),
        const Icon(Icons.drag_handle),
      ],
    ],
  );

  Widget content = Padding(
    padding: EdgeInsets.symmetric(
      horizontal: tokens.spacing.md,
      vertical: tokens.spacing.sm,
    ),
    child: row,
  );

  // The row states (T97). Dragging wins over selected: the lifted card is
  // opaque so the rows beneath never show through (the upstream dragged-row
  // surface).
  if (dragging) {
    content = DecoratedBox(
      decoration: BoxDecoration(
        color: design.colorOf('sidebar-row-active', brightness: brightness) ??
            theme.colorScheme.secondaryContainer,
        borderRadius: BorderRadius.circular(tokens.radius.sm),
        boxShadow: [
          BoxShadow(
            color: theme.colorScheme.shadow.withValues(alpha: 0.25),
            blurRadius: 12,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: content,
    );
  } else if (selected) {
    final active =
        design.colorOf('sidebar-row-active', brightness: brightness) ??
            theme.colorScheme.secondaryContainer;
    final ring = design.colorOf('ring', brightness: brightness) ??
        theme.colorScheme.primary;
    content = Container(
      decoration: BoxDecoration(
        color: active,
        border: Border.all(color: ring, width: 1),
        borderRadius: BorderRadius.circular(tokens.radius.sm),
      ),
      child: content,
    );
  }

  if (!enabled || (action == null && longPressAction == null)) {
    if (reveal == null) return content;
    return MouseRegion(
      onEnter: (_) => reveal.value = true,
      onExit: (_) => reveal.value = false,
      child: content,
    );
  }

  void dispatch(Map<String, dynamic> act) {
    final confirm = node.stringProp('confirm');
    if (confirm != null && confirm.isNotEmpty) {
      ctx.confirm(confirm, () => ctx.dispatch(act));
    } else {
      ctx.dispatch(act);
    }
  }

  // Hover paints the `sidebar-row-hover` token (the upstream row hover
  // surface); without the token the theme hover color stands.
  final hoverColor = design.colorOf('sidebar-row-hover', brightness: brightness);
  Widget result = InkWell(
    onTap: action == null ? null : () => dispatch(action),
    onLongPress: longPressAction == null ? null : () => dispatch(longPressAction),
    hoverColor: hoverColor ?? theme.hoverColor,
    child: content,
  );
  if (reveal != null) {
    result = MouseRegion(
      onEnter: (_) => reveal.value = true,
      onExit: (_) => reveal.value = false,
      child: result,
    );
  }
  return result;
}

/// The trailing cluster of a row: the search-match pill (when the row
/// carries `searchMatch` and the query matches) plus the trailing node,
/// faded in on the row hover when `reveal` is present (the upstream
/// group-hover reveal of the row actions).
Widget _trailingCluster(
  BuildContext context,
  UiNode node,
  UiState state,
  ValueNotifier<bool>? reveal,
  Map<Object?, Object?>? searchMatch,
  Widget trailing,
) {
  final match = _matchPill(context, node, state, searchMatch);
  final command = node.stringProp('commandSubtitle');
  final clusterChildren = <Widget>[
    if (command case final String cmd when cmd.isNotEmpty) _commandMarker(context, cmd),
    ?match,
    trailing,
  ];
  final cluster = clusterChildren.length == 1
      ? clusterChildren.single
      : Row(mainAxisSize: MainAxisSize.min, children: clusterChildren);
  if (reveal == null) return cluster;
  return ValueListenableBuilder<bool>(
    valueListenable: reveal,
    builder: (context, visible, _) => AnimatedOpacity(
      opacity: visible ? 1 : 0,
      duration: const Duration(milliseconds: 120),
      child: cluster,
    ),
  );
}

/// The T98 command-subtitle marker (the `ThreadCommandSubtitle` port): the
/// command id text of a palette-sourced row, rendered as the muted `text-xs`
/// marker (`ThreadCommandSubtitle.tsx:64-70` — `text-xs
/// text-muted-foreground/70`, commit 37de6cb). Absent on rows the palette
/// did not produce.
Widget _commandMarker(BuildContext context, String command) {
  final theme = JhinDesignScope.materialOf(context);
  final tokens = JhinDesignScope.of(context).tokens;
  return Text(
    command,
    style: tokens.typography.small.copyWith(
      fontSize: 12,
      color: theme.colorScheme.onSurfaceVariant.withValues(alpha: 0.7),
    ),
  );
}

/// The client-side search-match pill (the `ThreadSearchMatch` port): the
/// query rendered as a semibold pill when it is at least `minChars`
/// characters long and matches this row's title or subtitle. The upstream
/// highlight is `<mark class="bg-transparent font-semibold
/// text-foreground">` (`apps/web/src/components/ThreadSearchMatch.tsx:
/// 36-38`, commit 37de6cb).
Widget? _matchPill(
  BuildContext context,
  UiNode node,
  UiState state,
  Map<Object?, Object?>? spec,
) {
  if (spec == null) return null;
  final key = spec['key'];
  if (key is! String || key.isEmpty) return null;
  final query = state.values[key]?.toString() ?? '';
  final minChars = spec['minChars'] is num ? (spec['minChars'] as num).toInt() : 2;
  if (query.length < minChars) return null;
  if (!_rowMatches(node, query)) return null;
  final theme = JhinDesignScope.materialOf(context);
  final tokens = JhinDesignScope.of(context).tokens;
  return Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
    decoration: BoxDecoration(
      color: theme.colorScheme.surfaceContainerHighest,
      borderRadius: BorderRadius.circular(tokens.radius.sm),
    ),
    child: Text(
      query,
      style: tokens.typography.small.copyWith(
        fontWeight: FontWeight.w600,
        color: theme.colorScheme.onSurface,
      ),
    ),
  );
}

/// Whether the query matches this row's title or subtitle (ASCII
/// case-folded contains, the upstream `foldAsciiCase` rule).
bool _rowMatches(UiNode node, String query) {
  final foldedQuery = _fold(query);
  for (final prop in const ['title', 'subtitle']) {
    final value = node.props[prop];
    final text = value is String ? value : asMap(value)?['text']?.toString();
    if (text != null && _fold(text).contains(foldedQuery)) return true;
  }
  return false;
}

/// The ASCII case fold of the upstream `foldAsciiCase`
/// (`apps/web/src/components/ThreadSearchMatch.tsx:1-4`): A–Z lower to a–z,
/// everything else passes through.
String _fold(String value) {
  final buffer = StringBuffer();
  for (final code in value.codeUnits) {
    buffer.writeCharCode(code >= 0x41 && code <= 0x5A ? code + 0x20 : code);
  }
  return buffer.toString();
}
