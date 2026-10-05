import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `diff_view` (§2.6, contract level 3): `file?`, `language?`,
/// `hunks[{header, lines[{kind: add|del|ctx|meta, oldNo?, newNo?, text}]}]`
/// (required), `view: unified|split` (default `unified`),
/// `colorScheme: default|blue-orange` (default: the ambient
/// `data-diff-color-scheme` switch, T86), `stats? {additions, deletions}`,
/// `demo: true` (mandatory — the shared preview marker rides the universal
/// wrapper).
///
/// A decorative diff renderer good enough to look like upstream's FileDiff
/// with no diff engine: it renders exactly the hunks the server authors —
/// the stat header (green `+n` / red `-n`, the upstream DiffStatLabel
/// `text-diff-addition`/`text-diff-deletion` pair), a view toggle and the
/// code body with line numbers on the `diff-addition`/`diff-deletion` lane
/// backgrounds. It computes nothing.
///
/// Upstream anchors (t3code `apps/web/src`, commit 37de6cb): the stat label
/// (`components/chat/DiffStatLabel.tsx:38-47`, mono tabular `+n`/`-n`), the
/// stacked/split toggle (`components/DiffPanel.tsx:892-901`, the
/// Rows3/Columns2 pair; `:1146` maps it to `diffStyle: unified|split`),
/// the lane tokens (`index.css:2025-2028`: addition = success, deletion =
/// destructive, foregrounds emerald/red) and the blue-orange override
/// (`index.css:2041-2045`, the `data-diff-color-scheme` switch T86 ports).
/// The line backgrounds mix the code surface with the lane colour at the
/// upstream `diffRendering.ts:348-380` ratios (50% light / 70% dark, the
/// number gutters 35% / 60%).
///
/// Toggling `view` is purely client-side: a local `setState` plus a `patch`
/// overlay on the node `id` (the `tabs` selection pattern) — no server
/// round-trip. Split view pairs each hunk's old side (`del`/`ctx`/`meta`)
/// against its new side (`add`/`ctx`/`meta`). Missing or malformed hunks
/// degrade visibly (§2.4); an unknown line kind renders as context.
Widget buildDiffView(BuildContext context, UiNode node, RenderContext ctx) {
  final hunks = parseDiffHunks(node);
  if (hunks.isEmpty) {
    return degradedBox(context, 'Missing hunks');
  }
  return _DiffView(node: node, ctx: ctx, hunks: hunks);
}

/// One parsed hunk: the `@@ … @@` header plus its lines.
class DiffHunk {
  const DiffHunk({required this.header, required this.lines});

  final String header;
  final List<DiffLine> lines;
}

/// One parsed diff line: the row kind, the gutter numbers and the text.
class DiffLine {
  const DiffLine({
    required this.kind,
    required this.text,
    this.oldNo,
    this.newNo,
  });

  final String kind;
  final String text;
  final num? oldNo;
  final num? newNo;
}

/// Parses the `hunks` prop (§2.4): a list of `{header, lines}` maps;
/// malformed hunks and lines are dropped, an unknown line kind renders as
/// context, missing numbers leave their gutter cell empty.
List<DiffHunk> parseDiffHunks(UiNode node) {
  final raw = node.listProp('hunks');
  if (raw == null) return const [];
  final hunks = <DiffHunk>[];
  for (final rawHunk in raw) {
    final map = asMap(rawHunk);
    final header = map?['header'];
    if (header is! String) continue;
    final rawLines = map?['lines'];
    final lines = <DiffLine>[];
    for (final rawLine in rawLines is List ? rawLines : const []) {
      final lineMap = asMap(rawLine);
      if (lineMap == null) continue;
      lines.add(DiffLine(
        kind: lineMap['kind'] is String ? lineMap['kind'] as String : 'ctx',
        text: lineMap['text'] is String ? lineMap['text'] as String : '',
        oldNo: lineMap['oldNo'] is num ? lineMap['oldNo'] as num : null,
        newNo: lineMap['newNo'] is num ? lineMap['newNo'] as num : null,
      ));
    }
    hunks.add(DiffHunk(header: header, lines: lines));
  }
  return hunks;
}

