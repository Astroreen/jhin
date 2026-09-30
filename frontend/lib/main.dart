import 'package:flutter/material.dart';

void main() {
  runApp(const JhinApp());
}

/// Transport-only shell placeholder.
///
/// The v1 product UI is gone; the server-profile surface and the SDUI boot
/// host replace this in T21. Keep this file compiling and product-neutral.
class JhinApp extends StatelessWidget {
  const JhinApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Jhin',
      home: const Scaffold(
        body: Center(child: Text('Jhin')),
      ),
    );
  }
}