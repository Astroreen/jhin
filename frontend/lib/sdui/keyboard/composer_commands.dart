import 'dart:async';

import 'package:flutter/widgets.dart' hide ActionDispatcher;

import '../../core/auth/app_storage.dart';
import '../../store/versioned_store.dart';
import '../action_dispatcher.dart';
import '../render_context.dart';
import '../ui_state.dart';
import 'command_registry.dart';
import 'when_context.dart';

/// The reserved id of the composer field (T68): the `input`/`textarea` node
/// the `send` action includes and the composer commands operate on.
const String kComposerFieldId = 'messageInput';

/// The live composer text field the composer commands operate on (T68).
///
/// Attached by the `input` / `textarea` primitive carrying
/// [kComposerFieldId] through [ComposerScope], detached on dispose. Every
/// mutation goes through the field's own [RenderContext] so the screen's
/// `UiState` and the rendered decoration stay in step.
class ComposerField {
  ComposerField({
    required this.id,
    required this.controller,
    required this.focusNode,
    required this.state,
    required this.invalidate,
    required this.ctx,
  });

  /// The composer node id (the reserved [kComposerFieldId]).
  final String id;

  /// The text field's controller — the caret source for newline and recall.
  final TextEditingController controller;

  /// The text field's focus node (the `composerFocus` context source).
  final FocusNode focusNode;

  /// Per-screen local state (§8.7) the draft and the inline error live in.
  final UiState state;

  /// Rebuilds the field so a [showError] becomes visible.
  final VoidCallback invalidate;

  /// The render context of the screen — state writes, directives, navigation
  /// and the screen root for action lookup.
  final RenderContext ctx;

  /// The current draft.
  String get text => controller.text;

  /// Replaces the draft and places the caret at its end.
  set text(String value) {
    controller.value = TextEditingValue(
      text: value,
      selection: TextSelection.collapsed(offset: value.length),
    );
    ctx.setState(id, value);
  }

  /// The caret/selection of the draft.
  TextSelection get selection => controller.selection;

  /// Whether the field currently owns the keyboard.
  bool get isFocused => focusNode.hasFocus;

  /// Whether the caret sits on the first line of the draft.
  bool get caretOnFirstLine {
    final offset = _caretOffset();
    return !text.substring(0, offset).contains('\n');
  }

  /// Whether the caret sits on the last line of the draft.
  bool get caretOnLastLine {
    final offset = _caretOffset();
    return !text.substring(offset).contains('\n');
  }

  int _caretOffset() {
    final selection = controller.selection;
    if (!selection.isValid) return text.length;
    return selection.baseOffset.clamp(0, text.length).toInt();
  }

  /// Inserts a newline at the caret and moves the caret past it. Never
  /// submits anything.
  void insertNewline() {
    final start = _caretOffset();
    final selection = controller.selection;
    final end =
        selection.isValid ? selection.end.clamp(0, text.length).toInt() : start;
    final updated = text.replaceRange(start, end, '\n');
    controller.value = TextEditingValue(
      text: updated,
      selection: TextSelection.collapsed(offset: start + 1),
    );
    ctx.setState(id, updated);
  }

  /// Clears the draft and its inline error.
  void clear() {
    controller.value = const TextEditingValue(
      text: '',
      selection: TextSelection.collapsed(offset: 0),
    );
    ctx.setState(id, '');
    showError(null);
  }

  /// Shows (or clears, when [message] is null) the inline error text of the
  /// composer node.
  void showError(String? message) {
    state.setError(id, message);
    invalidate();
  }

  /// The screen's action descriptor named [name] (§3), or null — the
  /// composer keyboard flow dispatches the very action of the matching
  /// button (the `send` action of the Send button).
  Map<String, dynamic>? findAction(String name) {
    final root = ctx.root;
    if (root == null) return null;
    for (final node in root().flatten()) {
      for (final value in node.props.values) {
        if (value is! Map) continue;
        final map = Map<String, dynamic>.from(value);
        if (map['name'] != name) continue;
        final path = map['path'];
        if (path is! String || path.isEmpty) continue;
        return map;
      }
    }
    return null;
  }
}

