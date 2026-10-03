/// Shared parsing and layout for the scrollable primitives (`scroll`,
/// `list`, `grid`): the `physics` literal set of §2.6 and the viewport
/// constraint degrade that keeps a lazy scroller from asserting on
/// unbounded parents (§2.4 — the client never crashes on server content).
/// `flex_common.dart` is the Flex twin of this helper.
library;

import 'package:flutter/material.dart';

/// `physics` (§2.6 `grid`/`scroll`):
/// `neverScrollable/alwaysScrollable/bouncing/clamping`. An unknown or
/// absent literal degrades to `null` — Flutter's default physics (§2.4).
ScrollPhysics? parseScrollPhysics(String? value) {
  switch (value) {
    case 'neverScrollable':
      return const NeverScrollableScrollPhysics();
    case 'alwaysScrollable':
      return const AlwaysScrollableScrollPhysics();
    case 'bouncing':
      return const BouncingScrollPhysics();
    case 'clamping':
      return const ClampingScrollPhysics();
  }
  return null;
}

/// Builds a viewport-based scroller (ListView/GridView) so it never hits
/// the viewport's unbounded-constraint assertion: in a bounded main-axis
/// slot the scroller keeps its lazy viewport and the requested [shrinkWrap];
/// unbounded it degrades to `shrinkWrap: true`, which is content-sized and
/// eager but never asserts.
Widget buildAdaptiveScroller({
  required Axis scrollDirection,
  required bool shrinkWrap,
  required Widget Function(bool shrinkWrap) scroller,
}) {
  return LayoutBuilder(builder: (context, constraints) {
    final mainBounded = scrollDirection == Axis.vertical
        ? constraints.maxHeight.isFinite
        : constraints.maxWidth.isFinite;
    return scroller(shrinkWrap || !mainBounded);
  });
}
