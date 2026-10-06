import 'dart:async';

import 'package:flutter/widgets.dart';

import 'command_registry.dart';
import 'keymap.dart';
import 'when_context.dart';

/// Installs the keyboard command machinery around a subtree: every hardware
/// key chord that matches an active rule of [keymap] is dispatched through
/// [registry] (T67).
///
/// Mechanism: a single [Focus] hub below the app shell, not a static
/// `Shortcuts` map — rule activity (`when` over [WhenContext], last match
/// wins) is evaluated per key event, which a map of activators cannot do.
/// The hub never swallows a key no active rule matches, so ordinary typing
/// and default text-editing shortcuts keep working.
///
/// Typing policy: a context-free rule is suspended while text is being
/// entered — `editableFocus`/`composerFocus` in the [WhenContext] plus a
/// physical check for a focused [EditableText] (so server-rendered input
/// fields are protected from day one, before T68 wires real focus into the
/// context). A rule with a `when` follows its expression exactly.
///
/// One command has live machinery here: `nav.back` pops the enclosing
/// [Navigator] when it can (`nav.forward` has no Flutter seam yet). The five
/// composer commands arrive wired by `ComposerCommands` (T68); every other
/// vocabulary id keeps its documented placeholder until T69–T70.
///
/// T116 adds the upstream `navigation.back` / `navigation.forward` commands:
/// when the host supplies [onNavigateBack] / [onNavigateForward] they drive
/// the SDUI runtime's product nav stack (the `back` directive's stack);
/// otherwise `navigation.back` falls back to the enclosing [Navigator] and
/// `navigation.forward` is a documented no-op.
class CommandShortcuts extends StatefulWidget {
  const CommandShortcuts({
    super.key,
    required this.registry,
    required this.whenContext,
    required this.keymap,
    required this.child,
    this.onNavigateBack,
    this.onNavigateForward,
  });

  /// The command registry chords dispatch through.
  final CommandRegistry registry;

  /// The boolean command contexts `when` expressions are evaluated against.
  final WhenContext whenContext;

  /// The resolved (server defaults + user overrides) keymap.
  final Keymap keymap;

  /// The subtree chords are enabled for.
  final Widget child;

  /// The product nav-stack back seam (T116); absent → the enclosing
  /// [Navigator] is popped instead.
  final Future<void> Function()? onNavigateBack;

  /// The product nav-stack forward seam (T116); absent → a no-op.
  final Future<void> Function()? onNavigateForward;

  @override
  State<CommandShortcuts> createState() => _CommandShortcutsState();
}

class _CommandShortcutsState extends State<CommandShortcuts> {
  @override
  void initState() {
    super.initState();
    widget.registry.register('nav.back', handler: _navBack);
    widget.registry.register('navigation.back', handler: _navigationBack);
    widget.registry.register('navigation.forward', handler: _navigationForward);
  }

  /// Live machinery: Flutter's navigator can pop. Dispatched as a no-op
  /// when nothing can be popped (the command still reports handled).
  bool _navBack() {
    if (!mounted) return true;
    final navigator = Navigator.maybeOf(context);
    if (navigator != null && navigator.canPop()) navigator.pop();
    return true;
  }

  /// `navigation.back` (T116): the product nav stack when the host wired it,
  /// the enclosing [Navigator] otherwise.
  bool _navigationBack() {
    final back = widget.onNavigateBack;
    if (back != null) {
      unawaited(back());
      return true;
    }
    return _navBack();
  }

  /// `navigation.forward` (T116): the product nav stack when the host wired
  /// it, a documented no-op otherwise (Flutter's [Navigator] has no forward
  /// seam).
  bool _navigationForward() {
    final forward = widget.onNavigateForward;
    if (forward != null) {
      unawaited(forward());
    }
    return true;
  }

  /// Whether text is being entered: the WhenContext's text contexts plus a
  /// physical check for a focused editable.
  bool _textEntryActive() {
    if (widget.whenContext.composerFocus || widget.whenContext.editableFocus) {
      return true;
    }
    final focus = FocusManager.instance.primaryFocus?.context;
    if (focus == null) return false;
    // EditableText attaches its focus node inside its own subtree, so the
    // editable is an ancestor of the focus attachment.
    if (focus.findAncestorWidgetOfExactType<EditableText>() != null) return true;
    return focus is Element && _hasEditableBelow(focus, 0);
  }

  static bool _hasEditableBelow(Element element, int depth) {
    if (depth > 32) return false;
    if (element.widget is EditableText) return true;
    var found = false;
    element.visitChildElements((child) {
      if (!found && _hasEditableBelow(child, depth + 1)) found = true;
    });
    return found;
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    final chord = KeyChord.fromKeyEvent(event);
    if (chord == null) return KeyEventResult.ignored;
    final command = widget.keymap.commandFor(
      chord,
      widget.whenContext,
      textEntryActive: _textEntryActive(),
    );
    if (command == null) return KeyEventResult.ignored;
    // Handled/declined (T68): a declining handler must not swallow the key —
    // e.g. the recall commands refuse on a non-empty composer so the arrow
    // key still moves the caret.
    final handled = widget.registry.dispatch(command);
    return handled ? KeyEventResult.handled : KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    return Focus(
      autofocus: true,
      skipTraversal: true,
      onKeyEvent: _onKey,
      child: widget.child,
    );
  }
}
