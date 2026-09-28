import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/ui/renderer/ui_renderer.dart';
import 'package:jhin/ui/ui_context.dart';

/// Тестовый контекст SDUI: записывает вызовы onAction.
UiContext testCtx({
  void Function(String action, Map<String, dynamic>? payload)? onAction,
}) =>
    UiContext(
      sessionId: 'sess-1',
      onAction: onAction ?? (action, payload) {},
    );

/// Помпует [json] через [buildUi] в MaterialApp+Scaffold (со скроллом).
Future<void> pumpUi(
  WidgetTester tester,
  Map<String, dynamic> json, {
  UiContext? ctx,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(child: buildUi(json, ctx ?? testCtx())),
      ),
    ),
  );
  await tester.pumpAndSettle();
}
