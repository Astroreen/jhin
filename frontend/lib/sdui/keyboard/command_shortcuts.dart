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
/// [Navigator] when it can (`nav.forward` has no Flutter seam yet). Every
/// other vocabulary id keeps its documented placeholder until T68–T70.
class CommandShortcuts extends StatefulWidget {
  const CommandShortcuts({
    super.key,
    required this.registry,
    required this.whenContext,
    required this.keymap,
    required this.child,
  });

  /// The command registry chords dispatch through.
  final CommandRegistry registry;

  /// The boolean command contexts `when` expressions are evaluated against.
  final WhenContext whenContext;

  /// The resolved (server defaults + user overrides) keymap.
  final Keymap keymap;

  /// The subtree chords are enabled for.
  final Widget child;

  @override
  State<CommandShortcuts> createState() => _CommandShortcutsState();
}

class _CommandShortcutsState extends State<CommandShortcuts> {
  @override
  void initState() {
    super.initState();
    widget.registry.register('nav.back', handler: _navBack);
  }

  /// Live machinery: Flutter's navigator can pop. Dispatched as a no-op
  /// when nothing can be popped.
  void _navBack() {
    if (!mounted) return;
    final navigator = Navigator.maybeOf(context);
    if (navigator != null && navigator.canPop()) navigator.pop();
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
    widget.registry.dispatch(command);
    return KeyEventResult.handled;
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
