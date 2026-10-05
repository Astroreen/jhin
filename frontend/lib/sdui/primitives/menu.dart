import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';
import 'sheet.dart' show buildSheetChrome;

/// `menu` (§2.6): `trigger` (node), `items` (item array), `breakpoint` (num,
/// default 900).
///
/// Tapping the trigger opens a `PopupMenuButton` over the item list; below
/// `breakpoint` (or 900 when unset) the same items open as a modal bottom
/// sheet. Each item is `{label, icon?, action?, confirm?, disabled?, divider?,
/// danger?, children?, checked?, separatorBefore?}` (§2.6): `divider: true`
/// renders a `Divider` entry, `disabled` dispatches nothing, `danger` paints
/// the label in the scheme error color, `confirm` gates the dispatch through
/// `RenderContext.confirm` (a decline dispatches nothing), `children` (T98)
/// opens the nested submenu — a second popup over the popup route, an
/// indented group in the sheet —, `checked` (T98) marks the radio-style
/// entries with the leading check and `separatorBefore` (T98) renders a
/// divider above the entry. A string item promotes to `{label: …}`. The
/// trigger is wrapped in `AbsorbPointer` so its own `action`/`onTap`
/// handlers cannot swallow the tap — the trigger's tap opens the menu — and
/// the `menu` node itself is in the `_interactivePrimitives` set (its
/// universal `action` is not wired to a tap; item actions are). With no
/// items the trigger renders without a popup.
///
/// T87: `glass: true` applies the upstream `dropdown-glass` treatment
/// (index.css:405-419). The sheet presentation carries the full recipe
/// (backdrop blur + saturation, the mixed popover fill); the popup route
/// cannot host a `BackdropFilter`, so it takes the recipe fill only — the
/// documented route-popup degradation. T89: `glassTint` paints the 4% tint
/// wash over the glass fill (both presentations).
Widget buildMenu(BuildContext context, UiNode node, RenderContext ctx) {
  final trigger = buildChildProp(context, ctx, node.props['trigger']);
  if (trigger == null) {
    return degradedBox(context, 'Missing trigger');
  }
  final items = <Map<String, dynamic>>[];
  for (final raw in node.listProp('items') ?? const <Object?>[]) {
    if (raw is String) {
      items.add({'label': raw});
      continue;
    }
    final map = asMap(raw);
    if (map != null) items.add(map);
  }
  final guarded = AbsorbPointer(child: trigger);
  if (items.isEmpty) return guarded;

  final breakpoint = node.numProp('breakpoint')?.toDouble() ?? 900;
  final enabled = node.boolProp('enabled') != false;
  final glass = node.boolProp('glass') == true;

  void dispatchItem(Map<String, dynamic> item) {
    final action = asMap(item['action']);
    if (action == null) return;
    final confirm = item['confirm'];
    if (confirm is String && confirm.isNotEmpty) {
      ctx.confirm(confirm, () => ctx.dispatch(action));
    } else {
      ctx.dispatch(action);
    }
  }

  List<PopupMenuEntry<int>> popupEntries(BuildContext menuContext) {
    final entries = <PopupMenuEntry<int>>[];
    for (var i = 0; i < items.length; i++) {
      final item = items[i];
      if (item['divider'] == true) {
        entries.add(const PopupMenuDivider());
        continue;
      }
      if (item['separatorBefore'] == true) {
        entries.add(const PopupMenuDivider());
      }
      final children = item['children'];
      if (children is List && children.isNotEmpty) {
        // The T98 submenu: a nested popup over the popup route; selecting a
        // child pops both routes and dispatches the child action.
        entries.add(
          PopupMenuItem<int>(
            value: i,
            enabled: item['disabled'] != true,
            child: Builder(
              builder: (menuContext) => PopupMenuButton<int>(
                itemBuilder: (innerContext) =>
                    _submenuEntries(menuContext, children, dispatchItem),
                onSelected: (childIndex) {
                  Navigator.of(menuContext).pop();
                  dispatchItem(
                    Map<String, dynamic>.from(children[childIndex] as Map),
                  );
                },
                child: _menuItemRow(menuContext, item, submenu: true),
              ),
            ),
          ),
        );
        continue;
      }
      entries.add(
        PopupMenuItem<int>(
          value: i,
          enabled: item['disabled'] != true,
          child: _menuItemRow(menuContext, item),
        ),
      );
    }
    return entries;
  }

  final width = MediaQuery.sizeOf(context).width;
  if (width < breakpoint) {
    return GestureDetector(
      onTap: !enabled
          ? null
          : () {
              showModalBottomSheet<void>(
                context: context,
                builder: (sheetContext) {
                  final list = SingleChildScrollView(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        for (var i = 0; i < items.length; i++) ...[
                          if (items[i]['separatorBefore'] == true ||
                              items[i]['divider'] == true)
                            const Divider(height: 1),
                          if (_childrenOf(items[i]) case final children
                              when children.isNotEmpty) ...[
                            ListTile(
                              enabled: false,
                              leading: _menuLeadingIcon(items[i]),
                              title: _menuItemRow(sheetContext, items[i]),
                            ),
                            for (final child in children)
                              ListTile(
                                contentPadding: const EdgeInsets.symmetric(
                                  horizontal: 32,
                                ),
                                enabled: child['disabled'] != true,
                                leading: _menuLeadingIcon(child),
                                title: _menuItemRow(sheetContext, child),
                                onTap: () {
                                  Navigator.of(sheetContext).pop();
                                  dispatchItem(child);
                                },
                              ),
                          ] else
                            ListTile(
                              enabled: items[i]['disabled'] != true,
                              leading: _menuLeadingIcon(items[i]),
                              title: _menuItemRow(sheetContext, items[i]),
                              onTap: () {
                                Navigator.of(sheetContext).pop();
                                dispatchItem(items[i]);
                              },
                            ),
                        ],
                      ],
                    ),
                  );
                  return SafeArea(
                    child: glass
                        ? buildSheetChrome(
                            sheetContext,
                            list,
                            glass: true,
                            glassTint: glassTintOf(node),
                          )
                        : list,
                  );
                },
              );
            },
      child: guarded,
    );
  }
  return PopupMenuButton<int>(
    enabled: enabled,
    color: glass ? _menuGlassFill(context, tint: glassTintOf(node)) : null,
    itemBuilder: popupEntries,
    onSelected: (index) => dispatchItem(items[index]),
    child: guarded,
  );
}

