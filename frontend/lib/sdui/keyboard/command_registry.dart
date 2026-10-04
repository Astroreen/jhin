import 'package:flutter/foundation.dart';

/// A keyboard command handler: the machinery behind one command id.
///
/// Reports handled/declined (T68): `true` handled the key press, `false`
/// DECLINED it. A declined command must not consume the key — the hub lets
/// it fall through so, for example, caret movement still works when the
/// recall commands refuse to walk the history.
typedef CommandHandler = bool Function();

/// A predicate consulted before a handler runs.
typedef CommandPredicate = bool Function();

/// One registered command: an id, its handler and its two gating predicates.
///
/// [enabled] answers "may this command run at all" (feature availability);
/// [when] answers "is this command relevant right now" (context). Both are
/// consulted by [CommandRegistry.dispatch]; an absent predicate passes.
class CommandRegistration {
  const CommandRegistration({
    required this.id,
    required this.handler,
    this.enabled,
    this.when,
    this.placeholder = false,
  });

  /// Unique command id, for example `composer.send`.
  final String id;

  /// The handler invoked on dispatch.
  final CommandHandler handler;

  /// When present and false, the handler is not called.
  final CommandPredicate? enabled;

  /// When present and false, the handler is not called.
  final CommandPredicate? when;

  /// Whether this is the day-one inert placeholder of the vocabulary (a
  /// real registration replaces it; another real registration keeps it).
  final bool placeholder;

  /// Whether [enabled] currently allows the handler to run.
  bool get isEnabled => enabled == null || enabled!();

  /// Whether [when] currently considers the command relevant.
  bool get isRelevant => when == null || when!();
}

/// Dispatchable command vocabulary (T67): maps command ids to handlers and
/// dispatches keymap commands to them.
///
/// The full vocabulary is registered from the first day — including the
/// commands whose machinery lands in later tasks (T68–T70), which ship as
/// documented no-op placeholders — so every keymap entry resolves and
/// dispatches without ever throwing. Unknown ids are silent no-ops as well.
class CommandRegistry {
  /// Creates a registry with the full [vocabularyIds] registered.
  CommandRegistry() {
    registerVocabulary();
  }

  /// The fixed command vocabulary (ids exactly as docs/sdui.md §1 and the
  /// default keymap use them).
  static const List<String> vocabularyIds = <String>[
    'composer.send',
    'composer.sendAndNew',
    'composer.newline',
    'composer.recallPrev',
    'composer.recallNext',
    'thread.next',
    'thread.prev',
    'thread.jump1',
    'thread.jump2',
    'thread.jump3',
    'thread.jump4',
    'thread.jump5',
    'thread.jump6',
    'thread.jump7',
    'thread.jump8',
    'thread.jump9',
    'thread.undo',
    'thread.settle',
    'thread.pin',
    'thread.new',
    'palette.open',
    'nav.back',
    'nav.forward',
    'appearance.cycle',
    'theme.pick',
  ];

  final Map<String, CommandRegistration> _commands = <String, CommandRegistration>{};

  /// Registers (or re-registers) one command. A real registration always
  /// replaces whatever was there before (including a placeholder).
  void register(
    String id, {
    required CommandHandler handler,
    CommandPredicate? enabled,
    CommandPredicate? when,
  }) {
    _commands[id] = CommandRegistration(
      id: id,
      handler: handler,
      enabled: enabled,
      when: when,
    );
  }

  /// Registers [handler] for [id] only while no real registration exists —
  /// the vocabulary's inert placeholder is replaced, a handler registered by
  /// the embedder is kept (T68: the composer machinery installs itself
  /// without clobbering spy handlers of tests or embedders).
  void registerIfPlaceholder(
    String id, {
    required CommandHandler handler,
    CommandPredicate? enabled,
    CommandPredicate? when,
  }) {
    final existing = _commands[id];
    if (existing != null && !existing.placeholder) return;
    register(id, handler: handler, enabled: enabled, when: when);
  }

  /// Fills every missing [vocabularyIds] entry with a documented placeholder
  /// handler. Handlers registered earlier are kept.
  void registerVocabulary() {
    for (final id in vocabularyIds) {
      _commands.putIfAbsent(
        id,
        () => CommandRegistration(
          id: id,
          handler: _unbound(id),
          placeholder: true,
        ),
      );
    }
  }

  /// Placeholder handler for a command whose machinery lands in T68–T70
  /// (composer and thread commands, the palette, appearance/theme cycling,
  /// persisted keybinding overrides). Dispatchable no-op so the day-one
  /// vocabulary is complete and inert. Reports handled (the keymap rule
  /// resolved and dispatched) without doing anything.
  static CommandHandler _unbound(String id) {
    return () => true;
  }

  /// Whether [id] has a registration.
  bool isRegistered(String id) => _commands.containsKey(id);

  /// Every registered id, in registration order.
  List<String> get ids => List<String>.unmodifiable(_commands.keys);

  /// Dispatches one command and reports its verdict: `true` when a handler
  /// ran and handled the key press, `false` when the command was unknown,
  /// disabled, not relevant, declined or failing. Never throws: failing
  /// handlers are absorbed and reported as declined.
  bool dispatch(String commandId) {
    try {
      final registration = _commands[commandId];
      if (registration == null) return false;
      if (!registration.isEnabled || !registration.isRelevant) return false;
      return registration.handler();
    } catch (error) {
      debugPrint('Jhin keyboard: command "$commandId" failed: $error');
      return false;
    }
  }
}
