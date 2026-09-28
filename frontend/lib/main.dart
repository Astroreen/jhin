import 'package:flutter/material.dart';

import 'core/api/api_client.dart';
import 'core/jhin_client.dart';
import 'screens/connect_screen.dart';

void main() {
  runApp(const JhinApp());
}

/// Корневое приложение Jhin (T28): стартует с [ConnectScreen], после enroll —
/// домашняя заглушка (экраны сессий — T29+).
class JhinApp extends StatelessWidget {
  const JhinApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Jhin',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.deepPurple),
      ),
      home: const _ConnectGate(),
    );
  }
}

/// Переключает ConnectScreen ↔ домашнюю заглушку по факту подключения.
class _ConnectGate extends StatefulWidget {
  const _ConnectGate();

  @override
  State<_ConnectGate> createState() => _ConnectGateState();
}

class _ConnectGateState extends State<_ConnectGate> {
  JhinClient? _client;
  EnrollResult? _result;

  @override
  Widget build(BuildContext context) {
    final client = _client;
    final result = _result;
    if (client == null || result == null) {
      return ConnectScreen(
        onConnected: (client, result) {
          setState(() {
            _client = client;
            _result = result;
          });
        },
      );
    }
    return _HomeStub(
      accountName: result.accountName,
      onSignOut: () async {
        await client.signOut();
        client.close();
        if (!mounted) {
          return;
        }
        setState(() {
          _client = null;
          _result = null;
        });
      },
    );
  }
}

/// Домашняя заглушка до появления экранов сессий (T29).
class _HomeStub extends StatelessWidget {
  const _HomeStub({required this.accountName, required this.onSignOut});

  final String accountName;
  final Future<void> Function() onSignOut;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Jhin')),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text('Connected as $accountName'),
            const SizedBox(height: 16),
            ElevatedButton(onPressed: onSignOut, child: const Text('Sign out')),
          ],
        ),
      ),
    );
  }
}
