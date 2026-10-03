import 'package:flutter/widgets.dart';

import '../design/theme.dart';

/// Renders a bootstrap payload — or a standalone node — into widgets.
///
/// This is the seam to the T22 SDUI runtime. T21 ships only
/// [GenericScreenRenderer], a placeholder that walks the node JSON as
/// generic content, so the bootstrap host exists and is testable before the
/// real runtime does. T22 replaces the placeholder with `SduiRuntime` (node
/// model, primitive registry, screen stack); `SduiHost` depends solely on
/// this interface, so the swap is a constructor change and nothing else.
abstract interface class ScreenRenderer {
  /// Builds the widget tree for a non-empty bootstrap payload (§8.2),
  /// starting at the payload's `entry` screen.
  Widget buildScreen(BuildContext context, Map<String, dynamic> payload);

  /// Builds a standalone node — used for the cached `fallbacks.offline` art
  /// (§8.7) on a network failure.
  Widget buildNode(BuildContext context, Map<String, dynamic> node);
}

/// Placeholder [ScreenRenderer] used until T22 lands.
///
/// Deliberately minimal and generic: `text` / `label` strings render as
/// [Text], `title` renders as a heading, and `body` / `children` / `items` /
/// `fields` render as a column of generic children. Unknown keys and node
/// types are ignored and never throw — fixture trees stay distinguishable,
/// real SDUI semantics are not attempted here.
class GenericScreenRenderer implements ScreenRenderer {
  const GenericScreenRenderer();

  @override
  Widget buildScreen(BuildContext context, Map<String, dynamic> payload) {
    final entry = payload['entry'];
    final screens = payload['screens'];
    Map<String, dynamic>? node;
    if (screens is List) {
      for (final screen in screens) {
        final map = _asMap(screen);
        if (map != null && map['id'] == entry) {
          node = _asMap(map['node']);
        }
      }
    }
    return _render(context, node ?? const {'type': 'text', 'text': ''});
  }

  @override
  Widget buildNode(BuildContext context, Map<String, dynamic> node) =>
      _render(context, _asMap(node) ?? const {'type': 'text', 'text': ''});

  Widget _render(BuildContext context, Map<String, dynamic> node) {
    final children = <Widget>[];
    final title = node['title'];
    if (title is String && title.isNotEmpty) {
      children.add(Text(
        title,
        style: const TextStyle(fontWeight: FontWeight.bold),
      ));
    }
    for (final key in const ['text', 'label']) {
      final value = node[key];
      if (value is String && value.isNotEmpty) {
        children.add(Text(value));
      }
    }
    for (final key in const ['body', 'child']) {
      final value = node[key];
      final child = _asMap(value);
      if (child != null) {
        children.add(_render(context, child));
      } else if (value is String && value.isNotEmpty) {
        children.add(Text(value));
      }
    }
    for (final key in const ['children', 'items', 'fields']) {
      final value = node[key];
      if (value is List) {
        for (final item in value) {
          final child = _asMap(item);
          if (child != null) {
            children.add(_render(context, child));
          } else if (item is String && item.isNotEmpty) {
            children.add(Text(item));
          }
        }
      }
    }
    return SingleChildScrollView(
      child: Padding(
        padding:
            EdgeInsets.all(JhinDesignScope.of(context).tokens.spacing.md),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: children,
        ),
      ),
    );
  }

  static Map<String, dynamic>? _asMap(Object? value) {
    if (value is Map<String, dynamic>) {
      return value;
    }
    if (value is Map) {
      return Map<String, dynamic>.from(value);
    }
    return null;
  }
}
