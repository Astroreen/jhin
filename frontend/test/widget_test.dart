import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/main.dart';
import 'package:jhin/screens/connect_screen.dart';

void main() {
  testWidgets('app starts on connect screen', (WidgetTester tester) async {
    await tester.pumpWidget(const JhinApp());

    expect(find.byType(ConnectScreen), findsOneWidget);
    expect(find.text('Server URL'), findsOneWidget);
    expect(find.text('Enrollment code'), findsOneWidget);
    expect(find.text('Device name'), findsOneWidget);
    expect(find.text('Connect'), findsOneWidget);
  });
}