/// The submenu children of one item; empty when the item has none.
List<Map<String, dynamic>> _childrenOf(Map<String, dynamic> item) {
  final children = item['children'];
  if (children is! List) return const [];
  return [
    for (final child in children)
      if (child is Map) Map<String, dynamic>.from(child),
  ];
}

/// The nested submenu entries of one popup item (T98): the same item shape,
/// one level deep — the upstream submenu rule
/// (`threadActionMenu.logic.ts:147-154,190-201`).
List<PopupMenuEntry<int>> _submenuEntries(
  BuildContext menuContext,
  List<dynamic> children,
  void Function(Map<String, dynamic>) dispatch,
) {
  final entries = <PopupMenuEntry<int>>[];
  for (var i = 0; i < children.length; i++) {
    final child = Map<String, dynamic>.from(children[i] as Map);
    if (child['divider'] == true) {
      entries.add(const PopupMenuDivider());
      continue;
    }
    if (child['separatorBefore'] == true) {
      entries.add(const PopupMenuDivider());
    }
    entries.add(
      PopupMenuItem<int>(
        value: i,
        enabled: child['disabled'] != true,
        child: _menuItemRow(menuContext, child),
      ),
    );
  }
  return entries;
}

/// The dropdown-glass fill for the popup route (T87): the recipe fill only —
/// a route popup cannot host a `BackdropFilter`, so the blur degrades to
/// the translucent fill (the documented route-popup degradation). [tint]
/// is the T89 `glassTint` wash composited over the fill.
Color _menuGlassFill(BuildContext context, {Color? tint}) {
  final design = JhinDesignScope.of(context);
  final brightness = Theme.brightnessOf(context);
  final scheme = JhinDesignScope.materialOf(context).colorScheme;
  final recipe = JhinMenuGlassRecipe.of(
    design.tokens.surface,
    brightness,
    popover:
        design.colorOf('popover', brightness: brightness) ??
        scheme.surfaceContainerHighest,
    foreground:
        design.colorOf('foreground', brightness: brightness) ??
        scheme.onSurface,
  );
  if (tint == null) return recipe.fill;
  return Color.alphaBlend(
    tint.withValues(alpha: (tint.a * jhinGlassTintAlpha).clamp(0.0, 1.0)),
    recipe.fill,
  );
}

/// The optional leading icon of one menu item (null without an `icon` name).
Widget? _menuLeadingIcon(Map<String, dynamic> item) {
  final icon = iconFor(item['icon'] is String ? item['icon'] as String : null);
  return icon == null ? null : Icon(icon, size: 18);
}

/// One menu item row: optional leading icon, the checked mark (T98) and the
/// label — in the scheme error color when `danger` is set (§2.6 "destructive
/// styling"); a submenu entry (T98) carries the trailing chevron.
Widget _menuItemRow(
  BuildContext context,
  Map<String, dynamic> item, {
  bool submenu = false,
}) {
  final label = item['label'] is String ? item['label'] as String : '';
  final icon = iconFor(item['icon'] is String ? item['icon'] as String : null);
  final danger = item['danger'] == true;
  final checked = item['checked'] == true;
  final style = danger
      ? TextStyle(color: JhinDesignScope.materialOf(context).colorScheme.error)
      : null;
  return Row(
    children: [
      if (checked) ...[
        Icon(
          Icons.check,
          size: 16,
          color: JhinDesignScope.materialOf(context).colorScheme.primary,
        ),
        const SizedBox(width: 6),
      ],
      if (icon != null) ...[Icon(icon, size: 18), const SizedBox(width: 8)],
      Flexible(child: Text(label, style: style, maxLines: 1)),
      if (submenu) ...[
        const SizedBox(width: 12),
        const Icon(Icons.chevron_right, size: 16),
      ],
    ],
  );
}
