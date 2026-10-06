import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/sdui/sdui_runtime.dart';

import '../sdui_fakes.dart';

/// T114 welcome wizard: the segmented step strip seeds the `welcomeStep`
/// local field before the step panels evaluate their `when` expressions, so
/// only the first step renders initially; a `setState` directive advances the
/// step. This is the client half of the `WelcomeScreen` builder contract.
void main() {
  Map<String, dynamic> wizard() => {
        'type': 'screen',
        'title': 'Welcome',
        'body': {
          'type': 'card',
          'children': [
            {
              'type': 'segmented',
              'id': 'welcomeStep',
              'value': 0,
              'segments': [
                {'label': 'Theme', 'value': 0},
                {'label': 'Host', 'value': 1},
              ],
            },
            {
              'type': 'column',
              'id': 'welcome-step-theme',
              'when': 'welcomeStep == 0',
              'children': [
                {'type': 'text', 'text': 'Pick a theme'},
              ],
            },
            {
              'type': 'column',
              'id': 'welcome-step-host',
              'when': 'welcomeStep == 1',
              'children': [
                {'type': 'text', 'text': 'Connect a host'},
              ],
            },
          ],
        },
      };

  testWidgets('the step strip seeds the step field so only step 0 renders',
      (tester) async {
    final transport = ScriptedTransport();
    final runtime = SduiRuntime(transport: transport);
    addTearDown(runtime.dispose);
    await tester.pumpWidget(MaterialApp(
      home: Builder(
        builder: (context) => runtime.buildScreen(
          context,
          sduiPayload(entry: 'welcome', screens: {'welcome': wizard()}),
        ),
      ),
    ));
    await tester.pump();

    expect(find.text('Pick a theme'), findsOneWidget);
    expect(find.text('Connect a host'), findsNothing);
  });

  testWidgets('a setState directive advances the visible step', (tester) async {
    final transport = ScriptedTransport();
    final runtime = SduiRuntime(transport: transport);
    addTearDown(runtime.dispose);
    await tester.pumpWidget(MaterialApp(
      home: Builder(
        builder: (context) => runtime.buildScreen(
          context,
          sduiPayload(entry: 'welcome', screens: {'welcome': wizard()}),
        ),
      ),
    ));
    await tester.pump();

    await runtime.setStateValue('welcomeStep', 1);
    await tester.pump();

    expect(find.text('Pick a theme'), findsNothing);
    expect(find.text('Connect a host'), findsOneWidget);
  });
}