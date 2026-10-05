import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/sdui_runtime.dart';

import '../sdui_fakes.dart';

/// T98 tests: the undo notice of the `toast` directive — an action-carrying
/// toast renders through the `toast_stack` undo-notice card look (label +
/// `Undo` + close) at the bottom edge with its own window, and the `Undo`
/// tap dispatches the inline action (the upstream 5 s undo window,
/// `showThreadUndoNotice.ts:104-112`, and the notice look
/// `SidebarThreadUndoNotice.tsx:17-26`, commit 37de6cb). A plain toast
/// keeps the banner.
Widget _host(SduiRuntime runtime) {
  final d = JhinTheme.from();
  return MaterialApp(
    theme: d.light,
    home: Builder(
      builder: (context) => runtime.buildScreen(
        context,
        sduiPayload(entry: 'home', screens: {
          'home': {'type': 'text', 'text': 'home-screen'},
        }),
      ),
    ),
  );
}

void main() {
  testWidgets('an action-carrying toast renders the undo-notice card at the '
      'bottom edge', (tester) async {
    final transport = ScriptedTransport();
    final runtime = SduiRuntime(transport: transport);
    addTearDown(runtime.dispose);
    await tester.pumpWidget(_host(runtime));
    await tester.pump();

    await runtime.toast('Settled 1 thread,', null,
        action: {'path': '/ui/action/undo', 'method': 'POST', 'name': 'undo'});
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 1));

    expect(find.text('Settled 1 thread,'), findsOneWidget);
    expect(find.text('Undo'), findsOneWidget);
    final card = tester.getTopLeft(find.text('Settled 1 thread,'));
    expect(card.dy, greaterThan(400),
        reason: 'the notice stack grows from the bottom edge');
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('the Undo tap dispatches the inline action and consumes the '
      'notice', (tester) async {
    final transport = ScriptedTransport();
    final posts = <String>[];
    transport.onPost = (path, body) {
      posts.add(path);
      return {'client': <dynamic>[]};
    };
    final runtime = SduiRuntime(transport: transport);
    addTearDown(runtime.dispose);
    await tester.pumpWidget(_host(runtime));
    await tester.pump();

    await runtime.toast('Unpinned 1 thread,', null,
        action: {'path': '/ui/action/undo', 'method': 'POST', 'name': 'undo'});
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 1));

    await tester.tap(find.text('Undo'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 1));
    expect(posts, ['/ui/action/undo'],
        reason: 'the undo action posted');
    expect(find.text('Unpinned 1 thread,'), findsNothing,
        reason: 'the undo consumes the notice');
  });

  testWidgets('the notice closes after its window (5 s default)',
      (tester) async {
    final transport = ScriptedTransport();
    final runtime = SduiRuntime(transport: transport);
    addTearDown(runtime.dispose);
    await tester.pumpWidget(_host(runtime));
    await tester.pump();

    await runtime.toast('Snoozed 1 thread,', null,
        action: {'path': '/ui/action/undo', 'method': 'POST', 'name': 'undo'});
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 1));
    expect(find.text('Snoozed 1 thread,'), findsOneWidget);

    await tester.pump(const Duration(milliseconds: 4900));
    expect(find.text('Snoozed 1 thread,'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('Snoozed 1 thread,'), findsNothing,
        reason: 'the 5 s window elapsed');
  });

  testWidgets('a custom duration wins and the close orb dismisses early',
      (tester) async {
    final transport = ScriptedTransport();
    final runtime = SduiRuntime(transport: transport);
    addTearDown(runtime.dispose);
    await tester.pumpWidget(_host(runtime));
    await tester.pump();

    await runtime.toast('Archived 1 thread,', null,
        action: {'path': '/ui/action/undo', 'method': 'POST', 'name': 'undo'},
        durationMs: 1000);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 1));
    expect(find.text('Archived 1 thread,'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 1100));
    expect(find.text('Archived 1 thread,'), findsNothing);

    await runtime.toast('Archived 1 thread,', null,
        action: {'path': '/ui/action/undo', 'method': 'POST', 'name': 'undo'},
        durationMs: 10_000);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 1));
    await tester.tap(find.byIcon(Icons.close));
    await tester.pump();
    expect(find.text('Archived 1 thread,'), findsNothing,
        reason: 'the close orb dismissed the notice');
  });

  testWidgets('a plain toast keeps the banner (no undo card)',
      (tester) async {
    final transport = ScriptedTransport();
    final runtime = SduiRuntime(transport: transport);
    addTearDown(runtime.dispose);
    await tester.pumpWidget(_host(runtime));
    await tester.pump();

    await runtime.toast('Nothing to undo', 'error');
    await tester.pump();
    expect(find.text('Nothing to undo'), findsOneWidget);
    expect(find.text('Undo'), findsNothing);
    await tester.pump(const Duration(seconds: 4));
  });
}
