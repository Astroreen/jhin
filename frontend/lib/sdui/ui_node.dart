/// Tolerant node model of the server-driven UI tree (§8.3).
///
/// Parsing never throws: unknown keys are ignored (kept in [props], builders
/// read only what they know), a string child becomes a `text` node, and any
/// malformed node degrades to an unsupported node carrying an [error] reason.
class UiNode {
  UiNode({
    required this.type,
    required this.props,
    this.children = const [],
    this.error,
  });

  /// A malformed node: rendered as the muted "Unsupported UI element" card.
  UiNode.unsupported({required this.type, required String reason})
      : props = const {},
        children = const [],
        error = reason;

  /// Parses one node. Accepts an object, or a string shorthand for
  /// `{"type":"text","text":"…"}`. Anything else degrades to an
  /// unsupported node.
  factory UiNode.fromJson(Object? json) {
    if (json is String) {
      return UiNode(type: 'text', props: {'text': json});
    }
    if (json is Map) {
      final map = Map<String, dynamic>.from(json);
      final rawType = map['type'];
      if (rawType is! String || rawType.isEmpty) {
        return UiNode.unsupported(
          type: rawType?.toString() ?? 'unknown',
          reason: 'malformed node: "type" must be a non-empty string',
        );
      }
      final props = <String, dynamic>{};
      map.forEach((key, value) {
        if (key != 'type' && key != 'children') props[key] = value;
      });
      final children = <UiNode>[];
      final rawChildren = map['children'];
      if (rawChildren is List) {
        for (final child in rawChildren) {
          children.add(UiNode.fromJson(child));
        }
      }
      return UiNode(type: rawType, props: props, children: children);
    }
    return UiNode.unsupported(
      type: 'unknown',
      reason: 'malformed node: expected an object or a string',
    );
  }

  /// The node kind (`text`, `container`, `input`, …).
  final String type;

  /// Raw JSON props (everything except `type` and `children`).
  final Map<String, dynamic> props;

  /// Parsed `children` (string items already promoted to `text` nodes).
  final List<UiNode> children;

  /// Non-null when the node is malformed: render the unsupported card.
  final String? error;

  bool get isUnsupported => error != null;

  /// The universal `id` field (§8.3), when it is a string.
  String? get id => props['id'] is String ? props['id'] as String : null;

  /// The universal `when` expression (§8.3), when it is a string.
  String? get when => props['when'] is String ? props['when'] as String : null;

  String? stringProp(String key) {
    final value = props[key];
    return value is String ? value : null;
  }

  num? numProp(String key) {
    final value = props[key];
    return value is num ? value : null;
  }

  bool? boolProp(String key) {
    final value = props[key];
    return value is bool ? value : null;
  }

  List<Object?>? listProp(String key) {
    final value = props[key];
    return value is List ? value : null;
  }

  /// Returns a copy with [overlay] merged over [props]; `children` overlays
  /// re-parse the child list. Used by `patch` (§8.5).
  UiNode copyWithProps(Map<String, dynamic> overlay) {
    final merged = Map<String, dynamic>.from(props)..addAll(overlay);
    final rawChildren = merged.remove('children');
    var kids = children;
    if (rawChildren is List) {
      kids = [for (final child in rawChildren) UiNode.fromJson(child)];
    }
    return UiNode(type: type, props: merged, children: kids, error: error);
  }

  /// The wire shape of this node: `{"type": …, …props…, "children": […]}`
  /// with nested nodes converted recursively (the inverse of [fromJson]).
  Map<String, dynamic> toJson() {
    return {
      'type': type,
      ...props,
      if (children.isNotEmpty)
        'children': [for (final child in children) child.toJson()],
    };
  }

  /// This node plus every nested node: `children` and node-like values inside
  /// props (`body`, `fields`, `items`, table `rows`, …).
  List<UiNode> flatten() {
    final out = <UiNode>[this];
    for (final child in children) {
      out.addAll(child.flatten());
    }
    for (final value in props.values) {
      _collect(value, out);
    }
    return out;
  }

  /// First node in this subtree with the given [id], or null.
  UiNode? findById(String id) {
    for (final node in flatten()) {
      if (node.id == id) return node;
    }
    return null;
  }

  static void _collect(Object? value, List<UiNode> out) {
    if (value is Map) {
      if (value['type'] is String) {
        out.addAll(UiNode.fromJson(value).flatten());
      }
    } else if (value is List) {
      for (final item in value) {
        _collect(item, out);
      }
    }
  }
}
