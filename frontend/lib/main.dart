import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'core/api/api_client.dart';
import 'core/jhin_client.dart';
import 'core/state/session_store.dart';
import 'screens/connect_screen.dart';
import 'screens/sessions_screen.dart';

void main() {
  runApp(const JhinApp());
}

/// Корневое приложение Jhin: Connect → Sessions → Chat (Navigator).
///
/// [SessionStore] живёт в [MaterialApp.builder] — доступен всем роутам.
class JhinApp extends StatefulWidget {
  const JhinApp({super.key});

  @override
  State<JhinApp> createState() => _JhinAppState();
}

class _JhinAppState extends State<JhinApp> {
  SessionStore? _store;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Jhin',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.deepPurple),
      ),
      builder: (context, child) {
        final store = _store;
        if (store == null) {
          return child!;
        }
        return ChangeNotifierProvider<SessionStore>.value(
          value: store,
          child: child!,
        );
      },
      home: _ConnectGate(
        onConnected: (client, result) {
          final store = SessionStore(
            api: client.api,
            events: (id, {fromSeq}) =>
                client.sessionEvents(id, fromSeq: fromSeq),
          );
          setState(() => _store = store);
          store.loadSessions();
        },
        onDisconnected: () {
          _store?.dispose();
          setState(() => _store = null);
        },
      ),
    );
  }
}

/// Переключает ConnectScreen ↔ SessionsScreen по факту подключения.
class _ConnectGate extends StatefulWidget {
  const _ConnectGate({required this.onConnected, required this.onDisconnected});

  final ConnectCallback onConnected;
  final VoidCallback onDisconnected;

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
          widget.onConnected(client, result);
        },
      );
    }
    return SessionsScreen(
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
        widget.onDisconnected();
      },
    );
  }
}
