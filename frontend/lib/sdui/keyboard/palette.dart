import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/auth/app_storage.dart';
import '../../design/icon_registry.dart';
import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../../store/versioned_store.dart';
import 'command_registry.dart';
import 'when_context.dart';

/// The four command-palette result groups (T115), in render order. Mirrors
/// the server's `KeybindCatalog.PaletteGroup` (the bootstrap `palette` block
/// carries the same wire values) and the upstream palette's grouped results
/// (`CommandPalette.logic.ts:594-610`, commit 37de6cb).
enum PaletteGroup {
  actions('actions', 'Actions'),
  threads('threads', 'Threads'),
  projects('projects', 'Projects'),
  models('models', 'Models');

  const PaletteGroup(this.wire, this.label);

  /// The wire value of the group (bootstrap `palette.groups[].value`).
  final String wire;

  /// The header text; the palette renders it upper-case with a count.
  final String label;

  /// The group of one server search hit: a project navigate target lands in
  /// the Projects group, every other hit in Threads.
  static PaletteGroup forServerKind(String kind, String? navigate) {
    if (kind == 'project' || (navigate != null && navigate.startsWith('project:'))) {
      return PaletteGroup.projects;
    }
    return PaletteGroup.threads;
  }
}

/// One palette row: a local command of the [CommandRegistry], a server search
/// hit of `POST /ui/action/search` (T69) or a decorative demo row (T115).
///
/// A server entry carries the search response's `action` (a §3 action object
/// or a §4 directive like `{"op":"navigate","screen":"chat:<id>"}`) and/or a
/// `navigate` screen id shorthand; the client dispatches whichever arrives.
class PaletteEntry {
  /// A local command row: the command id doubles as the identity; [label] is
  /// the human-readable label and [subtitle] the muted command id (the
  /// `ThreadCommandSubtitle` analogue). [disabled] marks a keymap command the
  /// registry does not know (T115).
  PaletteEntry.command(
    String commandId, {
    String? label,
    String? subtitle,
    this.icon,
    this.shortcut,
    this.disabled = false,
  })  : id = commandId,
        label = label ?? commandId,
        kind = 'command',
        group = PaletteGroup.actions,
        commandId = commandId,
        action = null,
        navigate = null,
        subtitle = subtitle ?? commandId,
        demo = false;

  /// A server search hit.
  PaletteEntry.server({
    required this.id,
    required this.label,
    required this.kind,
    this.group = PaletteGroup.threads,
    this.action,
    this.navigate,
    this.subtitle,
    this.icon,
    this.shortcut,
    this.disabled = false,
  })  : commandId = null,
        demo = false;

  /// A decorative row (T115): rendered, selectable and marked `demo` — its
  /// submit only runs the demo feedback, never a real command (plan §14.10).
  PaletteEntry.demo({
    required this.id,
    required this.label,
    required this.group,
    this.subtitle,
    this.icon,
  })  : kind = 'model',
        commandId = null,
        action = null,
        navigate = null,
        shortcut = null,
        disabled = false,
        demo = true;

  /// Stable identity of the row (command id, search hit id or model id).
  final String id;

  /// Display text: the human-readable label.
  final String label;

  /// `command` for local rows; the search response's `kind` (`session`,
  /// `user_message`, `message_end`, …) for server hits; `model` for demos.
  final String kind;

  /// The palette group this row renders under.
  final PaletteGroup group;

  /// The command id for local rows; null for server hits and demos.
  final String? commandId;

  /// The server hit's action object (§3 action or §4 directive).
  final Map<String, dynamic>? action;

  /// The server hit's navigation target shorthand (`chat:<id>`).
  final String? navigate;

  /// The muted subtitle (the command id for actions, the hit kind for
  /// threads, the model marker for demos).
  final String? subtitle;

  /// The icon-registry name of the row icon; the group icon is used when null.
  final String? icon;

  /// The effective chord label of the right-aligned `kbd` hint, when bound.
  final String? shortcut;

  /// Whether the row is a disabled affordance the keyboard skips.
  final bool disabled;

  /// Whether the row is decorative (T115): its submit runs the demo feedback.
  final bool demo;
}

/// One rendered group: its [group] and the matching [entries].
class PaletteGroupView {
  const PaletteGroupView(this.group, this.entries);

  /// The group identity.
  final PaletteGroup group;

  /// The matching rows, in render order.
  final List<PaletteEntry> entries;
}

