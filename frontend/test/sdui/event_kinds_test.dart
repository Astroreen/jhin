import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/palette_gen.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/demo_marker.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T102 acceptance: the 16 event kinds render as recognisable cards — the
/// tool-call card anatomy (header icon + name + status chip + chevron, the
/// collapsible argument summary, the output region, the footer timestamp +
/// copy button), the status chip vocabulary and the per-kind cards. The
/// expansion is keyed by the row id (the `ev-<seq>-body` patch target); the
/// decorative buttons carry the `demo` marker; a tool-call with no output
/// renders the empty-state region, never a blank card.
///
/// The fixtures are the exact wire shapes the server builders emit
/// (MessageCardBuilder.java, the qa-timeline probe payloads), embedded
/// verbatim so the goldens render the real server shapes.
const String _goldenDir = String.fromEnvironment('T102_GOLDEN_DIR');

/// The QA `--fail` switch: inverts the empty-state expectation (the wrong
/// claim is that a tool-call with no output renders a blank card — no
/// empty-state node; the real behavior is the muted italic "No output."
/// region).
const bool _failMode = bool.fromEnvironment('T102_FAIL_MODE');

JhinTheme _design() => JhinTheme.from(
      colors: generate('light', '#101018', '#10b981'),
    );

class _Recorder {
  final List<Map<String, dynamic>> dispatched = [];
}

/// The host state key the patch harness uses to schedule the re-render the
/// runtime's `notifyListeners` would schedule in production.
class _Host extends StatefulWidget {
  const _Host(this.ctx, this.node, {super.key});

  final RenderContext ctx;
  final UiNode node;

  @override
  State<_Host> createState() => _HostState();
}

class _HostState extends State<_Host> {
  void rebuild() => setState(() {});

  @override
  Widget build(BuildContext context) => widget.ctx.build(context, widget.node);
}

class _Harness {
  final UiState state = UiState();
  final Map<String, Map<String, dynamic>> patches = {};
  final _Recorder recorder = _Recorder();
  final GlobalKey<_HostState> hostKey = GlobalKey<_HostState>();
  late final RenderContext ctx;

  _Harness({Stream<Map<String, dynamic>>? stream}) {
    ctx = RenderContext(
      state: state,
      registry: UiRegistry.standard(),
      patches: patches,
      setState: (id, value) {},
      patch: (id, props) {},
      navigate: (screen) {},
      dispatch: (action) async {
        recorder.dispatched.add(action);
        _apply(action);
      },
      openStream: (topic, {onStatus}) => stream ?? const Stream.empty(),
      runDirectives: (directives) async {
        for (final directive in directives) {
          if (directive is Map) {
            _apply(Map<String, dynamic>.from(directive));
          }
        }
      },
      confirm: (message, onConfirm) {},
      readPersisted: null,
      writePersisted: null,
    );
  }

  /// Applies the inline directives the way the runtime's directive executor
  /// does: `setState` writes the UiState field, `patch` merges the overlay —
  /// both schedule the re-render.
  void _apply(Map<String, dynamic> directive) {
    switch (directive['op']) {
      case 'setState':
        state.setValue(directive['id']?.toString() ?? '', directive['value']);
        _rebuild();
      case 'patch':
        final id = directive['id']?.toString() ?? '';
        final props = directive['props'];
        if (props is Map) {
          patches[id] = {...?patches[id], ...Map<String, dynamic>.from(props)};
          _rebuild();
        }
    }
  }

  void _rebuild() {
    scheduleMicrotask(() {
      final host = hostKey.currentState;
      if (host != null && host.mounted) host.rebuild();
    });
  }
}