/// The attach point of the composer field plus the focus/draft command
/// contexts its keymap `when` expressions read (T68).
class ComposerBinding {
  ComposerBinding({required this.whenContext});

  /// The `when` contexts kept in step with the attached field.
  final WhenContext whenContext;

  ComposerField? _active;

  /// The attached composer field, if any.
  ComposerField? get active => _active;

  /// Attaches [field] as the composer (any previous one is detached).
  void attach(ComposerField field) {
    detach();
    _active = field;
    field.focusNode.addListener(_focusChanged);
    field.controller.addListener(_draftChanged);
    _focusChanged();
    _draftChanged();
  }

  /// Detaches [field] (or the current one when omitted) and clears the
  /// composer contexts.
  void detach([ComposerField? field]) {
    if (field != null && !identical(field, _active)) return;
    final current = _active;
    if (current == null) return;
    current.focusNode.removeListener(_focusChanged);
    current.controller.removeListener(_draftChanged);
    _active = null;
    whenContext.composerFocus = false;
    whenContext.composerDraft = false;
  }

  void _focusChanged() {
    whenContext.composerFocus = _active?.isFocused ?? false;
  }

  void _draftChanged() {
    whenContext.composerDraft = _active?.text.isNotEmpty ?? false;
  }
}

/// Inherited access to the [ComposerBinding] (T68): installed by the boot
/// host around the rendered screen tree and looked up by the field primitive
/// carrying the reserved composer id.
class ComposerScope extends InheritedWidget {
  const ComposerScope({
    super.key,
    required this.binding,
    required super.child,
  });

  /// The composer attach point of this subtree.
  final ComposerBinding binding;

  /// The scope of [context], or null outside a [ComposerScope].
  static ComposerScope? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<ComposerScope>();

  @override
  bool updateShouldNotify(ComposerScope oldWidget) =>
      !identical(binding, oldWidget.binding);
}

/// The per-profile sent-prompt history behind the composer recall commands
/// (T68): kept in memory for the walk and persisted enveloped at the current
/// schema (docs/updates.md §1) under `composer.history:<profileId>`.
class ComposerHistory {
  ComposerHistory({
    required this.storage,
    required this.profileId,
    this.maxEntries = 50,
  });

  /// Versioned store the history is persisted into.
  final AppStorage storage;

  /// Profile the history belongs to (per-profile isolation).
  final String profileId;

  /// Upper bound of kept entries (oldest dropped first).
  final int maxEntries;

  final List<String> _entries = <String>[];
  bool _loaded = false;

  /// The persisted key (schema-3 envelope).
  String get key => StoreKeys.composerHistory(profileId);

  /// The history, oldest first.
  List<String> get entries => List<String>.unmodifiable(_entries);

  /// Loads the persisted history once and answers it. Never throws — an
  /// unreadable history degrades to empty.
  Future<List<String>> load() async {
    if (_loaded) return entries;
    _loaded = true;
    try {
      final data = await storage.readData(key);
      if (data is Map && data['entries'] is List) {
        for (final item in data['entries'] as List) {
          if (item is String && item.isNotEmpty) _entries.add(item);
        }
      }
    } catch (_) {
      // A unreadable history degrades to empty — never throws.
    }
    return entries;
  }

  /// Appends one successfully sent prompt (no consecutive duplicates) and
  /// persists the history.
  Future<void> add(String entry) async {
    if (entry.trim().isEmpty) return;
    await load();
    if (_entries.isNotEmpty && _entries.last == entry) return;
    _entries.add(entry);
    while (_entries.length > maxEntries) {
      _entries.removeAt(0);
    }
    await storage.writeEnvelope(key, {'entries': entries});
  }
}

/// Posts one action body to `path` — the transport seam of the composer
/// commands; the error of a failed post propagates to the caller.
typedef ComposerPost = Future<Map<String, dynamic>> Function(
    String path, Object body);

