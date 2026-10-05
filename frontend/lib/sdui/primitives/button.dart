import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `button` (§8.3): `label`, `style: primary|secondary|danger|text`,
/// `action?`, `icon?`, `confirm?`.
///
/// A button without an `action` renders disabled. With `confirm` set, a
/// confirmation dialog (confirm/cancel) opens first and the action is
/// dispatched only on confirm. A missing `label` degrades to a visible
/// placeholder.
///
/// T87: the solid styles (primary, secondary, danger) carry the upstream
/// inset control shades (index.css:188-189,
/// ComposerPrimaryActions.tsx:286) — the 1px `controlHighlight` top line at
/// rest, switching to `controlPressed` while pressed. The `text` style has
/// no surface and stays bare.
Widget buildButton(BuildContext context, UiNode node, RenderContext ctx) {
  final label = node.stringProp('label');
  if (label == null) {
    return degradedBox(context, 'Missing label');
  }
  final style = node.stringProp('style') ?? 'primary';
  final icon = iconFor(node.stringProp('icon'));
  final action = asMap(node.props['action']);
  final confirm = node.stringProp('confirm');
  // Universal `enabled: false` (§2.1) gates the button's own dispatch just
  // like the gesture wrapper gates the universal one.
  final enabled = node.boolProp('enabled') != false;
  final VoidCallback? onPressed = action == null || !enabled
      ? null
      : () {
          if (confirm != null && confirm.isNotEmpty) {
            ctx.confirm(confirm, () => ctx.dispatch(action));
          } else {
            ctx.dispatch(action);
          }
        };

  final iconWidget = icon == null ? null : Icon(icon);
  final bool solid = style != 'text';
  Widget button;
  switch (style) {
    case 'secondary':
      button = iconWidget == null
          ? OutlinedButton(onPressed: onPressed, child: Text(label))
          : OutlinedButton.icon(
              onPressed: onPressed, icon: iconWidget, label: Text(label));
    case 'danger':
      final danger = ElevatedButton.styleFrom(
          foregroundColor: JhinDesignScope.materialOf(context).colorScheme.onError,
          backgroundColor: JhinDesignScope.materialOf(context).colorScheme.error);
      button = iconWidget == null
          ? ElevatedButton(
              style: danger, onPressed: onPressed, child: Text(label))
          : ElevatedButton.icon(
              style: danger,
              onPressed: onPressed,
              icon: iconWidget,
              label: Text(label));
    case 'text':
      button = iconWidget == null
          ? TextButton(onPressed: onPressed, child: Text(label))
          : TextButton.icon(
              onPressed: onPressed, icon: iconWidget, label: Text(label));
    default:
      button = iconWidget == null
          ? ElevatedButton(onPressed: onPressed, child: Text(label))
          : ElevatedButton.icon(
              onPressed: onPressed, icon: iconWidget, label: Text(label));
  }
  if (!solid || onPressed == null) return button;
  return _InsetShadowControl(child: button);
}

/// The inset control shades of one solid button (T87): a stadium clip over
/// the button with the 1px top line — `controlHighlight` at rest,
/// `controlPressed` while the pointer is down (the upstream
/// `inset-shadow-control-highlight` / `active:inset-shadow-control-pressed`
/// pair). Disabled buttons skip the wrapper.
class _InsetShadowControl extends StatefulWidget {
  const _InsetShadowControl({required this.child});

  final Widget child;

  @override
  State<_InsetShadowControl> createState() => _InsetShadowControlState();
}

class _InsetShadowControlState extends State<_InsetShadowControl> {
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final tokens = JhinDesignScope.of(context).tokens;
    final rest = jhinControlHighlight(tokens.surface);
    final pressed = jhinControlPressed(tokens.surface);
    if (rest == null && pressed == null) return widget.child;
    final line = (_pressed ? pressed ?? rest : rest)!;
    return Listener(
      onPointerDown: (_) => setState(() => _pressed = true),
      onPointerUp: (_) => setState(() => _pressed = false),
      onPointerCancel: (_) => setState(() => _pressed = false),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(tokens.radius.full),
        child: Stack(
          children: [
            widget.child,
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              height: line.offset <= 0 ? 1 : line.offset,
              child: IgnorePointer(child: ColoredBox(color: line.color)),
            ),
          ],
        ),
      ),
    );
  }
}