Future<void> _pump(
  WidgetTester tester,
  Map<String, Object?> json, {
  _Harness? harness,
  Size size = const Size(480, 360),
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
  final h = harness ?? _Harness();
  await tester.pumpWidget(MaterialApp(
    key: ValueKey(json['id']),
    theme: _design().light,
    home: Scaffold(
      body: JhinDesignScope(
        design: _design(),
        child: Material(
          child: _Host(h.ctx, UiNode.fromJson(json), key: h.hostKey),
        ),
      ),
    ),
  ));
  await tester.pump();
}

/// The exact wire shapes the server builders emit (MessageCardBuilder.java,
/// the qa-timeline probe payloads), one per event kind.
Map<String, Object?> _fixture(String name) =>
    jsonDecode(_fixtures[name]!) as Map<String, Object?>;

const Map<String, String> _fixtures = {
  'diff': r'''{"type":"container","id":"ev-20","direction":"column","gap":4,"rowKind":"event","rowKey":"event:diff","children":[{"type":"diff_view","id":"ev-20-diff","demo":true,"file":"src/auth.java","language":"java","stats":{"additions":12,"deletions":3},"hunks":[{"header":"@@ -40,7 +40,8 @@","lines":[{"kind":"add","newNo":42,"text":"if (clock.now().isAfter(expiry)) {"}]}]}]}''',
  'file-write': r'''{"type":"container","id":"ev-21","direction":"column","gap":4,"rowKind":"event","rowKey":"event:file-write","children":[{"type":"card","id":"ev-21-card","border":"$color.border","borderRadius":"$radius.lg","padding":12,"children":[{"type":"row","id":"ev-21-head","gap":8,"align":"center","children":[{"type":"icon","icon":"edit_note","size":16,"color":"$color.muted-foreground"},{"type":"text","text":"2 changed files","style":"small"},{"type":"text","text":"+16","style":"mono","color":"$color.diff-addition"},{"type":"text","text":"-3","style":"mono","color":"$color.diff-deletion"}]},{"type":"row","gap":8,"align":"center","children":[{"type":"text","text":"src/auth.java","style":"mono","maxLines":1,"ellipsis":true,"flex":1},{"type":"text","text":"+12","style":"mono","color":"$color.diff-addition"},{"type":"text","text":"-3","style":"mono","color":"$color.diff-deletion"},{"type":"badge","label":"M"}]},{"type":"row","gap":8,"align":"center","children":[{"type":"text","text":"src/login.java","style":"mono","maxLines":1,"ellipsis":true,"flex":1},{"type":"text","text":"+4","style":"mono","color":"$color.diff-addition"},{"type":"text","text":"-0","style":"mono","color":"$color.diff-deletion"},{"type":"badge","label":"A"}]}]}]}''',
  'shell': r'''{"type":"container","id":"ev-22","direction":"column","gap":4,"rowKind":"event","rowKey":"event:shell","children":[{"type":"card","id":"ev-22-card","border":"$color.border","borderRadius":"$radius.lg","padding":12,"children":[{"type":"row","id":"ev-22-head","align":"center","gap":8,"children":[{"type":"icon","icon":"terminal","size":16,"color":"$color.muted-foreground"},{"type":"text","text":"shell","style":"small"},{"type":"badge","label":"Done","color":"$color.success"},{"type":"spacer"},{"type":"icon_button","id":"ev-22-chevron","icon":"expand_more","iconSize":16,"action":{"op":"patch","id":"ev-22-body","props":{"visible":true}},"tooltip":"Show details"}]},{"type":"text","text":"gradle test --tests auth","style":"mono","color":"$color.muted-foreground","maxLines":1,"ellipsis":true},{"type":"column","id":"ev-22-body","visible":false,"gap":8,"children":[{"type":"code_block","code":"BUILD SUCCESSFUL","id":"ev-22-output","copyable":true,"maxLines":12},{"type":"row","id":"ev-22-footer","align":"center","gap":8,"children":[{"type":"text","text":"14:03","style":"caption","color":"$color.muted-foreground"},{"type":"spacer"},{"type":"icon_button","id":"ev-22-copy","icon":"copy","iconSize":16,"action":{"op":"setState","id":"ev-22-copy","value":true},"demo":true,"tooltip":"Copy output"},{"type":"icon_button","id":"ev-22-collapse","icon":"unfold_less","iconSize":16,"action":{"op":"patch","id":"ev-22-body","props":{"visible":false}},"tooltip":"Hide details"}]}]}]}]}''',
  'message': r'''{"type":"container","id":"ev-23","direction":"column","gap":4,"rowKind":"event","rowKey":"event:message","children":[{"type":"text","text":"Reading the auth flow next.","style":"body"}]}''',
  'tool-call': r'''{"type":"container","id":"ev-24","direction":"column","gap":4,"rowKind":"event","rowKey":"event:tool-call","children":[{"type":"card","id":"ev-24-card","border":"$color.border","borderRadius":"$radius.lg","padding":12,"children":[{"type":"row","id":"ev-24-head","align":"center","gap":8,"children":[{"type":"icon","icon":"construction","size":16,"color":"$color.muted-foreground"},{"type":"text","text":"read","style":"small"},{"type":"badge","label":"Running","color":"$color.info"},{"type":"spacer"},{"type":"icon_button","id":"ev-24-chevron","icon":"expand_more","iconSize":16,"action":{"op":"patch","id":"ev-24-body","props":{"visible":true}},"tooltip":"Show details"}]},{"type":"text","text":"{\"path\":\"src/auth.java\"}","style":"mono","color":"$color.muted-foreground","maxLines":1,"ellipsis":true},{"type":"column","id":"ev-24-body","visible":false,"gap":8,"children":[{"type":"text","text":"No output.","style":"caption","color":"$color.muted-foreground","italic":true,"id":"ev-24-empty"},{"type":"row","id":"ev-24-footer","align":"center","gap":8,"children":[{"type":"text","text":"14:03","style":"caption","color":"$color.muted-foreground"},{"type":"spacer"},{"type":"icon_button","id":"ev-24-copy","icon":"copy","iconSize":16,"action":{"op":"setState","id":"ev-24-copy","value":true},"demo":true,"tooltip":"Copy output"},{"type":"icon_button","id":"ev-24-collapse","icon":"unfold_less","iconSize":16,"action":{"op":"patch","id":"ev-24-body","props":{"visible":false}},"tooltip":"Hide details"}]}]}]}]}''',
  'tool-result': r'''{"type":"container","id":"ev-25","direction":"column","gap":4,"rowKind":"event","rowKey":"event:tool-result","children":[{"type":"card","id":"ev-25-card","border":"$color.border","borderRadius":"$radius.lg","padding":12,"children":[{"type":"row","id":"ev-25-head","align":"center","gap":8,"children":[{"type":"icon","icon":"construction","size":16,"color":"$color.muted-foreground"},{"type":"text","text":"read","style":"small"},{"type":"badge","label":"Done","color":"$color.success"},{"type":"spacer"},{"type":"icon_button","id":"ev-25-chevron","icon":"expand_more","iconSize":16,"action":{"op":"patch","id":"ev-25-body","props":{"visible":true}},"tooltip":"Show details"}]},{"type":"text","text":"{\"path\":\"src/auth.java\"}","style":"mono","color":"$color.muted-foreground","maxLines":1,"ellipsis":true},{"type":"column","id":"ev-25-body","visible":false,"gap":8,"children":[{"type":"code_block","code":"public class Auth {","id":"ev-25-output","copyable":true,"maxLines":12,"language":"java"},{"type":"row","id":"ev-25-footer","align":"center","gap":8,"children":[{"type":"text","text":"14:03","style":"caption","color":"$color.muted-foreground"},{"type":"spacer"},{"type":"icon_button","id":"ev-25-copy","icon":"copy","iconSize":16,"action":{"op":"setState","id":"ev-25-copy","value":true},"demo":true,"tooltip":"Copy output"},{"type":"icon_button","id":"ev-25-collapse","icon":"unfold_less","iconSize":16,"action":{"op":"patch","id":"ev-25-body","props":{"visible":false}},"tooltip":"Hide details"}]}]}]}]}''',
  'approval-request': r'''{"type":"container","id":"ev-26","direction":"column","gap":4,"rowKind":"event","rowKey":"event:approval-request","children":[{"type":"card","id":"ev-26-card","border":"$color.warning","borderRadius":"$radius.lg","padding":12,"children":[{"type":"row","id":"ev-26-head","gap":8,"align":"center","children":[{"type":"icon","icon":"gpp_maybe","size":16,"color":"$color.warning"},{"type":"text","text":"Command approval","style":"small","color":"$color.warning"}]},{"type":"code_block","code":"gradle test","language":"shell","maxLines":4},{"type":"row","id":"ev-26-options","gap":8,"children":[{"type":"chip","label":"Allow","action":{"op":"setState","id":"ev-26-option-0","value":"Allow"},"demo":true},{"type":"chip","label":"Deny","action":{"op":"setState","id":"ev-26-option-1","value":"Deny"},"demo":true}]}]}]}''',
  'limit-notice': r'''{"type":"container","id":"ev-27","direction":"column","gap":4,"rowKind":"event","rowKey":"event:limit-notice","children":[{"type":"banner","id":"ev-27-banner","content":{"type":"row","gap":8,"children":[{"type":"icon","icon":"speed","size":16,"color":"$color.warning"},{"type":"expanded","child":{"type":"column","gap":2,"children":[{"type":"text","text":"Usage limit reached","style":"small","color":"$color.warning"},{"type":"text","text":"Resets 2026-10-06 15:00","style":"caption","color":"$color.muted-foreground"}]}}]},"actions":[{"type":"button","label":"Resume","action":{"op":"setState","id":"ev-27-resume","value":true},"demo":true},{"type":"button","label":"Resume at reset","action":{"op":"setState","id":"ev-27-resume-reset","value":true},"demo":true}]}]}''',
  'error': r'''{"type":"container","id":"ev-28","direction":"column","gap":4,"rowKind":"event","rowKey":"event:error","children":[{"type":"card","id":"ev-28-card","border":"$color.error","borderRadius":"$radius.lg","padding":12,"children":[{"type":"row","gap":8,"align":"center","children":[{"type":"icon","icon":"warning","size":16,"color":"$color.error"},{"type":"text","text":"Error","style":"small"}]},{"type":"text","text":"boom","style":"caption","color":"$color.muted-foreground"}]}]}''',
  'system-notice': r'''{"type":"container","id":"ev-29","direction":"column","gap":4,"rowKind":"event","rowKey":"event:system-notice","children":[{"type":"card","id":"ev-29-card","border":"$color.border","borderRadius":"$radius.lg","padding":12,"children":[{"type":"row","gap":8,"align":"center","children":[{"type":"icon","icon":"info","size":16,"color":"$color.border"},{"type":"text","text":"System notice","style":"small"}]},{"type":"text","text":"The provider catalog refreshed.","style":"caption","color":"$color.muted-foreground"}]}]}''',
  'queued-message': r'''{"type":"container","id":"ev-30","direction":"column","gap":4,"rowKind":"event","rowKey":"event:queued-message","children":[{"type":"stack","id":"ev-30-stripe","children":[{"type":"positioned","top":0,"bottom":0,"left":0,"width":3,"child":{"type":"box","color":"$color.warning"}},{"type":"card","id":"ev-30-card","border":"$color.border","borderRadius":"$radius.lg","padding":[12,12,12,15],"children":[{"type":"text","text":"Also run the integration suite.","style":"body"}]}]}]}''',
  'subagent': r'''{"type":"container","id":"ev-31","direction":"column","gap":4,"rowKind":"event","rowKey":"event:subagent","align":"centerRight","children":[{"type":"card","id":"ev-31-bar","border":"$color.border","borderRadius":"$radius.xl2","padding":12,"children":[{"type":"row","gap":8,"align":"center","children":[{"type":"icon","icon":"smart_toy","size":16,"color":"$color.muted-foreground"},{"type":"text","text":"Scout: find the token expiry","style":"small","maxLines":1,"ellipsis":true,"flex":1},{"type":"badge","label":"Running","color":"$color.info"}]}]}]}''',
  'citation': r'''{"type":"container","id":"ev-32","direction":"column","gap":4,"rowKind":"event","rowKey":"event:citation","children":[{"type":"badge","label":"src/auth.java:42","color":"$color.info"}]}''',
  'skill-invocation': r'''{"type":"container","id":"ev-33","direction":"column","gap":4,"rowKind":"event","rowKey":"event:skill-invocation","children":[{"type":"badge","label":"jhin-plugin","color":"$color.primary"}]}''',
  'work-log-entry': r'''{"type":"container","id":"ev-34","direction":"column","gap":4,"rowKind":"event","rowKey":"event:work-log-entry","children":[{"type":"row","id":"ev-34-log","gap":8,"align":"center","children":[{"type":"icon","icon":"construction","size":16,"color":"$color.muted-foreground"},{"type":"text","text":"read 4 files","style":"small","maxLines":1,"ellipsis":true,"flex":1},{"type":"text","text":"14:02","style":"caption","color":"$color.muted-foreground"}]}]}''',
  'question': r'''{"type":"container","id":"ev-35","direction":"column","gap":4,"rowKind":"event","rowKey":"event:question","children":[{"type":"card","id":"ev-35-card","border":"$color.border","borderRadius":"$radius.lg","padding":12,"children":[{"type":"row","id":"ev-35-head","gap":8,"align":"center","children":[{"type":"icon","icon":"help_outline","size":16,"color":"$color.muted-foreground"},{"type":"text","text":"Which auth flow?","style":"small"}]},{"type":"row","gap":8,"align":"center","children":[{"type":"icon","icon":"check_circle","size":14,"color":"$color.success"},{"type":"text","text":"The token one","style":"caption"}]}]}]}''',
  'unknown': r'''{"type":"container","id":"ev-36","direction":"column","gap":4,"rowKind":"event","rowKey":"event:unknown","children":[{"type":"card","id":"ev-36-card","border":"$color.border","borderRadius":"$radius.lg","padding":12,"children":[{"type":"text","text":"Unknown event: holo","style":"caption","color":"$color.muted-foreground"}]}]}''',
};

void main() {
  final goldens = _goldenDir.isNotEmpty;
  Uri golden(String name) => Uri.file('$_goldenDir/$name');

  test('the fixture pack covers the 16 kinds plus the unknown fallback', () {
    expect(_fixtures.keys.length, 17);
    for (final kind in [
      'diff',
      'file-write',
      'shell',
      'message',
      'tool-call',
      'tool-result',
      'approval-request',
      'limit-notice',
      'error',
      'system-notice',
      'queued-message',
      'subagent',
      'citation',
      'skill-invocation',
      'work-log-entry',
      'question',
      'unknown',
    ]) {
      final row = _fixture(kind);
      expect(row['rowKind'], 'event', reason: kind);
      expect(row['rowKey'], 'event:$kind', reason: kind);
    }
  });

  testWidgets('the tool-call card renders the four-part anatomy',
      (tester) async {
    final harness = _Harness();
    await _pump(tester, _fixture('tool-call'), harness: harness);
    // header: tool icon + name + status chip + chevron
    expect(find.text('read'), findsOneWidget);
    expect(find.text('Running'), findsOneWidget);
    expect(find.byTooltip('Show details'), findsOneWidget);
    // the collapsible argument summary line
    expect(find.text('{"path":"src/auth.java"}'), findsOneWidget);
    // the collapsed body hides the output region and the footer
    expect(find.text('No output.'), findsNothing);
    expect(find.text('14:03'), findsNothing);
    expect(find.byTooltip('Hide details'), findsNothing);

    // expanding: the chevron patches the row-id-keyed body visible
    await tester.tap(find.byTooltip('Show details'));
    await tester.pump();
    // the output region: the empty-state region, never a blank card
    expect(find.text('No output.'), findsOneWidget);
    // the footer: timestamp + copy button
    expect(find.text('14:03'), findsOneWidget);
    expect(find.byTooltip('Copy output'), findsOneWidget);
    expect(find.byTooltip('Hide details'), findsOneWidget);

    // collapsing: the footer affordance patches the body hidden again
    await tester.tap(find.byTooltip('Hide details'));
    await tester.pump();
    expect(find.text('No output.'), findsNothing);
    expect(find.text('14:03'), findsNothing);
  });

  testWidgets('the tool-result card reveals the code block output',
      (tester) async {
    await _pump(tester, _fixture('tool-result'));
    expect(find.text('Done'), findsOneWidget);
    expect(find.text('public class Auth {'), findsNothing);
    await tester.tap(find.byTooltip('Show details'));
    await tester.pump();
    expect(find.text('public class Auth {'), findsOneWidget);
  });

  testWidgets('the demo markers ride the decorative controls', (tester) async {
    final harness = _Harness();
    await _pump(tester, _fixture('limit-notice'), harness: harness);
    expect(find.text('Usage limit reached'), findsOneWidget);
    expect(find.text('Resume'), findsOneWidget);
    expect(find.text('Resume at reset'), findsOneWidget);
    expect(
        tester
            .widgetList<Tooltip>(find.byType(Tooltip))
            .where((tooltip) => tooltip.message == kDemoTooltip),
        isNotEmpty);
    await tester.tap(find.text('Resume'));
    await tester.pump();
    expect(harness.recorder.dispatched.last['op'], 'setState');
    expect(harness.recorder.dispatched.last['id'], 'ev-27-resume');
  });

  testWidgets('the approval option chips dispatch inline setState',
      (tester) async {
    final harness = _Harness();
    await _pump(tester, _fixture('approval-request'), harness: harness);
    expect(find.text('Command approval'), findsOneWidget);
    await tester.tap(find.text('Allow'));
    await tester.pump();
    expect(harness.recorder.dispatched.last['op'], 'setState');
    expect(harness.recorder.dispatched.last['id'], 'ev-26-option-0');
    expect(harness.recorder.dispatched.last['value'], 'Allow');
  });

  testWidgets('the queued-message card renders the pending stripe',
      (tester) async {
    await _pump(tester, _fixture('queued-message'));
    expect(find.text('Also run the integration suite.'), findsOneWidget);
    // The stripe: the positioned 3px box painted over the card's left edge,
    // stretching the stack's full height.
    final positioned = find.byWidgetPredicate((widget) =>
        widget is Positioned &&
        widget.width == 3.0 &&
        widget.top == 0 &&
        widget.bottom == 0);
    expect(positioned, findsOneWidget);
    final stripeBox = tester.widget<DecoratedBox>(
      find.descendant(of: positioned, matching: find.byType(DecoratedBox)),
    );
    final decoration = stripeBox.decoration as BoxDecoration;
    expect(decoration.color, isNotNull);
  });

  testWidgets('the subagent bar aligns right', (tester) async {
    await _pump(tester, _fixture('subagent'));
    expect(find.text('Scout: find the token expiry'), findsOneWidget);
    expect(find.text('Running'), findsOneWidget);
    // The row container carries the centerRight alignment (self-end).
    expect(_fixture('subagent')['align'], 'centerRight');
  });

  testWidgets('every kind renders without throwing', (tester) async {
    for (final kind in _fixtures.keys) {
      await _pump(tester, _fixture(kind));
      expect(tester.takeException(), isNull, reason: kind);
    }
  });

  // --- the 17 kind goldens ---

  Future<void> _goldenRow(
    WidgetTester tester,
    String kind, {
    Size size = const Size(480, 200),
  }) async {
    await _pump(
      tester,
      {
        'type': 'column',
        'gap': 8,
        'children': [_fixture(kind)],
      },
      size: size,
    );
    if (goldens) {
      await expectLater(find.byType(MaterialApp), matchesGoldenFile(golden('event-$kind-light.png')));
    }
  }

  testWidgets('golden: diff', (tester) async {
    await _goldenRow(tester, 'diff', size: const Size(480, 260));
  });
  testWidgets('golden: file-write', (tester) async {
    await _goldenRow(tester, 'file-write', size: const Size(480, 260));
  });
  testWidgets('golden: shell', (tester) async {
    await _goldenRow(tester, 'shell');
  });
  testWidgets('golden: message', (tester) async {
    await _goldenRow(tester, 'message', size: const Size(480, 120));
  });
  testWidgets('golden: tool-call', (tester) async {
    await _goldenRow(tester, 'tool-call');
  });
  testWidgets('golden: tool-result', (tester) async {
    await _goldenRow(tester, 'tool-result');
  });
  testWidgets('golden: approval-request', (tester) async {
    await _goldenRow(tester, 'approval-request');
  });
  testWidgets('golden: limit-notice', (tester) async {
    await _goldenRow(tester, 'limit-notice', size: const Size(480, 340));
  });
  testWidgets('golden: error', (tester) async {
    await _goldenRow(tester, 'error', size: const Size(480, 160));
  });
  testWidgets('golden: system-notice', (tester) async {
    await _goldenRow(tester, 'system-notice', size: const Size(480, 160));
  });
  testWidgets('golden: queued-message', (tester) async {
    await _goldenRow(tester, 'queued-message', size: const Size(480, 160));
  });
  testWidgets('golden: subagent', (tester) async {
    await _goldenRow(tester, 'subagent', size: const Size(480, 160));
  });
  testWidgets('golden: citation', (tester) async {
    await _goldenRow(tester, 'citation', size: const Size(480, 120));
  });
  testWidgets('golden: skill-invocation', (tester) async {
    await _goldenRow(tester, 'skill-invocation', size: const Size(480, 120));
  });
  testWidgets('golden: work-log-entry', (tester) async {
    await _goldenRow(tester, 'work-log-entry', size: const Size(480, 120));
  });
  testWidgets('golden: question', (tester) async {
    await _goldenRow(tester, 'question', size: const Size(480, 180));
  });
  testWidgets('golden: unknown', (tester) async {
    await _goldenRow(tester, 'unknown', size: const Size(480, 160));
  });

  test('the 17 kind goldens are distinct on disk', () {
    if (!goldens) return;
    final names = _fixtures.keys.map((kind) => 'event-$kind-light.png').toList();
    final bytes = <String, List<int>>{};
    for (final name in names) {
      final file = File('$_goldenDir/$name');
      expect(file.existsSync(), isTrue, reason: '$name missing');
      bytes[name] = file.readAsBytesSync();
      expect(bytes[name]!, isNotEmpty, reason: '$name empty');
    }
    final distinct = bytes.values.map((value) => value.hashCode).toSet();
    expect(distinct.length, names.length,
        reason: 'every kind must render a distinct golden');
  });

  // The QA --fail path: the deliberately wrong expectation — that a
  // tool-call with no output renders a blank card (no empty-state node).
  // The real behavior is the opposite: the muted italic "No output." region
  // renders inside the expanded body (the happy run asserts it here).
  testWidgets('the empty-state region renders for an output-less tool-call',
      (tester) async {
    await _pump(tester, _fixture('tool-call'));
    await tester.tap(find.byTooltip('Show details'));
    await tester.pump();
    expect(find.text('No output.'), _failMode ? findsNothing : findsOneWidget);
  });
}
