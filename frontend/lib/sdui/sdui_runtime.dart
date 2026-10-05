import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart' hide ActionDispatcher;

import '../boot/empty_state.dart';
import '../boot/loading_frame.dart';
import '../boot/screen_renderer.dart';
import '../core/api/jhin_transport.dart';
import '../core/auth/app_storage.dart';
import '../core/tls/tls_trust.dart';
import '../design/theme.dart';
import '../design/tokens.dart';
import 'action_dispatcher.dart';
import 'directives.dart';
import 'keyboard/keymap.dart';
import 'primitives/sheet.dart';
import 'render_context.dart';
import 'ui_node.dart';
import 'ui_registry.dart';
import 'ui_state.dart';

/// The SDUI runtime (§8): node rendering, the screen stack, per-screen local
/// state, action dispatch and client-directive execution.
///
/// Implements the [ScreenRenderer] seam of the bootstrap host (T21) and the
/// [DirectiveHost] of the directive engine (§8.5). Screen nodes are cached
/// per profile (`cachedScreens`, LRU-bounded at 50, §8.7): a cached screen
/// renders immediately and revalidates in the background
/// (stale-while-revalidate); `refresh` and `reloadBootstrap` force network.
class SduiRuntime extends ChangeNotifier
    implements ScreenRenderer, DirectiveHost {
  SduiRuntime({
    required this.transport,
    this.storage,
    this.profile,
    this.createTransport,
    this.onOpenProfiles,
    this.onOpenUrl,
    this.onTheme,
    this.keymapStore,
    UiRegistry? registry,
  }) : registry = registry ?? UiRegistry.standard() {
    final cached = profile?.cachedScreens;
    if (cached != null) {
      cached.forEach((id, node) {
        if (node is Map) _putScreen(id, Map<String, dynamic>.from(node));
      });
    }
  }

  /// Transport bound to the active profile; swapped by `setServerUrl`.
  JhinTransport transport;

  /// Profile storage; without it, cache/token side effects stay in memory.
  final AppStorage? storage;

  /// The active profile (token/url/caches are rewritten on it).
  ServerProfile? profile;

  /// Factory for a transport after `setServerUrl` rewrites the URL.
  final JhinTransport Function(ServerProfile profile)? createTransport;

  /// Opens the client-owned profile surface (`openProfiles`, §8.5).
  final VoidCallback? onOpenProfiles;

  /// Opens external URLs (`openUrl`); default is a no-op debug log.
  final void Function(String url)? onOpenUrl;

  /// Fired whenever a bootstrap payload is ingested, so the app shell can
  /// regenerate its theme from the payload's `theme`/`tokens`/`density`
  /// (§1). May be called during build — the receiver must defer any
  /// setState past the frame.
  final void Function(Map<String, dynamic> payload)? onTheme;

  /// The live user keymap (T70): when set, the `keybind-save` /
  /// `keybind-reset` / `keybind-restore` actions persist through it as a
  /// client-side dispatch side effect (docs/sdui.md §3).
  final KeymapStore? keymapStore;

  /// Primitive registry used for every node (§8.3).
  final UiRegistry registry;

  static const int _cacheLimit = 50;
  static const Set<String> _seedableTypes = {
    'input',
    'checkbox',
    'switch',
    'slider',
    'dropdown',
  };

  /// Screen id to node JSON — inline screens, fetched screens and the
  /// persisted `cachedScreens` cache, LRU-bounded (§8.7).
  final LinkedHashMap<String, Map<String, dynamic>> _screens =
      LinkedHashMap();

  /// In-memory overrides installed by `setScreen` (§8.5).
  final Map<String, Map<String, dynamic>> _overrides = {};

  /// Screens bundled with the bootstrap (§8.2): never lazily fetched —
  /// only `refresh` re-fetches them from `screenEndpoint`.
  final Set<String> _inlineIds = {};

  final List<_ScreenEntry> _stack = [];
  final Set<String> _inflight = {};
  final _ScreenEntry _standalone = _ScreenEntry('');

  late final DirectiveExecutor _executor = DirectiveExecutor(this);

  String? _hostSignature;
  String? _screenEndpoint;
  String _entryId = '';
  Map<String, dynamic>? _fallbacks;
  Widget Function(BuildContext)? _dialogBuilder;
  bool _dialogAtBottom = false;
  bool _dialogGlass = false;
  String? _toastText;
  String? _toastStyle;
  Timer? _toastTimer;
  bool _disposed = false;

  // -------------------------------------------------------------------------
  // ScreenRenderer seam (T21)
  // -------------------------------------------------------------------------

  @override
  Widget buildScreen(BuildContext context, Map<String, dynamic> payload) {
    _ingestBootstrap(payload, fromHost: true);
    return _RuntimeView(this, _buildRoot);
  }

  @override
  Widget buildNode(BuildContext context, Map<String, dynamic> node) {
    // Fallback art (offline/error) is shown until a bootstrap fills the
    // stack; once it does — for example after the Retry button runs
    // `refresh` → `reloadBootstrap` — the live tree takes over.
    return _RuntimeView(
      this,
      (viewContext) => _stack.isEmpty
          ? _buildStandalone(viewContext, node)
          : _buildRoot(viewContext),
    );
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  Widget _buildRoot(BuildContext context) {
    final children = <Widget>[Positioned.fill(child: _buildTop(context))];
    final dialog = _dialogBuilder;
    if (dialog != null) {
      final glassBackdrop = _dialogGlass && JhinGlass.supported;
      children.add(
        Positioned.fill(
          child: Stack(
            children: [
              if (glassBackdrop)
                Positioned.fill(child: _dialogBackdropScrim(context))
              else
                Positioned.fill(
                  child: ModalBarrier(
                    dismissible: true,
                    color: Colors.black45,
                    onDismiss: () => unawaited(dismissDialog()),
                  ),
                ),
              if (glassBackdrop)
                Positioned.fill(
                  child: ModalBarrier(
                    dismissible: true,
                    onDismiss: () => unawaited(dismissDialog()),
                  ),
                ),
              if (_dialogAtBottom)
                Align(
                  alignment: Alignment.bottomCenter,
                  child: _dialogTransition(
                    context,
                    dialog(context),
                    slide: true,
                  ),
                )
              else
                Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: _dialogTransition(context, dialog(context)),
                  ),
                ),
            ],
          ),
        ),
      );
    }
    final toast = _toastText;
    if (toast != null) {
      final tokens = JhinDesignScope.of(context).tokens;
      children.add(
        Positioned(
          left: 16,
          right: 16,
          bottom: 16,
          child: Material(
            elevation: 4,
            borderRadius: BorderRadius.circular(8),
            color: _toastColor(context, _toastStyle),
            child: Padding(
              padding: EdgeInsets.all(tokens.spacing.md),
              child: Text(toast, style: const TextStyle(color: Colors.white)),
            ),
          ),
        ),
      );
    }
    return Stack(children: children);
  }

  /// The `dialog-backdrop` scrim (T87, index.css:391-398): the background
  /// at 60% (64% dark) behind a 4px blur, shown behind a glass dialog
  /// instead of the plain black45 barrier.
  Widget _dialogBackdropScrim(BuildContext context) {
    final design = JhinDesignScope.of(context);
    final brightness = Theme.brightnessOf(context);
    final background =
        design.colorOf('background', brightness: brightness) ??
        JhinDesignScope.materialOf(context).colorScheme.surface;
    return BackdropFilter(
      filter: ImageFilter.blur(
        sigmaX: JhinDialogGlassRecipe.backdropBlur,
        sigmaY: JhinDialogGlassRecipe.backdropBlur,
      ),
      child: ColoredBox(
        color: JhinDialogGlassRecipe.backdropFill(
          design.tokens.surface,
          brightness,
          background: background,
        ),
      ),
    );
  }

  /// The standard dialog transition (T87): `--ease-drawer`
  /// (index.css:190) over `motion.normal`, a fade with a 0.95→1 scale for
  /// the centered presentation (the upstream `starting:scale-95
  /// starting:opacity-0` pattern, ChatComposer.tsx:397) and a 16px
  /// translate-up for the sheet presentation (dialog-styles.ts:14
  /// `data-starting-style:translate-y-4`). Reduced motion collapses it.
  Widget _dialogTransition(
    BuildContext context,
    Widget child, {
    bool slide = false,
  }) {
    final design = JhinDesignScope.of(context);
    final duration = design.switches.reducedMotion
        ? Duration.zero
        : design.tokens.motion.normal;
    if (duration <= Duration.zero) return child;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: duration,
      curve: jhinEaseDrawerCurve(design.tokens.surface),
      builder: (context, value, inner) {
        final offset = slide ? Offset(0, 16 * (1 - value)) : Offset.zero;
        return Opacity(
          opacity: value.clamp(0.0, 1.0),
          child: Transform.translate(
            offset: offset,
            child: slide
                ? inner
                : Transform.scale(scale: 0.95 + 0.05 * value, child: inner),
          ),
        );
      },
      child: child,
    );
  }

  Widget _buildTop(BuildContext context) {
    if (_stack.isEmpty) return const SizedBox.shrink();
    final entry = _stack.last;
    // Stale-while-revalidate (§8.7): a previous screen stays visible while
    // the fetch runs; with no previous screen the built-in loading frame
    // (T79) shows — never a bare spinner.
    if (entry.node != null) {
      return _contextFor(entry).build(context, entry.node!);
    }
    if (entry.loading) {
      return _contextFor(entry).build(context, loadingFrameNode());
    }
    final fallback = _fallbacks?['error'];
    if (fallback is Map) {
      return _contextFor(entry).build(context, UiNode.fromJson(fallback));
    }
    // Missing `fallbacks` key: the built-in EmptyState is the client
    // fallback art (T79) — the app never shows a bare box.
    return EmptyState(
      kernelVersion: 'unknown',
      pluginCount: 0,
      onChangeServer: onOpenProfiles,
    );
  }

  Widget _buildStandalone(BuildContext context, Map<String, dynamic> node) {
    return _contextFor(_standalone).build(context, UiNode.fromJson(node));
  }

  static Color _toastColor(BuildContext context, String? style) {
    switch (style) {
      case 'error':
        return JhinDesignScope.materialOf(context).colorScheme.error;
      case 'success':
        return const Color(0xFF2E7D32);
      default:
        return JhinDesignScope.materialOf(context).colorScheme.inverseSurface;
    }
  }

  RenderContext _contextFor(_ScreenEntry entry) {
    final dispatcher = ActionDispatcher(
      transport: transport,
      state: entry.state,
      root: () => entry.node ?? UiNode(type: 'text', props: const {}),
      onChanged: notifyListeners,
      runDirectives: _executor.execute,
      onClientAction: keymapStore?.applyAction,
    );
    // The client-store seam of stateful primitives (`split`'s persisted
    // divider, T90): routed through the profile storage when present.
    final store = storage;
    return RenderContext(
      state: entry.state,
      registry: registry,
      patches: entry.patches,
      setState: (id, value) {
        entry.state.setValue(id, value);
        notifyListeners();
      },
      patch: (id, props) => unawaited(patch(id, props)),
      navigate: (screen) => unawaited(navigate(screen)),
      dispatch: dispatcher.dispatch,
      openStream: (topic, {onStatus}) => transport.sse(topic, onStatus: onStatus),
      runDirectives: _executor.execute,
      confirm: _showConfirm,
      root: () => entry.node ?? UiNode(type: 'text', props: const {}),
      canPop: () => _stack.length > 1,
      onBack: () => unawaited(back()),
      readPersisted: store == null ? null : (key) => store.readData(key),
      writePersisted: store == null
          ? null
          : (key, value) => store.writeEnvelope(key, value),
    );
  }

  // -------------------------------------------------------------------------
  // Bootstrap ingest and screen resolution
  // -------------------------------------------------------------------------

  void _ingestBootstrap(Map<String, dynamic> payload, {required bool fromHost}) {
    final signature = jsonEncode(payload);
    if (fromHost) {
      // Host rebuilds hand in the same payload: keep the live stack. A
      // genuinely new payload (host re-boot) re-ingests and resets.
      if (signature == _hostSignature) return;
      _hostSignature = signature;
    }
    // The theme wire (§1): the app shell regenerates its ThemeData pair
    // from the payload's `theme`/`tokens`/`density`.
    onTheme?.call(payload);
    final endpoint = payload['screenEndpoint'];
    _screenEndpoint =
        endpoint is String && endpoint.isNotEmpty ? endpoint : null;
    final fallbacks = payload['fallbacks'];
    _fallbacks = fallbacks is Map
        ? Map<String, dynamic>.from(fallbacks)
        : null;
    final entry = payload['entry'];
    String? entryId = entry is String && entry.isNotEmpty ? entry : null;
    final screens = payload['screens'];
    _inlineIds.clear();
    if (screens is List) {
      for (final item in screens) {
        if (item is! Map) continue;
        final id = item['id'];
        final node = item['node'];
        if (id is! String || node is! Map) continue;
        _putScreen(id, Map<String, dynamic>.from(node));
        _inlineIds.add(id);
        entryId ??= id;
      }
    }
    _entryId = entryId ?? '';
    _overrides.clear();
    _stack
      ..clear()
      ..add(_ScreenEntry(_entryId));
    unawaited(_ensureScreen(_stack.first));
  }

  void _putScreen(String id, Map<String, dynamic> node) {
    _screens.remove(id);
    _screens[id] = node;
    while (_screens.length > _cacheLimit) {
      _screens.remove(_screens.keys.first);
    }
  }

  Future<void> _ensureScreen(_ScreenEntry entry, {bool force = false}) async {
    final override = _overrides[entry.id];
    if (!force && override != null) {
      _applyNode(entry, override);
      notifyListeners();
      return;
    }
    final cached = _screens[entry.id];
    if (!force && cached != null) {
      _applyNode(entry, cached);
      notifyListeners();
      // Stale-while-revalidate (§8.7): refresh the cache in the background.
      // Inline screens travel with the bootstrap and are never fetched.
      if (!_inlineIds.contains(entry.id)) {
        unawaited(_fetchScreen(entry.id));
      }
      return;
    }
    await _fetchScreen(entry.id);
  }

  Future<void> _fetchScreen(String id) async {
    if (!_inflight.add(id)) return;
    final entry = _entryById(id);
    if (entry != null && entry.node == null) {
      entry.loading = true;
      entry.error = null;
      notifyListeners();
    }
    try {
      final template = _screenEndpoint ?? '/ui/screen/{id}';
      final path = template.replaceAll('{id}', Uri.encodeComponent(id));
      final json = await transport.getJson(path);
      final node = json['node'] is Map
          ? Map<String, dynamic>.from(json['node'] as Map)
          : json;
      _overrides.remove(id);
      _inlineIds.remove(id);
      _putScreen(id, node);
      final target = _entryById(id);
      if (target != null) _applyNode(target, node);
      await _persistScreens();
    } catch (error) {
      final target = _entryById(id);
      if (target != null && target.node == null) {
        target.loading = false;
        target.error = '$error';
      }
    } finally {
      _inflight.remove(id);
      notifyListeners();
    }
  }

  void _applyNode(_ScreenEntry entry, Map<String, dynamic> raw) {
    entry.node = UiNode.fromJson(raw);
    entry.loading = false;
    entry.error = null;
    if (entry.seeded) return;
    entry.seeded = true;
    for (final node in entry.node!.flatten()) {
      final id = node.id;
      final value = node.props['value'];
      if (id == null || value == null) continue;
      if (_seedableTypes.contains(node.type)) {
        entry.state.seedValue(id, value);
      }
    }
  }

  _ScreenEntry? _entryById(String id) {
    for (var i = _stack.length - 1; i >= 0; i--) {
      if (_stack[i].id == id) return _stack[i];
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Persistence (§8.7)
  // -------------------------------------------------------------------------

  Future<ServerProfile> _persistProfile(
      ServerProfile Function(ServerProfile current) update) async {
    final store = storage;
    final id = profile?.id;
    if (store == null || id == null) {
      return profile ??
          ServerProfile(id: '', label: '', url: transport.baseUrl.toString());
    }
    ServerProfile? current;
    for (final item in await store.readProfiles()) {
      if (item.id == id) current = item;
    }
    final updated = update(current ?? profile!);
    await store.updateProfile(updated);
    profile = updated;
    return updated;
  }

  Future<void> _persistScreens() async {
    if (storage == null || profile == null) return;
    await _persistProfile(
        (p) => p.copyWith(cachedScreens: Map<String, dynamic>.from(_screens)));
  }

  Future<void> _persistBootstrap(Map<String, dynamic> payload) async {
    if (storage == null || profile == null) return;
    final fallbacks = payload['fallbacks'];
    await _persistProfile((p) => p.copyWith(
          cachedBootstrap: payload,
          fallbacks: fallbacks is Map
              ? Map<String, dynamic>.from(fallbacks)
              : p.fallbacks,
        ));
  }

  static ServerProfile _withToken(ServerProfile p, String? token) =>
      ServerProfile(
        id: p.id,
        label: p.label,
        url: p.url,
        certFingerprint: p.certFingerprint,
        token: token,
        cachedBootstrap: p.cachedBootstrap,
        cachedScreens: p.cachedScreens,
        fallbacks: p.fallbacks,
      );

  // -------------------------------------------------------------------------
  // DirectiveHost (§8.5) — the 16 client directives
  // -------------------------------------------------------------------------

  /// Runs a raw directive list — also used by SSE `client` events (§8.6).
  Future<void> runDirectives(List<dynamic> directives) =>
      _executor.execute(directives);

  @override
  Future<void> navigate(String screen) async {
    final entry = _ScreenEntry(screen);
    _stack.add(entry);
    await _ensureScreen(entry);
  }

  @override
  Future<void> back() async {
    if (_stack.length <= 1) return;
    _stack.removeLast();
    notifyListeners();
  }

  @override
  Future<void> replace(String screen) async {
    final entry = _ScreenEntry(screen);
    if (_stack.isEmpty) {
      _stack.add(entry);
    } else {
      _stack[_stack.length - 1] = entry;
    }
    await _ensureScreen(entry);
  }

  @override
  Future<void> refresh() async {
    if (_stack.isEmpty) {
      // No screen yet: the bootstrap host is showing fallback art, so a
      // refresh means "reconnect" — re-run bootstrap to recover.
      await reloadBootstrap();
      return;
    }
    await _fetchScreen(_stack.last.id);
  }

  @override
  Future<void> reloadBootstrap() async {
    _screens.clear();
    _overrides.clear();
    await _persistScreens();
    final payload = await transport.getJson('/_jhin/bootstrap');
    _ingestBootstrap(payload, fromHost: false);
    await _persistBootstrap(payload);
  }

  @override
  Future<void> setToken(String value) async {
    final token = value.isEmpty ? null : value;
    transport.token = token;
    if (storage == null || profile == null) {
      debugPrint('Jhin SDUI: setToken has no profile storage to persist to');
      return;
    }
    await _persistProfile((p) => _withToken(p, token));
  }

  @override
  Future<void> clearToken() async {
    transport.token = null;
    if (storage == null || profile == null) {
      debugPrint('Jhin SDUI: clearToken has no profile storage to persist to');
      return;
    }
    await _persistProfile((p) => _withToken(p, null));
  }

  @override
  Future<void> setServerUrl(String value) async {
    if (storage == null || profile == null) {
      debugPrint('Jhin SDUI: setServerUrl has no profile storage to rewrite');
      return;
    }
    final updated = await _persistProfile((p) => ServerProfile(
          id: p.id,
          label: p.label,
          url: value,
          certFingerprint: p.certFingerprint,
          token: p.token,
          cachedBootstrap: p.cachedBootstrap,
          cachedScreens: p.cachedScreens,
          fallbacks: p.fallbacks,
        ));
    final factory = createTransport;
    transport = factory != null
        ? factory(updated)
        : JhinTransport(
            baseUrl: Uri.parse(updated.url),
            trustStore:
                TrustStore(pinnedFingerprint: updated.certFingerprint),
            token: updated.token,
          );
    // Reboot to the bootstrap host against the new URL (§8.5, D-9).
    await reloadBootstrap();
  }

  @override
  Future<void> openProfiles() async {
    final callback = onOpenProfiles;
    if (callback == null) {
      debugPrint('Jhin SDUI: openProfiles has no handler');
      return;
    }
    callback();
  }

  @override
  Future<void> toast(String text, String? style) async {
    _toastText = text;
    _toastStyle = style;
    _toastTimer?.cancel();
    _toastTimer = Timer(const Duration(seconds: 4), () {
      _toastText = null;
      _toastStyle = null;
      notifyListeners();
    });
    notifyListeners();
  }

  @override
  Future<void> dialog(Map<String, dynamic> node, {String? kind}) async {
    final entry = _stack.isEmpty ? _standalone : _stack.last;
    final ctx = _contextFor(entry);
    // The node arrives in the flat wire shape ({type, ...props}); accept a
    // nested props map too.
    final props = node['props'];
    _dialogGlass =
        node['glass'] == true || (props is Map && props['glass'] == true);
    switch (kind) {
      case 'sheet':
        _dialogAtBottom = true;
        _dialogBuilder = (context) => buildSheetChrome(
          context,
          ctx.build(context, UiNode.fromJson(node)),
        );
      case null:
        _dialogAtBottom = false;
        _dialogBuilder = (context) {
          return Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: ctx.build(context, UiNode.fromJson(node)),
            ),
          );
        };
      default:
        // An unknown kind degrades to a `card` render of the content (§2.4):
        // the node is shown inside a `card` primitive, never a crash.
        _dialogAtBottom = false;
        _dialogBuilder = (context) {
          final card = UiNode.fromJson({
            'type': 'card',
            'children': [node],
          });
          return ctx.build(context, card);
        };
    }
    notifyListeners();
  }

  @override
  Future<void> dismissDialog() async {
    _dialogBuilder = null;
    _dialogAtBottom = false;
    _dialogGlass = false;
    notifyListeners();
  }

  @override
  Future<void> setStateValue(String id, Object? value) async {
    if (_stack.isEmpty) return;
    _stack.last.state.setValue(id, value);
    notifyListeners();
  }

  @override
  Future<void> patch(String id, Map<String, dynamic> props) async {
    if (_stack.isEmpty) return;
    final entry = _stack.last;
    entry.patches[id] = {...?entry.patches[id], ...props};
    notifyListeners();
  }

  @override
  Future<void> setScreen(String id, Map<String, dynamic> node) async {
    _overrides[id] = node;
    final entry = _entryById(id);
    if (entry != null) _applyNode(entry, node);
    notifyListeners();
  }

  @override
  Future<void> openUrl(String value) async {
    final callback = onOpenUrl;
    if (callback == null) {
      debugPrint('Jhin SDUI: openUrl has no handler, ignored: $value');
      return;
    }
    callback(value);
  }

  void _showConfirm(String message, VoidCallback onConfirm) {
    _dialogAtBottom = false;
    _dialogBuilder = (context) => Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(message),
                const SizedBox(height: 16),
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    TextButton(
                      onPressed: () => unawaited(dismissDialog()),
                      child: const Text('Cancel'),
                    ),
                    ElevatedButton(
                      onPressed: () {
                        unawaited(dismissDialog());
                        onConfirm();
                      },
                      child: const Text('OK'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        );
    notifyListeners();
  }

  @override
  void notifyListeners() {
    if (_disposed) return;
    super.notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _toastTimer?.cancel();
    super.dispose();
  }
}

/// One screen on the runtime's stack: its id, local state (§8.7) and live
/// `patch` overlays (§8.5).
class _ScreenEntry {
  _ScreenEntry(this.id);

  final String id;
  final UiState state = UiState();
  final Map<String, Map<String, dynamic>> patches = {};
  UiNode? node;
  bool loading = false;
  String? error;
  bool seeded = false;
}

/// Rebuilds the runtime's tree whenever the runtime notifies.
class _RuntimeView extends StatelessWidget {
  const _RuntimeView(this.runtime, this.buildView);

  final SduiRuntime runtime;
  final Widget Function(BuildContext context) buildView;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: runtime,
        builder: (context, _) => buildView(context),
      );
}
