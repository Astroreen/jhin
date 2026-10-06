// T79 golden states: offline, error, empty, version-gate and loading —
// one baseline PNG per state on a fixed 800x1200 light surface (delta: 5
// new goldens, zero regenerated pre-existing baselines).
//
// The node states (offline / error / loading) pump the exact wire art
// through the registry like the runtime does; the built-in chrome states
// (empty / version-gate) pump the client widgets. Both ride the gallery
// harness wiring (explicit MaterialApp theme/darkTheme/themeMode plus a
// JhinDesignScope) — see frontend/test/gallery/golden_test.dart.
//
// Regenerate after an intentional visual change:
//   scripts/qa/flutter-test.sh test/boot --update-goldens
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/boot/empty_state.dart';
import 'package:jhin/boot/loading_frame.dart';
import 'package:jhin/boot/version_gate.dart';
import 'package:jhin/design/theme.dart';

import 'state_fixtures.dart';

const _surfaceSize = Size(800, 1200);

void main() {
  final design = JhinTheme.from(density: 'comfortable');

  Future<void> pumpState(WidgetTester tester, Widget child, String name) async {
    tester.view.physicalSize = _surfaceSize;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    await tester.pumpWidget(harnessHost(design, child: child));
    await tester.pump();
    expect(tester.takeException(), isNull);
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/state-$name.png'),
    );
  }

  testWidgets('offline state (fallbacks.offline)', (tester) async {
    await pumpState(tester, nodeView(offlineArt()), 'offline');
  });

  testWidgets('error state (fallbacks.error)', (tester) async {
    await pumpState(tester, nodeView(errorArt()), 'error');
  });

  testWidgets('empty state (built-in EmptyState)', (tester) async {
    await pumpState(
      tester,
      const EmptyState(
        kernelVersion: '0.2.0',
        pluginCount: 0,
        onChangeServer: _noop,
      ),
      'empty',
    );
  });

  testWidgets('version-gate state (update required)', (tester) async {
    await pumpState(
      tester,
      VersionGate(
        mode: VersionGateMode.updateRequired,
        onDiskSchema: 2,
        minSchema: 3,
        onDismiss: _noop,
      ),
      'version-gate',
    );
  });

  testWidgets('loading state (built-in skeleton frame)', (tester) async {
    await pumpState(tester, nodeView(loadingFrameJson), 'loading');
  });

  testWidgets('no-active-thread hero (T114)', (tester) async {
    await pumpState(
      tester,
      const NoActiveThreadState(onStartConversation: _noop),
      'no-active-thread',
    );
  });

  testWidgets('no-projects hero (T114)', (tester) async {
    await pumpState(
      tester,
      const NoProjectsHero(onAddProject: _noop, onStartWithoutProject: _noop),
      'no-projects',
    );
  });
}

void _noop() {}
