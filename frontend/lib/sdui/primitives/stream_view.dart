import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../core/sse/sse_stream.dart';
import '../../design/theme.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';
import 'scroll.dart';

/// `stream_view` (§8.6): `id?`, `topic`, `mode: append|replace`,
/// `itemLimit?`, `autoScroll?`, `empty?`.
///
/// Opens the SSE stream of `topic` and renders one widget node per
/// `{"node":{…}}` event. `mode` appends (default) or replaces the content;
/// `itemLimit` drops the OLDEST items; `autoScroll` pins the view to the
/// newest item; `empty` is shown while nothing has arrived.
///
/// T100 scroll anchoring (the upstream `MessagesTimeline` contract, t3code
/// commit 37de6cb): a frame that APPENDS, replaces or removes items jumps
/// to the bottom — but only while the view follows the end (the upstream
/// `following-end` mode of `timelineScrollAnchoring.ts`; scrolling away
/// beyond the [kChatTimelineAnchorOffset] tolerance switches to
/// `free-scrolling` and new items no longer yank the viewport). A `patch`
/// frame never scrolls: it updates rendered props in place and the
/// position is preserved (the upstream `maintainVisibleContentPosition`
/// with `shouldRestorePosition`). The list reserves
/// [kChatTimelineAnchorOffset] as the end inset so the newest row clears
/// the composer seam.
///
/// Connection loss is retried with backoff by the transport (the same URL
/// is re-requested verbatim); while reconnecting a subtle indicator is
/// shown and the server may replay events on resume — replays never
/// duplicate widgets: node identity is the node `id` (an id that was
/// already accepted is replaced in place, and an id that was dropped by
/// `itemLimit` or `remove`d stays gone). Nodes without an `id` always
/// append.
/// T101 timeline row kinds: every stream item may carry `rowKind` (one of
/// the 14 kinds of docs/sdui.md §8.6 — `message`, `assistant-meta`, `event`,
/// `work`, `work-live`, `work-toggle`, `thinking`, `proposed-plan`,
/// `working`, `worktree-setup`, `turn-fold`, `attempt-fold`,
/// `context-compaction`, `unknown`) and the continuation key `rowKey`
/// (`${type}:${subtype}`, plan §4.5). Consecutive items sharing a `rowKey`
/// render as one visual group — the trailing row of a group closes with the
/// kind gap, members inside close with none (the upstream `continuesWorkLog`
/// rule, t3code commit 37de6cb, `MessagesTimeline.logic.ts:1773-1781`). The
/// kind gaps port the upstream `pb-*` scale
/// (`MessagesTimeline.tsx:1766-1784`, `WorkLog.tsx:19-21`): 16 px for the
/// message family, 8 px for the work/event family, 6 px for the fold and
/// working strips. An item with an unrecognized `rowKind` renders with the
/// default gap — never a throw.
double timelineRowGap(String? rowKind) => switch (rowKind) {
      'work' ||
      'work-live' ||
      'work-toggle' ||
      'thinking' ||
      'event' ||
      'worktree-setup' ||
      'attempt-fold' ||
      'unknown' =>
        8,
      'turn-fold' || 'working' => 6,
      _ => 16,
    };

/// Whether two consecutive stream items belong to one visual group: both
/// carry the same non-empty `rowKey`.
bool timelineRowsContinue(Map<String, dynamic> item, Map<String, dynamic> next) {
  final key = item['rowKey']?.toString();
  return key != null && key.isNotEmpty && key == next['rowKey']?.toString();
}

Widget buildStreamView(BuildContext context, UiNode node, RenderContext ctx) {
  final topic = node.stringProp('topic');
  if (topic == null || topic.isEmpty) {
    return degradedBox(context, 'Missing topic');
  }
  return _StreamView(node: node, ctx: ctx);
}

class _StreamView extends StatefulWidget {
  const _StreamView({required this.node, required this.ctx});

  final UiNode node;
  final RenderContext ctx;

  @override
  State<_StreamView> createState() => _StreamViewState();
}

class _StreamViewState extends State<_StreamView> {
  final List<Map<String, dynamic>> _items = [];
  final Set<String> _seenIds = {};
  final ScrollController _scroll = ScrollController();
  StreamSubscription<Map<String, dynamic>>? _subscription;
  SseConnectionStatus _status = SseConnectionStatus.connecting;

  /// Whether the view follows the end (the upstream `following-end`
  /// timeline mode): true until the user scrolls away from the end beyond
  /// the anchor-offset tolerance, back to true at the end again. Only a
  /// following view jumps on appended items.
  bool _followingEnd = true;

