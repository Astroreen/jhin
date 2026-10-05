import 'dart:async';

import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `toast_stack` (§2.6, contract level 3): `items` (item array, required),
/// `direction?` (`top`|`bottom`, default `bottom`).
///
/// A positioned stack of transient notices (t3code `components/ui/toast.tsx`
/// viewport, commit 37de6cb): the node itself renders nothing in place —
/// its live items float over everything from an [OverlayPortal] aligned to
/// the screen edge named by `direction` — and every item carries its own
/// visible window (`duration`, default 5000 ms — the upstream 5 s undo
/// window, `showThreadUndoNotice.ts:104-112`), a dismiss button and an
/// optional inline action. New items queue: a re-render that adds an item
/// shows it alongside the still-live ones, each with a fresh window.
///
/// An item is `{text, style?, action?, duration?}` (§2.6). The item with an
/// inline action owns the upstream undo-notice look
/// (`SidebarThreadUndoNotice.tsx:17-26`): the notice text, an `Undo` text
/// button and the close control. Tapping the action dispatches it — a
/// single directive map through the action dispatcher, a `{client: […]}`
/// directive list through the directive executor — and dismisses the item.
/// `style` tints the leading icon (`error`/`success`, like the `toast`
/// directive). The card mirrors the upstream toast geometry: the popover
/// fill at the `radius.md` control radius, the md elevation, `text.sm`
/// (14 px) body.
///
/// A missing `items` array degrades visibly (§8.3); items without a `text`
/// are skipped with a log — the client never throws.
Widget buildToastStack(BuildContext context, UiNode node, RenderContext ctx) {
  final raw = node.listProp('items');
  if (raw == null) {
    return degradedBox(context, 'Missing items');
  }
  final items = <_ToastItemSpec>[];
  for (final entry in raw) {
    final item = _ToastItemSpec.parse(entry);
    if (item == null) {
      debugPrint('Jhin SDUI: toast_stack item without text skipped: $entry');
      continue;
    }
    items.add(item);
  }
  return _ToastStack(
    ctx: ctx,
    direction: _direction(node),
    items: items,
  );
}

/// The screen edge the stack grows from; unknown → `bottom` (§2.4).
String _direction(UiNode node) {
  final raw = node.stringProp('direction');
  return const {'top', 'bottom'}.contains(raw) ? raw! : 'bottom';
}

/// One parsed item spec.
class _ToastItemSpec {
  const _ToastItemSpec({
    required this.text,
    this.style,
    this.action,
    this.durationMs = 5000,
  });

  /// Parses one wire item; null when the required `text` is missing.
  static _ToastItemSpec? parse(Object? entry) {
    if (entry is String) {
      return _ToastItemSpec(text: entry);
    }
    if (entry is! Map) return null;
    final map = Map<String, dynamic>.from(entry);
    final text = map['text'];
    if (text is! String || text.isEmpty) return null;
    final style = map['style'];
    final action = map['action'];
    final duration = map['duration'];
    return _ToastItemSpec(
      text: text,
      style: style is String && const {'error', 'success'}.contains(style)
          ? style
          : null,
      action: action is Map ? Map<String, dynamic>.from(action) : null,
      durationMs:
          duration is num && duration > 0 ? duration.round() : 5000,
    );
  }

  final String text;
  final String? style;
  final Map<String, dynamic>? action;
  final int durationMs;

  /// The queue identity: a re-render with the same item does not re-show it.
  String get key => '$text\u0000$style\u0000$durationMs';
}

/// One live notice: the spec plus its dismiss timer.
class _LiveToast {
  _LiveToast(this.spec);

  final _ToastItemSpec spec;
  Timer? timer;

  void dispose() {
    timer?.cancel();
    timer = null;
  }
}

class _ToastStack extends StatefulWidget {
  const _ToastStack({
    required this.ctx,
    required this.direction,
    required this.items,
  });

  final RenderContext ctx;
  final String direction;
  final List<_ToastItemSpec> items;

  @override
  State<_ToastStack> createState() => _ToastStackState();
}

