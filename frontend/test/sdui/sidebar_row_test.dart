import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/palette_gen.dart';
import 'package:jhin/design/status_indicators.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/primitives/progress.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T97 acceptance: the thread-row anatomy and the sidebar search — the
/// leading status-indicator cluster (the ten-kind set with the literal
/// tooltips), the semibold truncated title, the workdir subtitle with the
/// context chip, the hover-revealed trailing cluster with the search-match
/// pill, the row states (hover / selected / dragging) and the client-side
/// section filter with its match-count line.
///
/// Upstream anchors (t3code `apps/web/src`, commit 37de6cb): the row hover
/// and active surfaces (`components/Sidebar.tsx:1512-1527`), the dragged-row
/// lifted card (`:1524-1527`), the search-match highlight
/// (`components/ThreadSearchMatch.tsx:36-38`), the ASCII case fold
/// (`:1-4`) and the "No threads found" empty-search text
/// (`components/Sidebar.tsx:5040-5046`).
final JhinTheme _design = JhinTheme.from(
  colors: generate('light', '#101018', '#10b981'),
);

const String _goldenDir = String.fromEnvironment('T97_GOLDEN_DIR');

final GlobalKey _shot = GlobalKey();

RenderContext _ctx(UiState state) => RenderContext(
      state: state,
      registry: UiRegistry.standard(),
      patches: {},
      setState: (id, value) => state.setValue(id, value),
      patch: (id, props) {},
      navigate: (screen) {},
      dispatch: (action) async {},
      openStream: (topic, {onStatus}) => const Stream.empty(),
      runDirectives: (directives) async {},
      confirm: (message, onConfirm) {},
    );

class _Host extends StatelessWidget {
  const _Host(this.ctx, this.node);

  final RenderContext ctx;
  final UiNode node;

  @override
  Widget build(BuildContext context) => ctx.build(context, node);
}

