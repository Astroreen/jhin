import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../render_context.dart';
import '../ui_node.dart';

/// `shell` (§2.6): `sidebar?`, `header?`, `body?`, `detail?`, `rail?`,
/// `breakpoint?` (default 900), `sidebarWidth?` (default `$size.sidebar`,
/// 280), `sidebarCollapsedWidth?` (default 56), `collapsible?`,
/// `collapsed?` (patchable via the node `id`).
///
/// At or above the breakpoint the sidebar sits beside the content at its
/// expanded (or collapsed) width; below it the sidebar becomes a drawer
/// opened from a hamburger in the header (a slim bar carries the hamburger
/// when the shell has no header). A shell without `body` degrades to a card
/// with "Missing body" (§2.6). `collapsed` is honoured whenever it is
/// `true`; `collapsible` adds the sidebar collapse toggle.
Widget buildShell(BuildContext context, UiNode node, RenderContext ctx) =>
    _ShellView(node: node, ctx: ctx);

UiNode? _slot(UiNode node, String key) {
  final raw = node.props[key];
  return raw is Map ? UiNode.fromJson(raw) : null;
}

double _widthProp(UiNode node, String key, double fallback) {
  final raw = node.props[key];
  if (raw is num) return raw.toDouble();
  if (raw is String) {
    final parsed = num.tryParse(raw);
    if (parsed != null) return parsed.toDouble();
  }
  return fallback;
}

class _ShellView extends StatefulWidget {
  const _ShellView({required this.node, required this.ctx});

  final UiNode node;
  final RenderContext ctx;

  @override
  State<_ShellView> createState() => _ShellViewState();
}

class _ShellViewState extends State<_ShellView> {
  late bool _collapsed = widget.node.boolProp('collapsed') == true;

  @override
  void didUpdateWidget(covariant _ShellView old) {
    super.didUpdateWidget(old);
    final overlay =
        widget.node.id == null ? null : widget.ctx.patches[widget.node.id];
    var next = _collapsed;
    var changed = false;
    if (overlay != null && overlay.containsKey('collapsed')) {
      next = overlay['collapsed'] == true;
      changed = true;
    } else if (widget.node.props['collapsed'] != old.node.props['collapsed']) {
      next = widget.node.boolProp('collapsed') == true;
      changed = true;
    }
    if (changed && next != _collapsed) {
      setState(() => _collapsed = next);
    }
  }

  void _toggleCollapsed() {
    setState(() => _collapsed = !_collapsed);
    final id = widget.node.id;
    if (id != null) {
      widget.ctx.patch(id, {'collapsed': _collapsed});
    }
  }

  @override
  Widget build(BuildContext context) {
    final node = widget.node;
    final ctx = widget.ctx;
    final bodyNode = _slot(node, 'body');
    if (bodyNode == null) {
      return _missingBody(context);
    }
    final tokens = JhinDesignScope.of(context).tokens;
    final width = MediaQuery.sizeOf(context).width;
    final breakpoint = node.numProp('breakpoint')?.toDouble() ?? 900;
    final sidebarWidth = _widthProp(node, 'sidebarWidth', tokens.sidebarWidth);
    final collapsedWidth =
        _widthProp(node, 'sidebarCollapsedWidth', 56);
    final sidebarNode = _slot(node, 'sidebar');
    final headerNode = _slot(node, 'header');
    final detailNode = _slot(node, 'detail');
    final railNode = _slot(node, 'rail');

    final body = ctx.build(context, bodyNode);
    final detail = detailNode == null ? null : ctx.build(context, detailNode);
    final main = Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(flex: 2, child: body),
        if (detail != null) Expanded(flex: 1, child: detail),
      ],
    );

    if (width < breakpoint) {
      return Material(
        type: MaterialType.transparency,
        child: _narrow(
          context,
          sidebarNode: sidebarNode,
          railNode: railNode,
          headerNode: headerNode,
          main: main,
        ),
      );
    }

    final sidebar = sidebarNode == null
        ? null
        : SizedBox(
            width: _collapsed ? collapsedWidth : sidebarWidth,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (node.boolProp('collapsible') == true)
                  Align(
                    alignment: Alignment.centerRight,
                    child: IconButton(
                      icon: Icon(_collapsed
                          ? Icons.chevron_right
                          : Icons.chevron_left),
                      tooltip: _collapsed ? 'Expand sidebar' : 'Collapse sidebar',
                      onPressed: _toggleCollapsed,
                    ),
                  ),
                Expanded(child: ctx.build(context, sidebarNode)),
              ],
            ),
          );
    return Material(
      type: MaterialType.transparency,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (railNode != null) ctx.build(context, railNode),
          ?sidebar,
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (headerNode != null) ctx.build(context, headerNode),
                Expanded(child: main),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// Below the breakpoint the sidebar becomes a drawer; a hamburger in the
  /// header (or a slim bar when there is no header) opens it.
  Widget _narrow(
    BuildContext context, {
    required UiNode? sidebarNode,
    required UiNode? railNode,
    required UiNode? headerNode,
    required Widget main,
  }) {
    final ctx = widget.ctx;
    final hamburger = Builder(
      builder: (context) => IconButton(
        icon: const Icon(Icons.menu),
        tooltip: 'Open navigation',
        onPressed: () => Scaffold.of(context).openDrawer(),
      ),
    );
    final header = headerNode == null
        ? SizedBox(
            height: 48,
            child: Align(alignment: Alignment.centerLeft, child: hamburger),
          )
        : Row(
            children: [
              hamburger,
              Expanded(child: ctx.build(context, headerNode)),
            ],
          );
    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        header,
        Expanded(child: main),
      ],
    );
    if (sidebarNode == null) {
      return railNode == null
          ? body
          : Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [ctx.build(context, railNode), Expanded(child: body)],
            );
    }
    return Scaffold(
      drawer: Drawer(child: ctx.build(context, sidebarNode)),
      body: railNode == null
          ? body
          : Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [ctx.build(context, railNode), Expanded(child: body)],
            ),
    );
  }

  Widget _missingBody(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = JhinDesignScope.of(context).tokens;
    return Card(
      child: Padding(
        padding: EdgeInsets.all(tokens.spacing.md),
        child: Text('Missing body', style: TextStyle(color: theme.disabledColor)),
      ),
    );
  }
}