/// The effective `view`: the prop (patch overlays included), `split` only
/// when the value says so — anything else is `unified` (§2.4).
String effectiveDiffView(UiNode node, RenderContext ctx) {
  final overlay = node.id == null ? null : ctx.patches[node.id];
  final raw = overlay != null && overlay.containsKey('view')
      ? overlay['view']
      : node.props['view'];
  return raw == 'split' ? 'split' : 'unified';
}

class _DiffView extends StatefulWidget {
  const _DiffView({required this.node, required this.ctx, required this.hunks});

  final UiNode node;
  final RenderContext ctx;
  final List<DiffHunk> hunks;

  @override
  State<_DiffView> createState() => _DiffViewState();
}

class _DiffViewState extends State<_DiffView> {
  late String _view = effectiveDiffView(widget.node, widget.ctx);

  @override
  void didUpdateWidget(covariant _DiffView old) {
    super.didUpdateWidget(old);
    final next = effectiveDiffView(widget.node, widget.ctx);
    if (next != _view) {
      setState(() => _view = next);
    }
  }

  /// The inline view toggle: a local `setState` plus the `patch` overlay on
  /// the node `id` — no server round-trip (§2.6).
  void _toggle(String next) {
    if (next == _view) return;
    setState(() => _view = next);
    final id = widget.node.id;
    if (id != null) {
      widget.ctx.patch(id, {'view': next});
    }
  }