class _ToastStackState extends State<_ToastStack> {
  final OverlayPortalController _portal = OverlayPortalController();
  final List<_LiveToast> _live = <_LiveToast>[];

  @override
  void initState() {
    super.initState();
    _sync(notify: false);
  }

  @override
  void didUpdateWidget(covariant _ToastStack old) {
    super.didUpdateWidget(old);
    _sync(notify: true);
  }

  @override
  void dispose() {
    for (final toast in _live) {
      toast.dispose();
    }
    _live.clear();
    super.dispose();
  }

  /// Queues every spec not already live (queueing: a re-render that adds an
  /// item shows it alongside the still-live ones, each with a fresh window).
  void _sync({required bool notify}) {
    var changed = false;
    for (final spec in widget.items) {
      if (_live.any((toast) => toast.spec.key == spec.key)) continue;
      final toast = _LiveToast(spec);
      toast.timer = Timer(
        Duration(milliseconds: spec.durationMs),
        () => _dismiss(toast),
      );
      _live.add(toast);
      changed = true;
    }
    if (!changed) return;
    if (notify) setState(() {});
    // The portal controller needs the OverlayPortal mounted first — defer
    // the visibility flip to after the frame.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (_live.isNotEmpty && !_portal.isShowing) _portal.show();
      if (_live.isEmpty && _portal.isShowing) _portal.hide();
    });
  }

  void _dismiss(_LiveToast toast) {
    if (!mounted) return;
    setState(() {
      toast.dispose();
      _live.remove(toast);
    });
    if (_live.isEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _live.isEmpty && _portal.isShowing) _portal.hide();
      });
    }
  }

  /// Dispatches the item action — a single directive map through the
  /// dispatcher, a `{client: […]}` list through the directive executor —
  /// then dismisses the notice (the upstream undo consumes the notice).
  Future<void> _runAction(_LiveToast toast) async {
    final action = toast.spec.action;
    if (action == null) return;
    final client = action['client'];
    if (client is List) {
      await widget.ctx.runDirectives(client);
    } else {
      await widget.ctx.dispatch(action);
    }
    _dismiss(toast);
  }

  Widget _itemCard(BuildContext context, _LiveToast toast) {
    final spec = toast.spec;
    return ToastNoticeCard(
      text: spec.text,
      style: spec.style,
      action: spec.action,
      onAction: spec.action == null ? null : () => _runAction(toast),
      onDismiss: () => _dismiss(toast),
    );
  }

  @override
  Widget build(BuildContext context) {
    final design = JhinDesignScope.of(context);
    final theme = Theme.of(context);
    final tokens = design.tokens;
    final top = widget.direction == 'top';
    // Newest first: with `down` the newest sits at the top edge, with `up`
    // at the bottom edge — the upstream frontmost-toast rule.
    final ordered = List<_LiveToast>.of(_live).reversed.toList();
    return OverlayPortal(
      controller: _portal,
      overlayChildBuilder: (overlayContext) => Theme(
        data: theme,
        child: JhinDesignScope(
          design: design,
          child: SafeArea(
            child: Align(
              alignment: top ? Alignment.topCenter : Alignment.bottomCenter,
              child: Padding(
                padding: insetAll(tokens.spacing.lg),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  verticalDirection:
                      top ? VerticalDirection.down : VerticalDirection.up,
                  children: [
                    for (var i = 0; i < ordered.length; i++) ...[
                      if (i > 0) SizedBox(height: tokens.spacing.sm),
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 360),
                        child: _itemCard(overlayContext, ordered[i]),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
      child: const SizedBox.shrink(),
    );
  }
}

/// One notice card — the upstream undo-notice look
/// (`SidebarThreadUndoNotice.tsx:17-26`: the notice text, the `Undo` inline
/// button, the close control) over the upstream toast geometry: the popover
/// fill at the `radius.md` control radius, the md elevation, `text.sm`
/// (14 px) body, the corner dismiss orb (`toast.tsx:97-102`).
///
/// Shared by the `toast_stack` items and the runtime's action-carrying
/// `toast` directive (T98): the undo notice is the same card wherever it
/// surfaces from.
class ToastNoticeCard extends StatelessWidget {
  const ToastNoticeCard({
    super.key,
    required this.text,
    this.style,
    this.action,
    this.onAction,
    this.onDismiss,
  });

  /// The notice text.
  final String text;

  /// The optional style tint (`error`/`success`).
  final String? style;

  /// The inline action spec (the 5 s undo pattern); null hides the button.
  final Map<String, dynamic>? action;

  /// The action tap (null without an [action]).
  final VoidCallback? onAction;

  /// The dismiss-orb tap.
  final VoidCallback? onDismiss;

  @override
  Widget build(BuildContext context) {
    final design = JhinDesignScope.of(context);
    final tokens = design.tokens;
    final material = JhinDesignScope.materialOf(context);
    final brightness = Theme.brightnessOf(context);
    final remPx = design.switches.fontSizes.sizeInterface.toDouble();
    final radius = jhinSurfaceRadius(tokens.surface, 'md', remPx: remPx) ??
        BorderRadius.circular(8);
    final fill = design.colorOf('popover', brightness: brightness) ??
        material.colorScheme.surfaceContainerHighest;
    final foreground = design.colorOf('popover-foreground', brightness: brightness) ??
        material.colorScheme.onSurface;
    final muted = design.colorOf('muted-foreground', brightness: brightness) ??
        material.colorScheme.onSurfaceVariant;
    final bodySize = _textTokenPx(tokens.surface, 'sm', remPx) ?? 14;

    final IconData? icon;
    final Color? iconColor;
    switch (style) {
      case 'error':
        icon = iconFor('error');
        iconColor = material.colorScheme.error;
      case 'success':
        icon = iconFor('check_circle');
        iconColor = design.colorOf('success', brightness: brightness) ??
            material.colorScheme.primary;
      default:
        icon = null;
        iconColor = null;
    }

    return Material(
      type: MaterialType.card,
      color: fill,
      shadowColor: material.colorScheme.shadow,
      elevation: tokens.elevation.md,
      borderRadius: radius,
      clipBehavior: Clip.antiAlias,
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          tokens.spacing.md,
          tokens.spacing.sm,
          tokens.spacing.xs,
          tokens.spacing.sm,
        ),
        child: Row(
          children: [
            if (icon != null) ...[
              Icon(icon, size: 16, color: iconColor),
              SizedBox(width: tokens.spacing.sm),
            ],
            Expanded(
              child: Text(
                text,
                style: TextStyle(fontSize: bodySize, color: foreground),
              ),
            ),
            if (action != null)
              TextButton(
                onPressed: onAction,
                child: const Text('Undo'),
              ),
            SizedBox(width: tokens.spacing.xs),
            _DismissOrb(
              onPressed: onDismiss ?? () {},
              color: muted,
              borderColor: design.colorOf('border', brightness: brightness) ??
                  material.dividerColor,
            ),
          ],
        ),
      ),
    );
  }
}

/// The dismiss control: the upstream corner orb
/// (`toast.tsx:98-102`, a 24 px circular button over the card corner)
/// rendered inline at the row end.
class _DismissOrb extends StatelessWidget {
  const _DismissOrb({
    required this.onPressed,
    required this.color,
    required this.borderColor,
  });

  final VoidCallback onPressed;
  final Color color;
  final Color borderColor;

  @override
  Widget build(BuildContext context) {
    final icon = iconFor('close');
    return SizedBox(
      width: 24,
      height: 24,
      child: Material(
        type: MaterialType.transparency,
        shape: CircleBorder(side: BorderSide(color: borderColor)),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onPressed,
          child: Icon(icon, size: 12, color: color),
        ),
      ),
    );
  }
}

/// One §4.3 text token's px size (`text.sm` → 14); null when malformed.
double? _textTokenPx(JhinTokenSurface surface, String key, double remPx) {
  final raw = surface.value('text', key);
  if (raw is Map && raw['size'] != null) {
    return parseCssLength(raw['size'], remPx: remPx);
  }
  return null;
}