/// The composer commands (T68) and their default chords.
///
/// `composer.send` dispatches the screen's `send` action exactly once;
/// `composer.sendAndNew` sends, creates a fresh session and navigates to the
/// `chat:<id>` of the create-session response (the draft's workdir/model
/// carry over); `composer.newline` inserts a newline and never submits;
/// `composer.recallPrev` / `composer.recallNext` walk the per-profile
/// sent-prompt history. T103 adds the upstream chords
/// (`packages/shared/src/keybindings.ts:47-76`, commit 37de6cb):
/// `composer.sendAlternate` is the opposite queue/steer action while a turn
/// runs, and the seven picker chords (`modelPicker.toggle`,
/// `composer.host/effort/mode/workspace/branch/previousWorktree`) open the
/// matching composer picker dialog.
///
/// Dispatch reports handled/declined: the recall commands DECLINE outside
/// the recall gate (non-empty draft, caret off the first/last line) so the
/// arrow key still moves the caret, and every command declines when there is
/// no composer field to act on.
class ComposerCommands {
  ComposerCommands({
    required this.registry,
    required this.binding,
    required this.history,
    required this.post,
  }) {
    registry.registerIfPlaceholder('composer.send', handler: send);
    registry.registerIfPlaceholder('composer.sendAndNew', handler: sendAndNew);
    registry.registerIfPlaceholder('composer.sendAlternate',
        handler: sendAlternate);
    registry.registerIfPlaceholder('composer.newline', handler: newline);
    registry.registerIfPlaceholder('composer.recallPrev', handler: recallPrev);
    registry.registerIfPlaceholder('composer.recallNext', handler: recallNext);
    registry.registerIfPlaceholder('modelPicker.toggle',
        handler: _pickerOpener('composer-model-picker'));
    registry.registerIfPlaceholder(
        'composer.host', handler: _pickerOpener('composer-host-picker'));
    registry.registerIfPlaceholder(
        'composer.effort', handler: _pickerOpener('composer-effort-picker'));
    registry.registerIfPlaceholder(
        'composer.mode', handler: _pickerOpener('composer-mode-picker'));
    registry.registerIfPlaceholder('composer.workspace',
        handler: _pickerOpener('composer-workspace-picker'));
    registry.registerIfPlaceholder(
        'composer.branch', handler: _pickerOpener('composer-branch-picker'));
    registry.registerIfPlaceholder('composer.previousWorktree',
        handler: _pickerOpener('composer-worktree-picker'));
    // T116: the upstream `thread.stop` command (no default chord) dispatches
    // the live run's stop action when one is present.
    registry.registerIfPlaceholder('thread.stop', handler: stop);
    unawaited(history.load());
  }

  /// The UiState id of the decorative follow-up dispatch mode (T103): the
  /// Direct/Queue/Steer split-menu selection the send-alternate command
  /// flips (upstream `followUpBehavior`, ComposerPrimaryActions.tsx:34).
  static const String followUpStateId = 'chat_dispatch';

  /// The composer picker control node ids the picker chords open (T103) —
  /// the buttons the server renders in the composer header row.
  static const List<String> pickerIds = <String>[
    'composer-model-picker',
    'composer-host-picker',
    'composer-effort-picker',
    'composer-mode-picker',
    'composer-workspace-picker',
    'composer-branch-picker',
    'composer-worktree-picker',
  ];

  /// The command registry the handlers are installed on.
  final CommandRegistry registry;

  /// The composer field the commands operate on.
  final ComposerBinding binding;

  /// The per-profile sent-prompt history.
  final ComposerHistory history;

  /// The action post channel (errors propagate).
  final ComposerPost post;