  @override
  Widget build(BuildContext context) {
    final design = JhinDesignScope.of(context);
    final tokens = design.tokens;
    final material = JhinDesignScope.materialOf(context);
    final brightness = Theme.brightnessOf(context);
    final dark = brightness == Brightness.dark;

    // The lane colours: the node `colorScheme` prop wins, else the ambient
    // `data-diff-color-scheme` switch (T86). The theme lanes fall back
    // through success/destructive (the upstream index.css:2025-2028
    // defaults) to the token-layer pair.
    final rawScheme = widget.node.stringProp('colorScheme');
    final scheme = rawScheme == 'blue-orange'
        ? JhinDiffColorScheme.blueOrange
        : rawScheme == 'default'
            ? JhinDiffColorScheme.defaultScheme
            : design.switches.diffColorScheme;
    final themeAdded = design.colorOf('diff-addition', brightness: brightness) ??
        design.colorOf('success', brightness: brightness) ??
        kDiffAdditionFallback;
    final themeRemoved = design.colorOf('diff-deletion', brightness: brightness) ??
        design.colorOf('destructive', brightness: brightness) ??
        kDiffDeletionFallback;
    final lanes = resolveDiffColors(
      scheme: scheme,
      themeAdded: themeAdded,
      themeRemoved: themeRemoved,
      dark: dark,
    );
    final addedFg = design.colorOf('diff-addition-foreground', brightness: brightness) ??
        lanes.added;
    final removedFg = design.colorOf('diff-deletion-foreground', brightness: brightness) ??
        lanes.removed;

    // The code surface and the upstream line-background mixes
    // (diffRendering.ts:348-380): the row 50% light / 70% dark, the number
    // gutter 35% / 60%.
    final codeBg = design.colorOf('code', brightness: brightness) ??
        material.colorScheme.surfaceContainerHighest;
    final foreground = material.colorScheme.onSurface;
    final addBg = Color.lerp(codeBg, lanes.added, dark ? 0.7 : 0.5)!;
    final addGutterBg = Color.lerp(codeBg, lanes.added, dark ? 0.6 : 0.35)!;
    final delBg = Color.lerp(codeBg, lanes.removed, dark ? 0.7 : 0.5)!;
    final delGutterBg = Color.lerp(codeBg, lanes.removed, dark ? 0.6 : 0.35)!;
    final metaBg = Color.lerp(codeBg, foreground, 0.06)!;

    final monoFamily = tokens.resolveToken(r'$font.mono');
    var mono = tokens.typography.mono.copyWith(color: foreground);
    if (monoFamily is String && monoFamily.isNotEmpty) {
      mono = mono.copyWith(fontFamily: monoFamily);
    }
    final labelStyle = tokens.typography.small
        .copyWith(color: material.colorScheme.onSurfaceVariant);
    final gutterStyle = mono.copyWith(color: foreground.withValues(alpha: 0.55));

    final stats = asMap(widget.node.props['stats']);
    final additions = stats?['additions'] is num ? stats!['additions'] as num : null;
    final deletions = stats?['deletions'] is num ? stats!['deletions'] as num : null;
    final file = widget.node.stringProp('file');
    final language = widget.node.stringProp('language');

    final header = Padding(
      padding: EdgeInsets.fromLTRB(tokens.spacing.sm, tokens.spacing.sm,
          tokens.spacing.sm, 0),
      child: Row(
        children: [
          if (file != null)
            Expanded(
              child: Text(
                language == null ? file : '$file  ·  $language',
                style: labelStyle,
                softWrap: false,
                overflow: TextOverflow.ellipsis,
              ),
            )
          else
            const Spacer(),
          if (additions != null)
            Padding(
              padding: EdgeInsets.only(left: tokens.spacing.sm),
              child: Text('+$additions',
                  style: mono.copyWith(color: addedFg)),
            ),
          if (deletions != null)
            Padding(
              padding: EdgeInsets.only(left: tokens.spacing.sm),
              child: Text('-$deletions',
                  style: mono.copyWith(color: removedFg)),
            ),
          Padding(
            padding: EdgeInsets.only(left: tokens.spacing.sm),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                _viewButton(
                  context: context,
                  icon: iconFor('table_rows'),
                  tooltip: 'Unified view',
                  active: _view == 'unified',
                  activeColor: material.colorScheme.primary,
                  inactiveColor: material.colorScheme.onSurfaceVariant,
                  onPressed: () => _toggle('unified'),
                ),
                _viewButton(
                  context: context,
                  icon: iconFor('view_column'),
                  tooltip: 'Split view',
                  active: _view == 'split',
                  activeColor: material.colorScheme.primary,
                  inactiveColor: material.colorScheme.onSurfaceVariant,
                  onPressed: () => _toggle('split'),
                ),
              ],
            ),
          ),
        ],
      ),
    );

    final body = _view == 'split'
        ? _splitBody(
            hunks: widget.hunks,
            mono: mono,
            gutterStyle: gutterStyle,
            metaBg: metaBg,
            addBg: addBg,
            addGutterBg: addGutterBg,
            delBg: delBg,
            delGutterBg: delGutterBg,
            addedFg: addedFg,
            removedFg: removedFg,
            divider: material.dividerColor,
            gap: tokens.spacing.xs,
          )
        : _unifiedBody(
            hunks: widget.hunks,
            mono: mono,
            gutterStyle: gutterStyle,
            metaBg: metaBg,
            addBg: addBg,
            addGutterBg: addGutterBg,
            delBg: delBg,
            delGutterBg: delGutterBg,
            addedFg: addedFg,
            removedFg: removedFg,
            gap: tokens.spacing.xs,
          );

    return Container(
      padding: EdgeInsets.fromLTRB(tokens.spacing.sm, 0, tokens.spacing.sm,
          tokens.spacing.sm),
      decoration: BoxDecoration(
        color: codeBg,
        borderRadius: BorderRadius.circular(tokens.radius.sm),
        border: Border.all(color: material.colorScheme.outlineVariant),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          header,
          SizedBox(height: tokens.spacing.sm),
          body,
        ],
      ),
    );
  }
}