/// The human-readable label of one command id: the port of the upstream
/// `commandLabel` (`KeybindingsSettings.logic.ts:314-340`, commit 37de6cb) —
/// the six special-case names verbatim plus the `Segment: Segment`
/// title-casing of the dotted id.
String humanizeCommand(String command) {
  const special = <String, String>{
    'composer.sendAlternate': 'Composer: Opposite Queue or Steer Action',
    'composer.sendBackground': 'Composer: Start in Background',
    'composer.sendAndNewThread': 'Composer: Send and Start New Thread',
    'thread.steerQueuedMessage': 'Queue: Send First Queued Message as Steer',
    'thread.editQueuedMessage': 'Queue: Edit Last Queued Message',
    'thread.copyReference': 'Pull Request: Copy Link or Thread ID',
  };
  final override = special[command];
  if (override != null) return override;
  return command.split('.').map(_titleCaseSegment).join(': ');
}

String _titleCaseSegment(String segment) {
  final spaced = segment.replaceAllMapped(
    RegExp(r'([a-z0-9])([A-Z])'),
    (match) => '${match.group(1)} ${match.group(2)}',
  );
  final parts = spaced.split(RegExp(r'[-_\s]+')).where((part) => part.isNotEmpty);
  return parts
      .map((part) => part[0].toUpperCase() + part.substring(1))
      .join(' ');
}

/// Fetches the server rows of one palette query.
typedef PaletteSearch = Future<List<PaletteEntry>> Function(String query);

/// Dispatches one server row (its action or navigate target).
typedef PaletteDispatchServer = Future<void> Function(PaletteEntry entry);

/// Posts one JSON body — the transport seam of the T69 commands.
typedef PalettePost = Future<Map<String, dynamic>> Function(
    String path, Object body);

/// Fetches one JSON list — the session-list seam of `thread.jump1..9`.
typedef PaletteGetList = Future<List<dynamic>> Function(String path);

/// Resolves the effective chord label of one command id (T115) — the
/// right-aligned `kbd` hint. Null when the command has no binding.
typedef PaletteShortcut = String? Function(String commandId);

/// The command-palette model (T69, extended by T115): open/close, the query,
/// the grouped filtered rows (Actions / Threads / Projects / Models) plus the
/// debounced server search, and the selection.
///
/// Search policy: a `>`-prefixed query filters to the Actions group only (the
/// upstream behaviour, `CommandPalette.logic.ts:449-463`) and never touches
/// the network; otherwise queries shorter than two characters list only the
/// local commands and never touch the network, and from two characters the
/// query is posted to `POST /ui/action/search` after [debounce]. Matching is
/// token-substring over the label and subtitle. Arrow navigation clamps at
/// both ends and skips group headers; [submit] dispatches the selected entry
/// exactly once and closes the palette.
class PaletteController extends ChangeNotifier {
  PaletteController({
    required this.registry,
    required this.search,
    required this.onDispatchLocal,
    required this.onDispatchServer,
    this.whenContext,
    this.shortcutFor,
    this.keymapCommandIds,
    this.onDispatchDemo,
    this.debounce = const Duration(milliseconds: 250),
  });

  /// The registry the local rows are listed and dispatched from.
  final CommandRegistry registry;

  /// The server search channel.
  final PaletteSearch search;

  /// Dispatches a local command id through the registry.
  final bool Function(String commandId) onDispatchLocal;

  /// Dispatches a server row.
  final PaletteDispatchServer onDispatchServer;

  /// The `paletteOpen` context toggled while the palette is open.
  final WhenContext? whenContext;

  /// Resolves the effective chord label of a command (the `kbd` hint).
  final PaletteShortcut? shortcutFor;

  /// The command ids the live keymap binds; ids the registry does not know
  /// are listed as disabled rows and logged once (T115).
  final List<String> Function()? keymapCommandIds;

  /// Runs the demo feedback of a decorative row (T115); absent is a no-op.
  final Future<void> Function(PaletteEntry entry)? onDispatchDemo;

  /// Debounce of the server search.
  final Duration debounce;

  bool _open = false;
  String _query = '';
  List<PaletteEntry> _serverResults = const [];
  int _selectedIndex = 0;
  Timer? _timer;
  int _searchToken = 0;
  final Set<String> _loggedUnregistered = <String>{};