  String get _topic => widget.node.stringProp('topic') ?? '';

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_trackFollowingEnd);
    _subscribe();
  }

  @override
  void didUpdateWidget(_StreamView old) {
    super.didUpdateWidget(old);
    if (old.node.stringProp('topic') != widget.node.stringProp('topic')) {
      _subscription?.cancel();
      _subscription = null;
      _items.clear();
      _seenIds.clear();
      _followingEnd = true;
      _subscribe();
    }
  }

  void _subscribe() {
    if (_topic.isEmpty) return;
    _subscription = widget.ctx.openStream(_topic, onStatus: _onStatus).listen(
      _onEvent,
      onError: (Object error) {
        debugPrint('Jhin SDUI: stream "$_topic" error: $error');
      },
    );
  }

  void _onStatus(SseConnectionStatus status) {
    if (_status == status) return;
    _status = status;
    if (!mounted) return;
    // Deferred: the transport reports `connecting` synchronously from
    // `openStream`, i.e. during `initState`/build — rebuilding must wait.
    scheduleMicrotask(() {
      if (mounted) setState(() {});
    });
  }

  void _onEvent(Map<String, dynamic> event) {
    if (!mounted) return;
    var changed = false;
    var listChanged = false;
    final node = asMap(event['node']);
    if (node != null) {
      changed = _applyNode(node);
      listChanged = changed;
    } else {
      final patch = asMap(event['patch']);
      if (patch != null) {
        final id = patch['id'];
        final props = asMap(patch['props']);
        if (id is String && props != null) {
          changed = _applyPatch(id, props);
        }
        // A patch never scrolls: the position is preserved (T100).
        listChanged = false;
      } else {
        final client = event['client'];
        if (client is List) {
          widget.ctx.runDirectives(List<dynamic>.from(client));
        } else {
          final remove = event['remove'];
          if (remove is String) {
            changed = _applyRemove(remove);
            listChanged = changed;
          }
        }
      }
    }
    if (changed) setState(() {});
    if (listChanged) _followNewItems();
  }

  /// Jumps to the bottom on appended/replaced/removed items — but only
  /// while the view follows the end; a free-scrolled viewport keeps its
  /// position (the upstream `following-end` / `free-scrolling` modes).
  void _followNewItems() {
    if (widget.node.boolProp('autoScroll') != true || !_followingEnd) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      }
    });
  }

  /// Tracks the following-end state off the scroll position: within the
  /// anchor-offset tolerance of the end counts as following (the jump
  /// itself lands exactly at the end and keeps the flag true).
  void _trackFollowingEnd() {
    if (!_scroll.hasClients) return;
    final position = _scroll.position;
    final following =
        position.maxScrollExtent - position.pixels <= kChatTimelineAnchorOffset + 1;
    if (following != _followingEnd) {
      _followingEnd = following;
    }
  }

  /// Appends one node, replaces everything (`mode: replace`) or — on a
  /// replayed id — replaces the existing item in place. An id already
  /// dropped (by `itemLimit` or `remove`) is never resurrected.
  bool _applyNode(Map<String, dynamic> node) {
    if (widget.node.stringProp('mode') == 'replace') {
      _items
        ..clear()
        ..add(node);
      final id = node['id'];
      if (id is String) _seenIds.add(id);
      return true;
    }
    final id = node['id'];
    if (id is String) {
      if (_seenIds.contains(id)) {
        final index = _items.indexWhere((item) => item['id'] == id);
        if (index < 0) return false;
        _items[index] = node;
        return true;
      }
      _seenIds.add(id);
    }
    _items.add(node);
    final limit = widget.node.numProp('itemLimit');
    if (limit != null) {
      final keep = math.max(0, limit.round());
      if (_items.length > keep) {
        _items.removeRange(0, _items.length - keep);
      }
    }
    return true;
  }

  /// Merges `props` into the stream item with that `id`; with no such
  /// item the patch targets the surrounding screen instead (§8.5).
  bool _applyPatch(String id, Map<String, dynamic> props) {
    var matched = false;
    for (var i = 0; i < _items.length; i++) {
      if (_items[i]['id'] == id) {
        _items[i] = {..._items[i], ...props};
        matched = true;
      }
    }
    if (!matched) {
      widget.ctx.patch(id, props);
    }
    return matched;
  }

  bool _applyRemove(String id) {
    final before = _items.length;
    _items.removeWhere((item) => item['id'] == id);
    // `id` stays in `_seenIds`, so a replay cannot resurrect the item.
    return _items.length != before;
  }

  @override
  void dispose() {
    _subscription?.cancel();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tokens = JhinDesignScope.of(context).tokens;
    final children = <Widget>[
      if (_items.isEmpty)
        _empty(context)
      else
        ConstrainedBox(
          constraints: BoxConstraints(maxHeight: tokens.streamListHeight),
          child: ListView.builder(
            controller: _scroll,
            shrinkWrap: true,
            // The end-of-timeline inset (T100): the anchor offset keeps the
            // newest row clear of the composer seam.
            padding: const EdgeInsets.only(bottom: kChatTimelineAnchorOffset),
            itemCount: _items.length,
            itemBuilder: (context, index) {
              // The T101 row spacing: a row whose continuation key the next
              // row shares closes with no gap; the rest close with the kind
              // gap (the upstream pb-* scale).
              final continues = index + 1 < _items.length &&
                  timelineRowsContinue(_items[index], _items[index + 1]);
              final gap =
                  continues ? 0.0 : timelineRowGap(_items[index]['rowKind']?.toString());
              return Padding(
                padding: EdgeInsets.only(bottom: gap),
                child: widget.ctx.build(context, UiNode.fromJson(_items[index])),
              );
            },
          ),
        ),
      if (_status == SseConnectionStatus.reconnecting) const _ReconnectingRow(),
    ];
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: children,
    );
  }

  Widget _empty(BuildContext context) {
    final empty = widget.node.props['empty'];
    if (empty != null) {
      return widget.ctx.build(context, UiNode.fromJson(empty));
    }
    return const SizedBox.shrink();
  }
}

/// Subtle reconnect indicator: a tiny spinner and a caption.
class _ReconnectingRow extends StatelessWidget {
  const _ReconnectingRow();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        key: const Key('stream-view-reconnecting'),
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(
            width: 10,
            height: 10,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          const SizedBox(width: 6),
          Text('Reconnecting...',
              style: TextStyle(
                  fontSize: 10, color: JhinDesignScope.materialOf(context).disabledColor)),
        ],
      ),
    );
  }
}