  /// Client fallback chords (T68) plus the T103 upstream chords: applied by
  /// the boot host for commands the server keymap carries no rule for.
  /// `composer.sendAlternate` mirrors the upstream
  /// `mod+enter -> composer.sendAlternate` rule
  /// (packages/shared/src/keybindings.ts:51-52) — it is gated on
  /// `turnRunning`, so the idle `mod+enter` send rule below keeps the T68
  /// semantics and the alternate takes the chord only while a turn runs
  /// (the WhenContext `turnRunning` source is the live-run marker; until a
  /// live source feeds it the rule stays reserved and the send stands).
  /// The picker chords fire anywhere outside another editable (upstream
  /// `when: "!terminalFocus"`; the terminal context does not exist here, so
  /// the same set is expressed over `composerFocus`/`editableFocus`).
  static const List<Object?> defaultKeymapRules = <Object?>[
    {'key': 'mod+enter', 'command': 'composer.send', 'when': 'composerFocus'},
    {
      'key': 'mod+enter',
      'command': 'composer.sendAlternate',
      'when': 'composerFocus && turnRunning',
    },
    {
      'key': 'mod+alt+enter',
      'command': 'composer.sendAndNew',
      'when': 'composerFocus',
    },
    {
      'key': 'shift+enter',
      'command': 'composer.newline',
      'when': 'composerFocus',
    },
    {'key': 'up', 'command': 'composer.recallPrev', 'when': 'composerFocus'},
    {'key': 'down', 'command': 'composer.recallNext', 'when': 'composerFocus'},
    {
      'key': 'mod+shift+m',
      'command': 'modelPicker.toggle',
      'when': 'composerFocus || !editableFocus',
    },
    {
      'key': 'mod+shift+h',
      'command': 'composer.host',
      'when': 'composerFocus || !editableFocus',
    },
    {
      'key': 'mod+shift+e',
      'command': 'composer.effort',
      'when': 'composerFocus || !editableFocus',
    },
    {
      'key': 'mod+shift+a',
      'command': 'composer.mode',
      'when': 'composerFocus || !editableFocus',
    },
    {
      'key': 'mod+shift+x',
      'command': 'composer.workspace',
      'when': 'composerFocus || !editableFocus',
    },
    {
      'key': 'mod+shift+g',
      'command': 'composer.branch',
      'when': 'composerFocus || !editableFocus',
    },
    {
      'key': 'mod+shift+l',
      'command': 'composer.previousWorktree',
      'when': 'composerFocus || !editableFocus',
    },
  ];

  /// The inline error of an empty composer (the node's own `errorText` prop
  /// wins when set).
  static const String emptyMessage = 'Write a message first';

  /// The toast when create-session fails after a successful send — the
  /// draft is kept, never lose user text.
  static const String createFailed =
      'Could not open a new session. Your draft is kept.';

  /// The toast when the `send` post fails.
  static const String sendFailed = 'Could not send the message.';

  int? _cursor;
  String _walkFill = '';

  // -------------------------------------------------------------------------
  // composer.send / composer.sendAndNew
  // -------------------------------------------------------------------------

  /// `composer.send` — dispatches the Send button's `send` action exactly
  /// once. An empty draft dispatches nothing and shows the inline error.
  bool send() {
    final field = binding.active;
    if (field == null) return false;
    if (field.findAction('send') == null) return false;
    if (!_validate(field)) return true;
    unawaited(_sendThenClear(field));
    return true;
  }

  /// `composer.sendAndNew` — sends first, then creates a fresh session and
  /// navigates to its `chat:<id>`. On a failed creation the draft is kept
  /// and a toast explains.
  bool sendAndNew() {
    final field = binding.active;
    if (field == null) return false;
    if (field.findAction('send') == null) return false;
    if (!_validate(field)) return true;
    unawaited(_sendAndNew(field));
    return true;
  }

  /// `composer.sendAlternate` (T103) — the opposite queue/steer action
  /// (upstream `composer.sendAlternate`, ComposerPrimaryActions.tsx:117):
  /// while a turn runs the follow-up dispatch mode flips to its opposite
  /// and a toast names it. The mode is decorative (no queue/steer backend),
  /// so the toast carries the preview wording.
  bool sendAlternate() {
    final field = binding.active;
    if (field == null) return false;
    final current =
        field.state[followUpStateId] is String ? field.state[followUpStateId] as String : 'steer';
    final opposite = current == 'queue' ? 'steer' : 'queue';
    field.ctx.setState(followUpStateId, opposite);
    unawaited(field.ctx.runDirectives(<dynamic>[
      {
        'op': 'toast',
        'text': 'Follow-up: $opposite (preview only)',
      },
    ]));
    return true;
  }