  /// The decorative Models rows (T115): present in the palette, marked
  /// `demo` so selecting one only runs the demo feedback.
  static final List<PaletteEntry> demoEntries = List<PaletteEntry>.unmodifiable(<PaletteEntry>[
    PaletteEntry.demo(
        id: 'model:sonnet',
        label: 'Claude Sonnet',
        group: PaletteGroup.models,
        subtitle: 'model',
        icon: 'smart_toy'),
    PaletteEntry.demo(
        id: 'model:gpt',
        label: 'GPT-5',
        group: PaletteGroup.models,
        subtitle: 'model',
        icon: 'smart_toy'),
    PaletteEntry.demo(
        id: 'model:gemini',
        label: 'Gemini Pro',
        group: PaletteGroup.models,
        subtitle: 'model',
        icon: 'smart_toy'),
  ]);

  /// Whether the overlay is showing.
  bool get isOpen => _open;

  /// The current query text.
  String get query => _query;

  /// Whether the query is in the upstream `>`-action-filter mode.
  bool get actionsOnly => _query.startsWith('>');

  /// The query with the `>` action prefix stripped.
  String get effectiveQuery => actionsOnly ? _query.substring(1) : _query;

  /// The selected row index (clamped into [entries]).
  int get selectedIndex => _selectedIndex;

  /// The grouped visible rows (T115): Actions / Threads / Projects / Models,
  /// each non-empty group carrying its header and count. In `>` mode only the
  /// Actions group survives.
  List<PaletteGroupView> get groups {
    final needle = effectiveQuery.trim().toLowerCase();
    final result = <PaletteGroupView>[];

    final actions = <PaletteEntry>[];
    for (final id in registry.ids) {
      final entry = PaletteEntry.command(
        id,
        label: humanizeCommand(id),
        subtitle: id,
        shortcut: shortcutFor?.call(id),
      );
      if (_matches(entry, needle)) actions.add(entry);
    }
    final known = registry.ids.toSet();
    for (final id in keymapCommandIds?.call() ?? const <String>[]) {
      if (!known.add(id)) continue;
      if (_loggedUnregistered.add(id)) {
        debugPrint(
            'Jhin palette: unregistered command "$id" in the keymap — rendered disabled');
      }
      final entry = PaletteEntry.command(
        id,
        label: humanizeCommand(id),
        subtitle: id,
        disabled: true,
      );
      if (_matches(entry, needle)) actions.add(entry);
    }
    if (actions.isNotEmpty) {
      result.add(PaletteGroupView(PaletteGroup.actions, actions));
    }
    if (actionsOnly) return result;

    final threads = <PaletteEntry>[];
    final projects = <PaletteEntry>[];
    for (final entry in _serverResults) {
      if (entry.group == PaletteGroup.projects) {
        projects.add(entry);
      } else {
        threads.add(entry);
      }
    }
    if (threads.isNotEmpty) {
      result.add(PaletteGroupView(PaletteGroup.threads, threads));
    }
    if (projects.isNotEmpty) {
      result.add(PaletteGroupView(PaletteGroup.projects, projects));
    }
    final models =
        demoEntries.where((entry) => _matches(entry, needle)).toList();
    if (models.isNotEmpty) {
      result.add(PaletteGroupView(PaletteGroup.models, models));
    }
    return result;
  }

  /// The visible rows flattened across [groups], in render order.
  List<PaletteEntry> get entries =>
      <PaletteEntry>[for (final group in groups) ...group.entries];

  /// Whether [entry] matches the [needle]: every whitespace-separated token
  /// is a substring of the label + subtitle + kind (the upstream token rule,
  /// `CommandPalette.logic.ts:493-505`). An empty needle matches everything.
  bool _matches(PaletteEntry entry, String needle) {
    if (needle.isEmpty) return true;
    final haystack =
        '${entry.label} ${entry.subtitle ?? ''} ${entry.kind}'.toLowerCase();
    for (final token in needle.split(RegExp(r'\s+'))) {
      if (token.isEmpty) continue;
      if (!haystack.contains(token)) return false;
    }
    return true;
  }

  /// Opens the palette with an empty query and the `paletteOpen` context set.
  void open() {
    if (_open) return;
    _open = true;
    _query = '';
    _serverResults = const [];
    _selectedIndex = 0;
    whenContext?.paletteOpen = true;
    notifyListeners();
  }

  /// Closes the palette, cancels any pending search and clears the context.
  void close() {
    if (!_open) return;
    _open = false;
    _timer?.cancel();
    _timer = null;
    whenContext?.paletteOpen = false;
    notifyListeners();
  }

