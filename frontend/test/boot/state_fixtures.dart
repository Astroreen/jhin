import 'package:flutter/material.dart' hide ActionDispatcher;
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T79 fixtures: the token-driven fallback compositions of the level-2
/// `fallbacks` block (mirroring `BootstrapRoute`'s wire shape) and the
/// minimal registry harness that renders them exactly like the runtime.

/// The offline art: card + skeleton frame + retry button over `$token` refs.
Map<String, dynamic> offlineArt() => {
      'type': 'card',
      'title': 'Offline',
      'padding': r'$spacing.lg',
      'children': [
        {
          'type': 'text',
          'style': 'body',
          'text': 'The server is unreachable. Your screens are shown '
              'from the cache.',
        },
        {
          'type': 'container',
          'padding': r'$spacing.md',
          'border': r'$color.accent',
          'borderWidth': 1,
          'borderRadius': r'$radius.md',
          'children': [
            {'type': 'skeleton', 'variant': 'text', 'lines': 2, 'shimmer': true},
          ],
        },
        {
          'type': 'button',
          'label': 'Retry',
          'style': 'primary',
          'action': {'op': 'refresh'},
        },
      ],
    };

/// The error art: card + skeleton frame + retry and change-server buttons.
Map<String, dynamic> errorArt() => {
      'type': 'card',
      'title': 'Something went wrong',
      'padding': r'$spacing.lg',
      'children': [
        {
          'type': 'text',
          'style': 'body',
          'text': 'The server could not render this screen.',
        },
        {
          'type': 'container',
          'padding': r'$spacing.md',
          'border': r'$color.error',
          'borderWidth': 1,
          'borderRadius': r'$radius.md',
          'children': [
            {'type': 'skeleton', 'variant': 'text', 'lines': 2, 'shimmer': true},
          ],
        },
        {
          'type': 'button',
          'label': 'Retry',
          'style': 'primary',
          'action': {'op': 'reloadBootstrap'},
        },
        {
          'type': 'button',
          'label': 'Change server',
          'style': 'text',
          'action': {'op': 'openProfiles'},
        },
      ],
    };

/// Every node type of a wire subtree (the card/skeleton/button proof).
Set<String> typesOf(Object? json) {
  final types = <String>{};
  void walk(Object? value) {
    if (value is Map) {
      final type = value['type'];
      if (type is String) types.add(type);
      value.values.forEach(walk);
    } else if (value is List) {
      value.forEach(walk);
    }
  }

  walk(json);
  return types;
}

/// Minimal [RenderContext] over a fresh [UiState] with no-op side channels.
class TestHarness {
  final state = UiState();

  late final RenderContext ctx = RenderContext(
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
  );
}

/// A [MaterialApp] rendering [child] under [design] — the same wiring as the
/// gallery harness and `main.dart`. [child] is either a registry view over a
/// node ([nodeView]) or a built-in state widget (EmptyState, VersionGate).
Widget harnessHost(
  JhinTheme design, {
  required Widget child,
  ThemeMode mode = ThemeMode.light,
  bool disableAnimations = false,
}) {
  final body = JhinDesignScope(
    design: design,
    child: Material(child: child),
  );
  return MaterialApp(
    theme: design.light,
    darkTheme: design.dark,
    themeMode: mode,
    home: Scaffold(
      body: disableAnimations
          ? MediaQuery(
              data: const MediaQueryData(disableAnimations: true),
              child: body,
            )
          : body,
    ),
  );
}

/// A registry view over one wire node (rendered like the runtime does).
Widget nodeView(Map<String, dynamic> json) => _HarnessView(json);

class _HarnessView extends StatelessWidget {
  _HarnessView(this.json) : harness = TestHarness();

  final Map<String, dynamic> json;
  final TestHarness harness;

  @override
  Widget build(BuildContext context) {
    return harness.ctx.build(context, UiNode.fromJson(json));
  }
}
