import '../sdui/ui_node.dart';

/// The built-in loading frame (T79): the skeleton shown while a
/// `screenEndpoint` fetch is in flight and no previous screen is available
/// (stale-while-revalidate keeps the previous screen visible when there is
/// one).
///
/// A token-driven `container` of `skeleton` bones — never a bare box and
/// never a lone spinner. Rendered through the primitive registry like any
/// server node: the `skeleton` bones shimmer on the `JhinDesignScope` motion
/// tokens and collapse to static placeholders under reduced motion (§2.1),
/// and the `$token` references resolve against the payload's token lattice
/// (§2.2) — the frame is styled exactly like server-authored art.
UiNode loadingFrameNode() => UiNode.fromJson(loadingFrameJson);

/// The frame wire shape (§2.6 bones over §2.2 token references) — as a raw
/// node map for the `ScreenRenderer.buildNode` seam.
const Map<String, dynamic> loadingFrameJson = {
  'type': 'container',
  'padding': r'$spacing.lg',
  'gap': r'$spacing.md',
  'children': [
    {'type': 'skeleton', 'variant': 'rect', 'width': 220, 'height': 28},
    {'type': 'skeleton', 'variant': 'text', 'lines': 2, 'shimmer': true},
    {'type': 'skeleton', 'variant': 'list', 'lines': 3, 'shimmer': true},
  ],
};