  /// Applies a query change: refilters the groups immediately and debounces
  /// the server search (skipped entirely in `>` mode and below two
  /// characters).
  void setQuery(String value) {
    _query = value;
    _selectedIndex = 0;
    _timer?.cancel();
    _timer = null;
    final trimmed = effectiveQuery.trim();
    if (actionsOnly || trimmed.length < 2) {
      _serverResults = const [];
      notifyListeners();
      return;
    }
    _timer = Timer(debounce, () => unawaited(_runSearch(trimmed)));
    notifyListeners();
  }

  Future<void> _runSearch(String query) async {
    final token = ++_searchToken;
    try {
      final results = await search(query);
      if (token != _searchToken || !_open) return;
      _serverResults = results;
      notifyListeners();
    } catch (_) {
      // A failed search degrades to the local commands — never throws.
    }
  }

  /// Moves the selection one row up, clamping at the first row.
  void moveUp() {
    final count = entries.length;
    if (count == 0) return;
    _selectedIndex = (_selectedIndex - 1).clamp(0, count - 1);
    notifyListeners();
  }

  /// Moves the selection one row down, clamping at the last row.
  void moveDown() {
    final count = entries.length;
    if (count == 0) return;
    _selectedIndex = (_selectedIndex + 1).clamp(0, count - 1);
    notifyListeners();
  }

  /// Dispatches the selected (or [index]-ed) entry exactly once and closes
  /// the palette. Local rows go through the registry, server rows through
  /// their action/navigate, demo rows through [onDispatchDemo]; a disabled
  /// row is inert.
  Future<void> submit([int? index]) async {
    final list = entries;
    if (list.isEmpty) return;
    final picked = (index ?? _selectedIndex).clamp(0, list.length - 1);
    final entry = list[picked];
    if (entry.disabled) return;
    close();
    if (entry.demo) {
      await onDispatchDemo?.call(entry);
    } else if (entry.commandId != null) {
      onDispatchLocal(entry.commandId!);
    } else {
      await onDispatchServer(entry);
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}

/// The command-palette overlay (T69, chrome T115): client-owned chrome,
/// hosted by the boot shell exactly like the Change-server button — never
/// server-driven.
///
/// The host builds it only while [PaletteController.isOpen] is true, so every
/// open starts with a fresh query field. Keys: ArrowUp/ArrowDown move the
/// selection (clamping, skipping group headers), Enter dispatches, Escape
/// closes. The chrome is the `dialog`-glass surface (T89/T115): the
/// `commandShell` 0.5rem outer inset, the `commandContent` 1rem content inset
/// and the `JhinDialogGlassRecipe` panel over the dialog backdrop scrim.
class CommandPalette extends StatefulWidget {
  const CommandPalette({super.key, required this.controller});

  /// The palette model this overlay renders and drives.
  final PaletteController controller;

  @override
  State<CommandPalette> createState() => _CommandPaletteState();
}

class _CommandPaletteState extends State<CommandPalette> {
  final TextEditingController _query = TextEditingController();

  /// The query field's focus node: its `onKeyEvent` sees every key first
  /// while the field is focused, so the palette's arrows/Enter/Escape never
  /// race the text editing or the host keymap hub.
  late final FocusNode _focus = FocusNode(onKeyEvent: _onKey);

  @override
  void initState() {
    super.initState();
    _query.text = widget.controller.query;
    // The host keymap hub already holds focus, so `autofocus` alone would
    // not move it — request the field explicitly once the overlay is up.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focus.requestFocus();
    });
  }