/// One view-toggle button (the upstream Rows3/Columns2 ToggleGroup pair,
/// DiffPanel.tsx:892-901): the active layout is filled, the other muted.
Widget _viewButton({
  required BuildContext context,
  required IconData? icon,
  required String tooltip,
  required bool active,
  required Color activeColor,
  required Color inactiveColor,
  required VoidCallback onPressed,
}) {
  return IconButton(
    icon: Icon(icon, color: active ? activeColor : inactiveColor),
    tooltip: tooltip,
    visualDensity: VisualDensity.compact,
    onPressed: onPressed,
  );
}

/// The gutter cell of one line: the number right-aligned, the lane-tinted
/// background on add/del rows, empty otherwise.
Widget _gutter(
  num? number,
  TextStyle style,
  Color? background,
  double width,
) {
  return Container(
    width: width,
    color: background,
    padding: EdgeInsets.only(right: width * 0.15),
    alignment: Alignment.centerRight,
    child: Text(
      number == null ? '' : '$number',
      style: style,
      softWrap: false,
      overflow: TextOverflow.clip,
    ),
  );
}

/// The 1-character lane marker of one line: `+` on additions, `-` on
/// deletions, a blank on context and meta rows.
Widget _marker(String kind, TextStyle mono, Color addedFg, Color removedFg) {
  final text = switch (kind) {
    'add' => '+',
    'del' => '-',
    _ => ' ',
  };
  final color = switch (kind) {
    'add' => addedFg,
    'del' => removedFg,
    _ => null,
  };
  return SizedBox(
    width: 16,
    child: Text(
      text,
      style: color == null ? mono : mono.copyWith(color: color),
      softWrap: false,
      textAlign: TextAlign.center,
    ),
  );
}

/// One unified line row: old gutter, new gutter, marker, text.
Widget _unifiedLine(
  DiffLine line, {
  required TextStyle mono,
  required TextStyle gutterStyle,
  required Color metaBg,
  required Color addBg,
  required Color addGutterBg,
  required Color delBg,
  required Color delGutterBg,
  required Color addedFg,
  required Color removedFg,
}) {
  final isAdd = line.kind == 'add';
  final isDel = line.kind == 'del';
  final isMeta = line.kind == 'meta';
  final rowBg = isAdd
      ? addBg
      : isDel
          ? delBg
          : isMeta
              ? metaBg
              : null;
  final gutterBg = isAdd
      ? addGutterBg
      : isDel
          ? delGutterBg
          : isMeta
              ? metaBg
              : null;
  final row = Row(
    crossAxisAlignment: CrossAxisAlignment.center,
    children: [
      _gutter(line.oldNo, gutterStyle, gutterBg, 40),
      _gutter(line.newNo, gutterStyle, gutterBg, 40),
      _marker(line.kind, mono, addedFg, removedFg),
      Expanded(
        child: Text(
          line.text,
          style: mono,
          softWrap: false,
          overflow: TextOverflow.clip,
        ),
      ),
    ],
  );
  return rowBg == null ? row : ColoredBox(color: rowBg, child: row);
}

/// The unified body: one hunk header row per hunk, then its lines.
Widget _unifiedBody({
  required List<DiffHunk> hunks,
  required TextStyle mono,
  required TextStyle gutterStyle,
  required Color metaBg,
  required Color addBg,
  required Color addGutterBg,
  required Color delBg,
  required Color delGutterBg,
  required Color addedFg,
  required Color removedFg,
  required double gap,
}) {
  return Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      for (final hunk in hunks) ...[
        Container(
          width: double.infinity,
          color: metaBg,
          padding: EdgeInsets.symmetric(horizontal: gap, vertical: gap / 2),
          child: Text(
            hunk.header,
            style: mono.copyWith(
                color: gutterStyle.color, fontStyle: FontStyle.italic),
            softWrap: false,
            overflow: TextOverflow.clip,
          ),
        ),
        for (final line in hunk.lines)
          _unifiedLine(
            line,
            mono: mono,
            gutterStyle: gutterStyle,
            metaBg: metaBg,
            addBg: addBg,
            addGutterBg: addGutterBg,
            delBg: delBg,
            delGutterBg: delGutterBg,
            addedFg: addedFg,
            removedFg: removedFg,
          ),
      ],
    ],
  );
}

