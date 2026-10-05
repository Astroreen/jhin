import 'package:flutter/material.dart' hide ActionDispatcher;
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/palette_gen.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T96 acceptance: the `list` section extensions the thread sidebar rides —
/// the `when` gate (the Working opt-in), the uppercase header transform, the
/// rounded-full count badge over `badgeStyle` and the `storeKey` collapse
/// persistence (docs/sdui.md §2.6 `list` section table).

/// The design under test: the fallback theme over the full generated
/// palette — the bootstrap pins `theme.colors` to the PaletteGen output, so
/// `sidebar-control-surface` resolves exactly as it does in production.
final JhinTheme _design = JhinTheme.from(
  colors: generate('light', '#101018', '#10b981'),
);
class _Store {
  final Map<String, Object?> values = {};
}

RenderContext _ctx(UiState state, _Store? store) => RenderContext(
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
      readPersisted: store == null ? null : (key) async => store.values[key],
      writePersisted: store == null
          ? null
          : (key, value) async {
              store.values[key] = value;
            },
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
  _Store? store,
}) async {
  final node = UiNode.fromJson(json);
  await tester.pumpWidget(MaterialApp(
    home: MediaQuery(
      data: const MediaQueryData(),
      child: Scaffold(
        body: JhinDesignScope(
          design: _design,
          child: Material(
            child: _Host(_ctx(state ?? UiState(), store), node),
          ),
        ),
      ),
    ),
  ));
  await tester.pump();
}

/// Flushes the fire-and-forget persistence futures (fake-async timers).
Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 5));
}

Map<String, Object?> _section(
  String label, {
  bool? collapsed,
  int? count,
  bool? uppercase,
  String? when,
  String? storeKey,
  List<Object?>? items,
}) =>
    {
      'label': label,
      'id': 'section-${label.toLowerCase()}',
      'collapsible': true,
      'collapsed': collapsed,
      'count': count,
      'uppercase': uppercase,
      'when': when,
      'storeKey': storeKey,
      'items': items ??
          [
            {'type': 'text', 'text': '$label row'},
          ],
    };

void main() {
  testWidgets('the when gate removes the whole section while it evaluates '
      'false and keeps it on unset or failing expressions', (tester) async {
    final state = UiState()..setValue('workingSection', false);
    await _pump(tester, {
      'type': 'list',
      'sections': [
        _section('Active'),
        _section('Working', when: 'workingSection != false'),
      ],
    }, state: state);
    expect(find.text('Active row'), findsOneWidget);
    expect(find.text('Working'), findsNothing);
    expect(find.text('Working row'), findsNothing);

    // Unset key: the section stays visible (the plan's default tree).
    await _pump(tester, {
      'type': 'list',
      'sections': [_section('Working', when: 'workingSection != false')],
    });
    expect(find.text('Working'), findsOneWidget);
    expect(find.text('Working row'), findsOneWidget);

    // Explicitly on: visible.
    final on = UiState()..setValue('workingSection', true);
    await _pump(tester, {
      'type': 'list',
      'sections': [_section('Working', when: 'workingSection != false')],
    }, state: on);
    expect(find.text('Working'), findsOneWidget);
  });

  testWidgets('the uppercase transform renders the header uppercased while '
      'the label data stays canonical', (tester) async {
    await _pump(tester, {
      'type': 'list',
      'sections': [
        _section('Pinned', uppercase: true),
        _section('Plain'),
      ],
    });
    expect(find.text('PINNED'), findsOneWidget);
    expect(find.text('Pinned'), findsNothing);
    expect(find.text('Plain'), findsOneWidget);
  });

  testWidgets('the count badge renders the rounded-full pill over the '
      'badgeStyle surface', (tester) async {
    await _pump(tester, {
      'type': 'list',
      'sections': [
        _section('Snoozed', count: 2, uppercase: true),
        _section('No badge'),
      ],
    });
    expect(find.text('2'), findsOneWidget);
    expect(find.text('SNOOZED'), findsOneWidget);
    // The pill: a full-round container decoration over the badge surface.
    final pill = tester.widget<Container>(
      find.ancestor(
        of: find.text('2'),
        matching: find.byType(Container),
      ).first,
    );
    final decoration = pill.decoration! as BoxDecoration;
    expect(decoration.borderRadius, BorderRadius.circular(999));
    expect(decoration.color, isNotNull);
    // A section without count renders no badge.
    expect(find.text('No badge'), findsOneWidget);
  });

  testWidgets('the collapse state persists under the section storeKey and '
      'the stored value wins over the collapsed default on remount',
      (tester) async {
    final store = _Store();
    await _pump(tester, {
      'type': 'list',
      'sections': [
        _section('Active', storeKey: 'sidebar.section.active.collapsed'),
      ],
    }, store: store);
    expect(find.text('Active row'), findsOneWidget);

    // Collapse: the store receives true under the storeKey.
    await tester.tap(find.text('Active'));
    await _settle(tester);
    expect(find.text('Active row'), findsNothing);
    expect(store.values['sidebar.section.active.collapsed'], true);

    // A fresh mount reads the store: still collapsed despite the default.
    await _pump(tester, {
      'type': 'list',
      'sections': [
        _section('Active', storeKey: 'sidebar.section.active.collapsed'),
      ],
    }, store: store);
    await _settle(tester);
    expect(find.text('Active row'), findsNothing);

    // Expand again: the store flips back to false.
    await tester.tap(find.text('Active'));
    await _settle(tester);
    expect(find.text('Active row'), findsOneWidget);
    expect(store.values['sidebar.section.active.collapsed'], false);
  });

  testWidgets('sections without the T96 keys render exactly as before '
      '(the additive contract)', (tester) async {
    await _pump(tester, {
      'type': 'list',
      'sections': [
        {
          'label': 'Section A',
          'collapsible': true,
          'items': [
            {'type': 'text', 'text': 'A1'},
          ],
        },
      ],
    });
    expect(find.text('Section A'), findsOneWidget);
    expect(find.text('A1'), findsOneWidget);
    await tester.tap(find.text('Section A'));
    await tester.pump();
    expect(find.text('A1'), findsNothing);
  });
}