  @override
  void dispose() {
    _focus.dispose();
    _query.dispose();
    super.dispose();
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    final key = event.logicalKey;
    if (key == LogicalKeyboardKey.arrowUp) {
      widget.controller.moveUp();
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.arrowDown) {
      widget.controller.moveDown();
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.enter ||
        key == LogicalKeyboardKey.numpadEnter) {
      unawaited(widget.controller.submit());
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.escape) {
      widget.controller.close();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  IconData _groupIcon(PaletteGroup group) {
    final name = switch (group) {
      PaletteGroup.actions => 'bolt',
      PaletteGroup.threads => 'chat_bubble_outline',
      PaletteGroup.projects => 'folder',
      PaletteGroup.models => 'smart_toy',
    };
    return kIconRegistry[name] ?? kIconRegistry['circle']!;
  }

  IconData _entryIcon(PaletteEntry entry) =>
      (entry.icon != null ? kIconRegistry[entry.icon] : null) ??
      _groupIcon(entry.group);

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    final design = JhinDesignScope.of(context);
    final surface = design.tokens.surface;
    final brightness = Theme.brightnessOf(context);
    final scheme = JhinDesignScope.materialOf(context).colorScheme;
    final remPx = design.switches.fontSizes.sizeInterface.toDouble();
    final shellInset =
        parseCssLength(design.resolve('space', 'commandShell'), remPx: remPx) ??
            8;
    final contentInset = parseCssLength(
            design.resolve('space', 'commandContent'),
            remPx: remPx) ??
        16;
    final background = design.colorOf('background', brightness: brightness) ??
        scheme.surface;
    final foreground = design.colorOf('foreground', brightness: brightness) ??
        scheme.onSurface;
    final recipe = JhinDialogGlassRecipe.of(
      surface,
      brightness,
      background: background,
      foreground: foreground,
    );
    final muted =
        design.colorOf('muted-foreground', brightness: brightness) ??
            scheme.onSurfaceVariant;
    final border = design.colorOf('border', brightness: brightness) ??
        scheme.outline;

    final rows = <Widget>[];
    final groups = controller.groups;
    var entryIndex = 0;
    for (final group in groups) {
      rows.add(_groupHeader(context, group, muted));
      for (final entry in group.entries) {
        final index = entryIndex;
        rows.add(_entryRow(
          context,
          entry,
          index: index,
          selected: index == controller.selectedIndex,
          muted: muted,
          border: border,
        ));
        entryIndex++;
      }
    }

    return Stack(
      children: [
        Positioned.fill(
          child: GestureDetector(
            key: const Key('palette-barrier'),
            onTap: controller.close,
            child: ColoredBox(
              color: JhinDialogGlassRecipe.backdropFill(
                surface,
                brightness,
                background: background,
              ),
            ),
          ),
        ),
        Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520, maxHeight: 460),
            child: KeyedSubtree(
              key: const Key('command-palette'),
              child: jhinGlassSurface(
                context,
                surface: surface,
                fill: recipe.fill,
                borderRadius: jhinSurfaceRadius(surface, 'xl2', remPx: remPx),
                border: Border.all(color: recipe.borderColor),
                shadows: recipe.shadows,
                insetTop: recipe.insetTop,
                child: Material(
                  type: MaterialType.transparency,
                  child: Padding(
                    padding: EdgeInsets.all(shellInset),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Padding(
                          padding: EdgeInsets.fromLTRB(contentInset, shellInset,
                              contentInset, shellInset),
                          child: TextField(
                            key: const Key('palette-input'),
                            controller: _query,
                            focusNode: _focus,
                            decoration: const InputDecoration(
                              hintText:
                                  'Search commands, projects, and threads...',
                              border: OutlineInputBorder(),
                              isDense: true,
                            ),
                            onChanged: controller.setQuery,
                          ),
                        ),
                        Flexible(
                          child: ListView.builder(
                            key: const Key('palette-list'),
                            shrinkWrap: true,
                            padding:
                                EdgeInsets.symmetric(horizontal: shellInset),
                            itemCount: rows.length,
                            itemBuilder: (context, index) => rows[index],
                          ),
                        ),
                        Padding(
                          padding: EdgeInsets.fromLTRB(
                              contentInset, shellInset, contentInset, 0),
                          child: Row(
                            children: [
                              Text('↑↓ Navigate',
                                  style: TextStyle(fontSize: 11, color: muted)),
                              SizedBox(width: shellInset * 2),
                              Text('↵ Select',
                                  style: TextStyle(fontSize: 11, color: muted)),
                              SizedBox(width: shellInset * 2),
                              Text('Esc Close',
                                  style: TextStyle(fontSize: 11, color: muted)),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _groupHeader(BuildContext context, PaletteGroupView group, Color muted) {
    return Padding(
      key: Key('palette-group-${group.group.wire}'),
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 2),
      child: Text(
        '${group.group.label.toUpperCase()} · ${group.entries.length}',
        style: TextStyle(
          fontSize: 11,
          letterSpacing: 0.6,
          fontWeight: FontWeight.w600,
          color: muted,
        ),
      ),
    );
  }

  Widget _entryRow(
    BuildContext context,
    PaletteEntry entry, {
    required int index,
    required bool selected,
    required Color muted,
    required Color border,
  }) {
    return ListTile(
      key: Key('palette-entry-${entry.id}'),
      selected: selected,
      dense: true,
      enabled: !entry.disabled,
      leading: Icon(_entryIcon(entry), size: 18),
      title: Text(
        entry.label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: entry.subtitle == null
          ? null
          : Text(
              entry.subtitle!,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 11, color: muted),
            ),
      trailing: entry.shortcut == null
          ? null
          : Container(
              key: Key('palette-kbd-${entry.id}'),
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(
                border: Border.all(color: border),
                borderRadius: BorderRadius.circular(4),
              ),
              child: Text(entry.shortcut!, style: const TextStyle(fontSize: 11)),
            ),
      onTap: entry.disabled
          ? null
          : () => unawaited(widget.controller.submit(index)),
    );
  }
}

/// Client appearance preferences persisted under [StoreKeys.appearance]
/// (schema-4 envelope, docs/updates.md §1): `themeId` (T85, the selected
/// catalogue theme, default `t3-chat`), `themeMode`
/// (`system|light|dark`), `accent` and the T54 fields (`textSize`,
/// `density`, `panelMotionMs`). Reads merge over the defaults; writes never
/// drop fields a reader does not know.
class AppearancePrefs {
  AppearancePrefs._();

  /// The default theme id (T85): the t3code stock theme. Answers for stores
  /// the 3→4 migration never touched (a fresh install seeds `appearance`
  /// through the 2→3 defaults, which predate the field).
  static const String defaultThemeId = 't3-chat';

  /// The theme-mode cycle of `appearance.cycle`: system → light → dark.
  static const List<String> modes = <String>['system', 'light', 'dark'];

  /// The persisted preferences with the [defaultThemeId] merged in; the
  /// other fields answer empty when absent or unreadable (never throws).
  static Future<Map<String, dynamic>> read(AppStorage storage) async {
    try {
      final data = await storage.readData(StoreKeys.appearance);
      if (data is Map) {
        return <String, dynamic>{
          'themeId': defaultThemeId,
          ...Map<String, dynamic>.from(data),
        };
      }
    } catch (_) {
      // An unreadable appearance degrades to the defaults — never throws.
    }
    return <String, dynamic>{'themeId': defaultThemeId};
  }

  /// Persists [prefs] enveloped at the current schema.
  static Future<void> write(AppStorage storage, Map<String, dynamic> prefs) =>
      storage.writeEnvelope(StoreKeys.appearance, prefs);

  /// The mode after [current] in the [modes] cycle; an unknown current mode
  /// restarts the cycle at `system`.
  static String nextMode(Object? current) {
    final text = current is String ? current : '';
    final index = modes.indexOf(text);
    return modes[(index + 1) % modes.length];
  }
}

/// The T69 command set: `palette.open`, `thread.jump1..9`, `thread.undo`,
/// `appearance.cycle` and `theme.pick`, plus the client fallback chords for
/// commands the server keymap leaves unbound.
///
/// Every handler reports handled and does its work asynchronously; nothing
/// here ever throws. Navigation, toasts and refresh ride through
/// [runDirectives] (the live runtime's directive executor), so the commands
/// stay independent of the screen tree.
class PaletteCommands {
  PaletteCommands({
    required CommandRegistry registry,
    required WhenContext whenContext,
    required this.post,
    required this.getList,
    required this.storage,
    required this.runDirectives,
    required this.onAppearanceChanged,
    this.accentPresets = const <String>[],
    this.shortcutFor,
    this.keymapCommandIds,
    this.onDispatchDemo,
  }) {
    controller = PaletteController(
      registry: registry,
      whenContext: whenContext,
      search: search,
      onDispatchLocal: registry.dispatch,
      onDispatchServer: dispatchServerEntry,
      shortcutFor: shortcutFor,
      keymapCommandIds: keymapCommandIds,
      onDispatchDemo: onDispatchDemo,
    );
    registry.registerIfPlaceholder('palette.open', handler: open);
    for (var i = 1; i <= 9; i++) {
      final position = i;
      registry.registerIfPlaceholder('thread.jump$i',
          handler: () => jump(position));
    }
    registry.registerIfPlaceholder('thread.undo', handler: undo);
    registry.registerIfPlaceholder('appearance.cycle', handler: appearanceCycle);
    registry.registerIfPlaceholder('theme.pick', handler: themePick);
  }

  /// The palette model the overlay renders.
  late final PaletteController controller;

  /// The action post channel (search, undo).
  final PalettePost post;

  /// The session-list channel (`GET /sessions`, server order).
  final PaletteGetList getList;

  /// Versioned store the appearance preferences persist into.
  final AppStorage storage;

  /// Runs a client-directive list through the live runtime.
  final Future<void> Function(List<dynamic> directives) runDirectives;

  /// Fired after the appearance preferences change so the app shell can
  /// regenerate the theme.
  final VoidCallback onAppearanceChanged;

  /// The accent presets `theme.pick` cycles through — the server theme's
  /// `accent` plus its `colors{}` values, extracted by the boot host.
  final List<String> accentPresets;

  /// Resolves the effective chord label of a command (the `kbd` hint).
  final PaletteShortcut? shortcutFor;

  /// The command ids the live keymap binds (the disabled-row source).
  final List<String> Function()? keymapCommandIds;

  /// Runs the demo feedback of a decorative row.
  final Future<void> Function(PaletteEntry entry)? onDispatchDemo;

  /// The `POST /ui/action/undo` path.
  static const String undoPath = '/ui/action/undo';

  /// The `POST /ui/action/search` path.
  static const String searchPath = '/ui/action/search';

  /// The `GET /sessions` path — the jump list source (the server's session
  /// order; the sidebar itself lands in T76).
  static const String sessionListPath = '/sessions';

  /// The no-window / nothing-to-undo feedback (the doc's wording).
  static const String nothingToUndo = 'Nothing to undo';

  /// The toast when a jump finds no session at the requested position.
  static String noSessionAt(int position) => 'No session at position $position.';

  /// The toast when a server palette entry fails to open.
  static const String openFailed = 'Could not open the result.';

  /// The toast when the session list cannot be fetched.
  static const String jumpFailed = 'Could not open the session.';

  /// The toast of a decorative row (T115): preview only, never a real effect.
  static const String demoUnavailable =
      'Preview only — model switching is not available in this build';

  /// Client fallback chords (T69): one fallback for every T69 command the
  /// server keymap leaves unbound. `mod+k` opens the palette, `mod+1..9`
  /// jump to the first nine sessions, `mod+z` undoes — mirroring the
  /// server's `ctrl+k` / `ctrl+z` defaults of `DefaultKeymap`.
  static const List<Object?> defaultKeymapRules = <Object?>[
    {'key': 'mod+k', 'command': 'palette.open'},
    {'key': 'mod+1', 'command': 'thread.jump1'},
    {'key': 'mod+2', 'command': 'thread.jump2'},
    {'key': 'mod+3', 'command': 'thread.jump3'},
    {'key': 'mod+4', 'command': 'thread.jump4'},
    {'key': 'mod+5', 'command': 'thread.jump5'},
    {'key': 'mod+6', 'command': 'thread.jump6'},
    {'key': 'mod+7', 'command': 'thread.jump7'},
    {'key': 'mod+8', 'command': 'thread.jump8'},
    {'key': 'mod+9', 'command': 'thread.jump9'},
    {'key': 'mod+z', 'command': 'thread.undo'},
  ];

  // -------------------------------------------------------------------------
  // palette.open
  // -------------------------------------------------------------------------

  /// `palette.open` — opens the command palette overlay.
  bool open() {
    controller.open();
    return true;
  }

  // -------------------------------------------------------------------------
  // thread.jump1..9
  // -------------------------------------------------------------------------

  /// `thread.jump<n>` — navigates to the n-th session of the server's
  /// session list (`GET /sessions` order).
  bool jump(int position) {
    unawaited(_jump(position));
    return true;
  }

  Future<void> _jump(int position) async {
    try {
      final list = await getList(sessionListPath);
      if (position > list.length) {
        await runDirectives([toast(noSessionAt(position), 'error')]);
        return;
      }
      final session = list[position - 1];
      final id = session is Map ? session['id'] : null;
      if (id is! String || id.isEmpty) return;
      await runDirectives([
        {'op': 'navigate', 'screen': 'chat:$id'}
      ]);
    } catch (_) {
      await runDirectives([toast(jumpFailed, 'error')]);
    }
  }

  // -------------------------------------------------------------------------
  // thread.undo
  // -------------------------------------------------------------------------

  /// `thread.undo` — posts `POST /ui/action/undo` and runs the response's
  /// `client` directives (the doc's toast + refresh pair). A missing undo
  /// endpoint (T73 lands it) or a nothing-to-undo answer degrades to the
  /// no-window toast — never a crash.
  bool undo() {
    unawaited(_undo());
    return true;
  }

  Future<void> _undo() async {
    try {
      final response = await post(undoPath, {
        'action': 'undo',
        'payload': <String, dynamic>{},
      });
      final client = response['client'];
      if (client is List && client.isNotEmpty) {
        await runDirectives(client);
        return;
      }
    } catch (_) {
      // 404 (no undo machinery yet) and network failures degrade to the
      // no-window toast below.
    }
    await runDirectives([toast(nothingToUndo, 'error')]);
  }

  // -------------------------------------------------------------------------
  // appearance.cycle / theme.pick
  // -------------------------------------------------------------------------

  /// `appearance.cycle` — cycles the theme mode system → light → dark,
  /// persists it under [StoreKeys.appearance] and re-applies the theme.
  bool appearanceCycle() {
    unawaited(_cycleAppearance());
    return true;
  }

  Future<void> _cycleAppearance() async {
    final prefs = await AppearancePrefs.read(storage);
    final next = AppearancePrefs.nextMode(prefs['themeMode']);
    await AppearancePrefs.write(storage, {...prefs, 'themeMode': next});
    onAppearanceChanged();
  }

  /// `theme.pick` — cycles the accent through the server theme's presets
  /// (`theme.accent` plus its `colors{}` values), persists it under
  /// [StoreKeys.appearance] and re-applies the theme. A server without
  /// presets makes this a no-op.
  bool themePick() {
    unawaited(_pickAccent());
    return true;
  }

  Future<void> _pickAccent() async {
    if (accentPresets.isEmpty) return;
    final prefs = await AppearancePrefs.read(storage);
    final current = prefs['accent'];
    var index = current is String ? accentPresets.indexOf(current) : -1;
    // Absent or unknown → the server's default accent (the first preset).
    if (index < 0) index = 0;
    final next = accentPresets[(index + 1) % accentPresets.length];
    await AppearancePrefs.write(storage, {...prefs, 'accent': next});
    onAppearanceChanged();
  }

  // -------------------------------------------------------------------------
  // Search and server-entry dispatch
  // -------------------------------------------------------------------------

  /// The server rows of one query: `POST /ui/action/search` `{query}` parsed
  /// into [PaletteEntry]s. A failed or malformed answer degrades to no
  /// server rows — the local commands stay listed.
  Future<List<PaletteEntry>> search(String query) async {
    try {
      final response = await post(searchPath, {'query': query});
      final results = response['results'];
      if (results is! List) return const [];
      final entries = <PaletteEntry>[];
      for (final item in results) {
        if (item is! Map) continue;
        final entry = _entryFrom(Map<String, dynamic>.from(item));
        if (entry != null) entries.add(entry);
      }
      return entries;
    } catch (_) {
      return const [];
    }
  }

  PaletteEntry? _entryFrom(Map<String, dynamic> map) {
    final id = map['id'];
    if (id is! String || id.isEmpty) return null;
    final title = map['title'];
    final kind = map['kind'];
    final action = map['action'];
    final navigate = map['navigate'];
    final kindText = kind is String && kind.isNotEmpty ? kind : 'server';
    final navigateText =
        navigate is String && navigate.isNotEmpty ? navigate : null;
    return PaletteEntry.server(
      id: id,
      label: title is String && title.isNotEmpty ? title : id,
      kind: kindText,
      group: PaletteGroup.forServerKind(kindText, navigateText),
      subtitle: kindText,
      icon: 'chat_bubble_outline',
      action: action is Map ? Map<String, dynamic>.from(action) : null,
      navigate: navigateText,
    );
  }

  /// Dispatches one server row: a §3 action with a `path` is posted and its
  /// `client` directives run; a directive-only action (or the `navigate`
  /// shorthand) runs directly.
  Future<void> dispatchServerEntry(PaletteEntry entry) async {
    final action = entry.action;
    if (action != null) {
      final path = action['path'];
      if (path is String && path.isNotEmpty) {
        try {
          final name =
              action['name'] is String ? action['name'] as String : '';
          final rawPayload = action['payload'];
          final payload = rawPayload is Map
              ? Map<String, dynamic>.from(rawPayload)
              : <String, dynamic>{};
          final response = await post(path, {'action': name, 'payload': payload});
          final client = response['client'];
          if (client is List) await runDirectives(client);
        } catch (_) {
          await runDirectives([toast(openFailed, 'error')]);
        }
        return;
      }
      final op = action['op'];
      if (op is String && op.isNotEmpty) {
        await runDirectives([action]);
        return;
      }
    }
    final screen = entry.navigate;
    if (screen != null && screen.isNotEmpty) {
      await runDirectives([
        {'op': 'navigate', 'screen': screen}
      ]);
    }
  }

  /// One `toast` directive.
  static Map<String, Object> toast(String text, [String? style]) {
    final directive = <String, Object>{'op': 'toast', 'text': text};
    if (style != null) directive['style'] = style;
    return directive;
  }
}