/// One split-pane line row: gutter (the pane's side), marker, text.
Widget _paneLine(
  DiffLine line, {
  required bool oldSide,
  required TextStyle mono,
  required TextStyle gutterStyle,
  required Color metaBg,
  required Color addBg,
  required Color addGutterBg,
  required Color delBg,
  required Color delGutterBg,
  required Color addedFg,
  required Color removedFg,
}) {
  final isAdd = line.kind == 'add';
  final isDel = line.kind == 'del';
  final isMeta = line.kind == 'meta';
  final rowBg = isAdd
      ? addBg
      : isDel
          ? delBg
          : isMeta
              ? metaBg
              : null;
  final gutterBg = isAdd
      ? addGutterBg
      : isDel
          ? delGutterBg
          : isMeta
              ? metaBg
              : null;
  final number = oldSide ? line.oldNo : line.newNo;
  final row = Row(
    crossAxisAlignment: CrossAxisAlignment.center,
    children: [
      _gutter(number, gutterStyle, gutterBg, 40),
      _marker(line.kind, mono, addedFg, removedFg),
      Expanded(
        child: Text(
          line.text,
          style: mono,
          softWrap: false,
          overflow: TextOverflow.clip,
        ),
      ),
    ],
  );
  return rowBg == null ? row : ColoredBox(color: rowBg, child: row);
}

/// The split body: per hunk, the header row, then the old side (`del`,
/// `ctx`, `meta`) paired against the new side (`add`, `ctx`, `meta`).
Widget _splitBody({
  required List<DiffHunk> hunks,
  required TextStyle mono,
  required TextStyle gutterStyle,
  required Color metaBg,
  required Color addBg,
  required Color addGutterBg,
  required Color delBg,
  required Color delGutterBg,
  required Color addedFg,
  required Color removedFg,
  required Color divider,
  required double gap,
}) {
  return Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      for (final hunk in hunks) ...[
        Container(
          width: double.infinity,
          color: metaBg,
          padding: EdgeInsets.symmetric(horizontal: gap, vertical: gap / 2),
          child: Text(
            hunk.header,
            style: mono.copyWith(
                color: gutterStyle.color, fontStyle: FontStyle.italic),
            softWrap: false,
            overflow: TextOverflow.clip,
          ),
        ),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final line in hunk.lines)
                    if (line.kind == 'del' ||
                        line.kind == 'ctx' ||
                        line.kind == 'meta')
                      _paneLine(
                        line,
                        oldSide: true,
                        mono: mono,
                        gutterStyle: gutterStyle,
                        metaBg: metaBg,
                        addBg: addBg,
                        addGutterBg: addGutterBg,
                        delBg: delBg,
                        delGutterBg: delGutterBg,
                        addedFg: addedFg,
                        removedFg: removedFg,
                      ),
                ],
              ),
            ),
            Container(width: 1, color: divider),
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final line in hunk.lines)
                    if (line.kind == 'add' ||
                        line.kind == 'ctx' ||
                        line.kind == 'meta')
                      _paneLine(
                        line,
                        oldSide: false,
                        mono: mono,
                        gutterStyle: gutterStyle,
                        metaBg: metaBg,
                        addBg: addBg,
                        addGutterBg: addGutterBg,
                        delBg: delBg,
                        delGutterBg: delGutterBg,
                        addedFg: addedFg,
                        removedFg: removedFg,
                      ),
                ],
              ),
            ),
          ],
        ),
      ],
    ],
  );
}