  /// The T103 picker opener: runs the inline dialog directive of the named
  /// composer picker control (the same action its button tap dispatches).
  /// Declines when no composer field hosts the command or the control is
  /// absent — the key falls through, never swallowed.
  CommandHandler _pickerOpener(String nodeId) {
    return () {
      final field = binding.active;
      if (field == null) return false;
      final node = field.ctx.root?.call().findById(nodeId);
      final action = node?.props['action'];
      if (action is! Map || action.isEmpty) return false;
      unawaited(
          field.ctx.runDirectives(<dynamic>[Map<String, dynamic>.from(action)]));
      return true;
    };
  }

  /// `thread.stop` (T116) — dispatches the live run's stop action (the
  /// composer footer's `cancel` button) when a run is live, a no-op
  /// otherwise. The stop button only renders while a run is live, so its
  /// presence in the screen is the run-live signal. Reports handled either
  /// way: the command is a real vocabulary entry, not a fall-through.
  bool stop() {
    final field = binding.active;
    if (field == null) return true;
    final action = field.findAction('cancel');
    if (action == null) return true;
    unawaited(_postAction(field, action));
    return true;
  }

  /// Posts one screen action descriptor (the stop button's `cancel`) and runs
  /// its response directives. Failures are silent — the run state is
  /// server-owned and a failed stop must never crash the key handler.
  Future<void> _postAction(
      ComposerField field, Map<String, dynamic> action) async {
    final path = action['path'];
    if (path is! String || path.isEmpty) return;
    final name = action['name'] is String ? action['name'] as String : 'cancel';
    try {
      final response = await post(path, {
        'action': name,
        'payload': _payload(field, action),
      });
      final client = response['client'];
      if (client is List) await field.ctx.runDirectives(client);
    } catch (_) {
      // Silent no-op: the run lifecycle is server-side.
    }
  }

  Future<void> _sendThenClear(ComposerField field) async {
    if (!await _send(field)) return;
    field.clear();
  }

  Future<void> _sendAndNew(ComposerField field) async {
    final text = field.text;
    if (!await _send(field)) return;
    final target = await _createSession(field, text);
    if (target == null) return; // draft kept + toast shown
    field.clear();
    field.ctx.navigate(target);
  }

  /// Posts the `send` action of the screen; true on a successful post.
  Future<bool> _send(ComposerField field) async {
    final action = field.findAction('send');
    if (action == null) return false;
    final path = action['path'];
    if (path is! String || path.isEmpty) return false;
    final name = action['name'] is String ? action['name'] as String : 'send';
    try {
      final response = await post(path, {
        'action': name,
        'payload': _payload(field, action),
      });
      _cursor = null;
      _walkFill = '';
      await history.add(field.text);
      field.showError(null);
      final client = response['client'];
      if (client is List) await field.ctx.runDirectives(client);
      return true;
    } catch (_) {
      await _toast(field, sendFailed, 'error');
      return false;
    }
  }

  /// Posts `create-session` for the send-and-new flow and answers the
  /// navigation target of its response (the new `chat:<id>`), or null on
  /// failure (a toast has been shown).
  Future<String?> _createSession(ComposerField field, String sentText) async {
    final payload = <String, dynamic>{'title': _titleFor(sentText)};
    final workdir = field.state['workdir'];
    if (workdir is String && workdir.trim().isNotEmpty) {
      payload['workdir'] = workdir;
    }
    final model = field.state['model'];
    if (model is String && model.trim().isNotEmpty) {
      payload['model'] = model;
    }
    try {
      final response = await post('/ui/action/create-session', {
        'action': 'create-session',
        'payload': payload,
      });
      final target = navigateTarget(response);
      if (target == null) {
        await _toast(field, createFailed, 'error');
        return null;
      }
      return target;
    } catch (_) {
      await _toast(field, createFailed, 'error');
      return null;
    }
  }

  /// The navigation target of an action response (§4): the `screen` of its
  /// `navigate` / `replace` directive. The `create-session` response carries
  /// the new `chat:<id>` here for the client to navigate to.
  static String? navigateTarget(Map<String, dynamic> response) {
    final client = response['client'];
    if (client is! List) return null;
    for (final item in client) {
      if (item is! Map) continue;
      final op = item['op'];
      if (op != 'navigate' && op != 'replace') continue;
      final screen = item['screen'];
      if (screen is String && screen.isNotEmpty) return screen;
    }
    return null;
  }