Future<void> _pump(
  WidgetTester tester,
  Object? json, {
  UiState? state,
  Size size = const Size(300, 200),
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  final node = UiNode.fromJson(json);
  await tester.pumpWidget(
    RepaintBoundary(
      key: _shot,
      child: MaterialApp(
        theme: _design.light,
        darkTheme: _design.dark,
        home: MediaQuery(
          data: const MediaQueryData(),
          child: Scaffold(
            body: JhinDesignScope(
              design: _design,
              child: Material(child: _Host(_ctx(state ?? UiState()), node)),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

Map<String, Object?> _row({
  String id = 'row-1',
  String title = 'Fix the login flow',
  String subtitle = '/tmp/work',
  List<String> kinds = const [],
  bool hoverReveal = false,
  Map<String, Object?>? searchMatch,
  bool selected = false,
  bool dragging = false,
}) =>
    {
      'type': 'list_row',
      'id': id,
      'title': {
        'type': 'text',
        'text': title,
        'fontSize': 14,
        'fontWeight': 600,
        'maxLines': 1,
        'ellipsis': true,
      },
      'subtitle': {
        'type': 'row',
        'children': [
          {'type': 'text', 'text': subtitle, 'style': 'caption'},
          {
            'type': 'box',
            'id': 'thread-context-chip',
            'padding': {'left': 6, 'right': 6, 'top': 2, 'bottom': 2},
            'borderRadius': 4,
            'tooltip': 'Project: $subtitle',
            'child': {'type': 'text', 'text': 'work', 'fontSize': 12},
          },
        ],
      },
      'trailing': {
        'type': 'icon',
        'icon': 'more_vert',
        'size': 16,
      },
      'statusIndicators': kinds,
      'hoverReveal': hoverReveal,
      'searchMatch': searchMatch,
      'selected': selected,
      'dragging': dragging,
    };

/// One sectioned list node with the sidebar shape.
Map<String, Object?> _list({
  List<Map<String, Object?>>? sections,
  Map<String, Object?>? search,
  Object? header,
  Object? footer,
}) =>
    {
      'type': 'list',
      'id': 'sidebar-sections',
      'sections': sections ?? <Map<String, Object?>>[],
      'search': search,
      'header': header,
      'footer': footer,
    };

void main() {
  testWidgets('the status cluster renders one glyph per kind with the '
      'literal tooltips', (tester) async {
    await _pump(
      tester,
      _row(kinds: [
        'working', 'idle', 'monitoring', 'needs-approval', 'needs-answer',
        'failed', 'limited', 'snoozed', 'settled', 'unread', 'pinned',
      ]),
      size: const Size(800, 200),
    );
    // working + unread ride the duty-cycle modes; the other nine are glyphs.
    final indicators =
        tester.widgetList<JhinStatusIndicator>(find.byType(JhinStatusIndicator))
            .toList();
    expect(indicators, hasLength(2));
    expect(indicators[0].mode, 'pulse');
    expect(indicators[1].mode, 'ping');
    expect(indicators[1].size, 6, reason: 'the unread dot is the 6 px dot');
    for (final tooltip in [
      'Working', 'Monitoring', 'Needs approval', 'Needs answer', 'Failed',
      'Limited', 'Snoozed', 'Settled', 'Unread', 'Pinned',
    ]) {
      expect(find.byTooltip(tooltip), findsOneWidget, reason: tooltip);
    }
  });

  testWidgets('an unknown kind renders the idle fallback and logs',
      (tester) async {
    final logs = <String>[];
    final original = debugPrint;
    debugPrint = (message, {wrapWidth}) {
      if (message != null) logs.add(message);
    };
    try {
      await _pump(tester, _row(kinds: ['bogus-kind']));
    } finally {
      debugPrint = original;
    }
    expect(
      logs.where((l) => l.contains('unknown status indicator kind')),
      isNotEmpty,
      reason: 'the fallback logs the unknown kind',
    );
    // The fallback is the idle circle glyph (no tooltip — the unlabeled
    // resting state).
    expect(find.byType(JhinStatusIndicator), findsNothing);
    expect(find.byTooltip('Working'), findsNothing);
  });

  testWidgets('hoverReveal hides the trailing cluster at rest and shows it '
      'on hover', (tester) async {
    await _pump(tester, _row(hoverReveal: true));
    AnimatedOpacity opacityOf() => tester.widget<AnimatedOpacity>(
          find.ancestor(
            of: find.byIcon(Icons.more_vert),
            matching: find.byType(AnimatedOpacity),
          ),
        );
    expect(opacityOf().opacity, 0, reason: 'the trailing cluster rests hidden');
    final gesture = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await gesture.addPointer(location: Offset.zero);
    addTearDown(gesture.removePointer);
    await gesture.moveTo(tester.getCenter(find.text('Fix the login flow')));
    await tester.pumpAndSettle();
    expect(opacityOf().opacity, 1, reason: 'hover reveals the trailing cluster');
  });

  testWidgets('the selected row paints sidebar-row-active with the ring',
      (tester) async {
    await _pump(tester, _row(selected: true));
    final container = tester.widget<Container>(find.byType(Container).first);
    final decoration = container.decoration as BoxDecoration;
    final design = _design;
    expect(
      decoration.color,
      design.colorOf('sidebar-row-active'),
      reason: 'the selected tint is the sidebar-row-active token',
    );
    expect(
      decoration.border?.top.color,
      design.colorOf('ring'),
      reason: 'the selected row carries the 1 px ring',
    );
  });

  testWidgets('the dragging row lifts into the opaque card', (tester) async {
    await _pump(tester, _row(dragging: true));
    final container = tester.widget<DecoratedBox>(
      find.widgetWithText(DecoratedBox, 'Fix the login flow').first,
    );
    final decoration = container.decoration as BoxDecoration;
    expect(decoration.boxShadow, isNotEmpty,
        reason: 'the dragged row carries the shadow');
    expect(decoration.color, _design.colorOf('sidebar-row-active'));
  });

  testWidgets('the search-match pill shows from two matching characters',
      (tester) async {
    final state = UiState()..setValue('sidebarSearch', 'fix');
    await _pump(
      tester,
      _row(
        searchMatch: {'key': 'sidebarSearch', 'minChars': 2},
        hoverReveal: true,
      ),
      state: state,
    );
    expect(find.text('fix'), findsOneWidget,
        reason: 'the pill carries the query');
  });

  testWidgets('the search-match pill stays hidden under two characters or '
      'on a non-matching row', (tester) async {
    final state = UiState()..setValue('sidebarSearch', 'f');
    await _pump(
      tester,
      _row(searchMatch: {'key': 'sidebarSearch', 'minChars': 2}),
      state: state,
    );
    expect(find.text('f'), findsNothing);

    final other = UiState()..setValue('sidebarSearch', 'zzz');
    await _pump(
      tester,
      _row(searchMatch: {'key': 'sidebarSearch', 'minChars': 2}),
      state: other,
    );
    expect(find.text('zzz'), findsNothing);
  });

  testWidgets('the commandSubtitle marker renders as the trailing muted '
      'command id text', (tester) async {
    await _pump(
      tester,
      {
        ..._row(hoverReveal: true),
        'commandSubtitle': 'thread.pin',
      },
      size: const Size(500, 200),
    );
    expect(find.text('thread.pin'), findsOneWidget);
  });

  testWidgets('a row without commandSubtitle renders no marker',
      (tester) async {
    await _pump(tester, _row(hoverReveal: true));
    expect(find.text('thread.pin'), findsNothing);
  });

  testWidgets('the section filter keeps matching rows and renders the '
      'match-count line', (tester) async {
    final state = UiState()..setValue('sidebarSearch', 'login');
    await _pump(
      tester,
      _list(
        search: {'key': 'sidebarSearch', 'fields': ['title', 'subtitle']},
        sections: [
          {
            'label': 'Active',
            'id': 'section-active',
            'items': [
              _row(id: 'row-a', title: 'Fix the login flow'),
              _row(id: 'row-b', title: 'Write the docs'),
            ],
          },
        ],
      ),
      state: state,
    );
    expect(find.text('Fix the login flow'), findsOneWidget);
    expect(find.text('Write the docs'), findsNothing,
        reason: 'the non-matching row collapses out');
    expect(find.text('1 matches'), findsOneWidget,
        reason: 'the match-count line sits above the sections');
    expect(
      find.byWidgetPredicate(
        (widget) => widget is Semantics && widget.properties.label == 'Find work',
      ),
      findsOneWidget,
      reason: 'the count line carries the Find work semantics',
    );
  });

  testWidgets('the filter is ASCII case-folded and the empty result renders '
      'the upstream No threads found line', (tester) async {
    final state = UiState()..setValue('sidebarSearch', 'LOGIN');
    await _pump(
      tester,
      _list(
        search: {'key': 'sidebarSearch'},
        sections: [
          {
            'label': 'Active',
            'id': 'section-active',
            'items': [_row(id: 'row-a', title: 'Fix the login flow')],
          },
        ],
      ),
      state: state,
    );
    expect(find.text('Fix the login flow'), findsOneWidget,
        reason: 'the fold makes LOGIN match login');

    final empty = UiState()..setValue('sidebarSearch', 'nomatch');
    await _pump(
      tester,
      _list(
        search: {'key': 'sidebarSearch'},
        sections: [
          {
            'label': 'Active',
            'id': 'section-active',
            'items': [_row(id: 'row-a', title: 'Fix the login flow')],
          },
        ],
      ),
      state: empty,
    );
    expect(find.text('No threads found'), findsOneWidget);
  });

  testWidgets('the header and footer blocks pin outside the scrollable',
      (tester) async {
    await _pump(
      tester,
      _list(
        header: {
          'type': 'text',
          'id': 'sidebar-header',
          'text': 'Jhin',
          'bold': true,
        },
        footer: {'type': 'text', 'id': 'sidebar-footer', 'text': 'Online'},
        sections: [
          {
            'label': 'Active',
            'id': 'section-active',
            'items': [_row(id: 'row-a')],
          },
        ],
      ),
      size: const Size(300, 400),
    );
    expect(find.text('Jhin'), findsOneWidget);
    expect(find.text('Online'), findsOneWidget);
    expect(find.text('Fix the login flow'), findsOneWidget);
  });

  testWidgets('golden: the sidebar with one thread per status kind (light)',
      (tester) async {
    await _pump(
      tester,
      _list(
        sections: [
          {
            'label': 'Active',
            'id': 'section-active',
            'count': 10,
            'uppercase': true,
            'items': [
              _row(id: 'row-working', kinds: ['working'], title: 'Working thread'),
              _row(id: 'row-idle', kinds: ['idle'], title: 'Idle thread'),
              _row(id: 'row-monitoring', kinds: ['monitoring'], title: 'Monitoring thread'),
              _row(id: 'row-approval', kinds: ['needs-approval'], title: 'Approval thread'),
              _row(id: 'row-answer', kinds: ['needs-answer'], title: 'Answer thread'),
              _row(id: 'row-failed', kinds: ['failed'], title: 'Failed thread'),
              _row(id: 'row-limited', kinds: ['limited'], title: 'Limited thread'),
              _row(id: 'row-unread', kinds: ['unread'], title: 'Unread thread'),
              _row(id: 'row-pinned', kinds: ['pinned'], title: 'Pinned thread'),
              _row(id: 'row-selected', kinds: ['idle'], title: 'Selected thread', selected: true),
            ],
          },
          {
            'label': 'Snoozed',
            'id': 'section-snoozed',
            'count': 1,
            'uppercase': true,
            'collapsed': false,
            'items': [
              _row(id: 'row-snoozed', kinds: ['snoozed'], title: 'Snoozed thread'),
            ],
          },
          {
            'label': 'Settled',
            'id': 'section-settled',
            'count': 1,
            'uppercase': true,
            'collapsed': false,
            'items': [
              _row(id: 'row-settled', kinds: ['settled'], title: 'Settled thread'),
            ],
          },
        ],
      ),
      size: const Size(320, 720),
    );
    if (_goldenDir.isNotEmpty) {
      await expectLater(
        find.byKey(_shot),
        matchesGoldenFile(Uri.file('$_goldenDir/sidebar-row-anatomy-light.png')),
      );
    }
  });
}