  /// The title of the fresh session of `composer.sendAndNew`: the first
  /// non-empty line of the sent prompt, shortened to 60 characters.
  static String _titleFor(String text) {
    for (final line in text.split('\n')) {
      final trimmed = line.trim();
      if (trimmed.isEmpty) continue;
      return trimmed.length <= 60 ? trimmed : '${trimmed.substring(0, 57)}...';
    }
    return 'New session';
  }

  /// The merged payload of an action dispatch (§8.4): the static `payload`
  /// plus the included ids' current values (include wins on collisions).
  Map<String, dynamic> _payload(
      ComposerField field, Map<String, dynamic> action) {
    final payload = <String, dynamic>{};
    final staticPayload = action['payload'];
    if (staticPayload is Map) {
      payload.addAll(Map<String, dynamic>.from(staticPayload));
    }
    final include = action['include'];
    if (include is List) {
      for (final item in include) {
        if (item is! String) continue;
        final node = field.ctx.root?.call().findById(item);
        final value = ActionDispatcher.includeValue(node, field.state[item]);
        if (value is String ||
            value is num ||
            value is bool ||
            value is Map ||
            value is List) {
          payload[item] = value;
        }
      }
    }
    return payload;
  }

  /// Validates the draft before dispatch (§8.4 semantics plus the empty
  /// composer gate): shows the inline error and answers false when nothing
  /// may be dispatched.
  bool _validate(ComposerField field) {
    final node = field.ctx.root?.call().findById(field.id);
    if (field.text.trim().isEmpty) {
      field.showError(node?.stringProp('errorText') ?? emptyMessage);
      return false;
    }
    final error = ActionDispatcher.validateField(node, field.state[field.id]);
    if (error != null) {
      field.showError(error);
      return false;
    }
    field.showError(null);
    return true;
  }

  Future<void> _toast(ComposerField field, String text, String style) =>
      field.ctx.runDirectives(<dynamic>[
        {'op': 'toast', 'text': text, 'style': style},
      ]);

  // -------------------------------------------------------------------------
  // composer.newline
  // -------------------------------------------------------------------------

  /// `composer.newline` — inserts a newline into the composer and never
  /// submits.
  bool newline() {
    final field = binding.active;
    if (field == null) return false;
    field.insertNewline();
    return true;
  }

  // -------------------------------------------------------------------------
  // composer.recallPrev / composer.recallNext
  // -------------------------------------------------------------------------

  /// `composer.recallPrev` — walks the history to older prompts.
  bool recallPrev() => _recall(-1);

  /// `composer.recallNext` — walks the history to newer prompts.
  bool recallNext() => _recall(1);

  /// The recall walk (T68): enters only on an empty draft with the caret on
  /// the first (older) / last (newer) line; once entered it continues over
  /// the recalled text — the first user edit ends it — and clears past the
  /// newest entry. Everywhere else it DECLINES so the arrow key moves the
  /// caret normally.
  bool _recall(int direction) {
    final field = binding.active;
    if (field == null) return false;
    final entries = history.entries;
    if (_walkActive(field)) {
      final next = _cursor! + direction;
      if (next < 0) return true; // at the oldest entry — stay there
      if (next >= entries.length) {
        _cursor = null;
        _walkFill = '';
        field.clear();
        return true;
      }
      _cursor = next;
      _fill(field, entries[next]);
      return true;
    }
    if (field.text.trim().isNotEmpty) return false;
    if (direction < 0 && !field.caretOnFirstLine) return false;
    if (direction > 0 && !field.caretOnLastLine) return false;
    if (entries.isEmpty) return false;
    if (direction > 0) return false; // nothing to walk forward to yet
    _cursor = entries.length - 1;
    _fill(field, entries[_cursor!]);
    return true;
  }

  /// Whether a recall walk is in progress — the recalled text must still sit
  /// unchanged in the composer; the first user edit ends the walk.
  bool _walkActive(ComposerField field) {
    if (_cursor == null) return false;
    if (field.text != _walkFill) {
      _cursor = null;
      _walkFill = '';
      return false;
    }
    return true;
  }

  void _fill(ComposerField field, String entry) {
    _walkFill = entry;
    field.text = entry;
  }
}
