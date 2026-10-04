import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';
import 'icon.dart';
import 'text_common.dart';

/// Shared `input` / `textarea` field (§2.6): the full TextField surface with
/// the decoration group on top. `textarea` is the same field with
/// `multiline` defaulting to `true`.
///
/// Every change lands in the screen's `UiState` under `id` (§8.4); the
/// `required`/`min`/`max`/`pattern` rules are enforced by the
/// `ActionDispatcher` before an action fires, and the dispatcher's failure
/// text (the node's `errorText`) is shown inline. A missing `id` degrades
/// to a visible placeholder. Unknown enum literals degrade to the prop's
/// default (§2.4) — never throws.
Widget buildInputField(BuildContext context, UiNode node, RenderContext ctx) {
  if (node.id == null) {
    return degradedBox(context, 'Missing id');
  }
  return _InputField(node: node, ctx: ctx);
}

class _InputField extends StatefulWidget {
  const _InputField({required this.node, required this.ctx});

  final UiNode node;
  final RenderContext ctx;

  @override
  State<_InputField> createState() => _InputFieldState();
}

class _InputFieldState extends State<_InputField> {
  late final TextEditingController _controller;
  late final FocusNode _focusNode;

  String get _id => widget.node.id ?? '';

  @override
  void initState() {
    super.initState();
    final initial = fieldValue(widget.ctx, widget.node);
    _controller = TextEditingController(text: initial?.toString() ?? '');
    _focusNode = FocusNode(debugLabel: 'jhin-input-$_id');
    _focusNode.addListener(_editingChanged);
  }

  void _editingChanged() {
    final action = asMap(widget.node.props['onEditingChanged']);
    if (action != null) widget.ctx.dispatch(action);
  }

  @override
  void didUpdateWidget(_InputField old) {
    super.didUpdateWidget(old);
    final current = widget.ctx.state[_id]?.toString() ?? '';
    if (current != _controller.text) {
      _controller.text = current;
    }
  }

  @override
  void dispose() {
    _focusNode.removeListener(_editingChanged);
    _focusNode.dispose();
    _controller.dispose();
    super.dispose();
  }

  void _changed(BuildContext context, String value) {
    final node = widget.node;
    final ctx = widget.ctx;
    final previous = ctx.state[_id]?.toString() ?? '';
    ctx.setState(_id, value);
    if (value.length > previous.length) {
      final appended = asMap(node.props['onAppended']);
      if (appended != null) ctx.dispatch(appended);
    } else if (value.length < previous.length) {
      final removed = asMap(node.props['onRemoved']);
      if (removed != null) ctx.dispatch(removed);
    }
  }

  @override
  Widget build(BuildContext context) {
    final node = widget.node;
    final multilineDefault = node.type == 'textarea';
    final multiline = node.boolProp('multiline') ?? multilineDefault;
    final obscure = node.boolProp('obscure') == true;
    final expands = node.boolProp('expands') == true;
    var minLines = node.numProp('minLines')?.round();
    var maxLines = node.numProp('maxLines')?.round();
    if (expands) {
      minLines = null;
      maxLines = null;
    } else if (obscure) {
      minLines = null;
      maxLines = 1;
    } else {
      maxLines ??= multiline ? 5 : 1;
      if (minLines != null && maxLines < minLines) {
        maxLines = minLines;
      }
    }
    final explicitKeyboard = keyboardTypeOf(
        node.stringProp('keyboardType') ?? node.stringProp('keyboard'));
    final multilineInput = multiline || expands || (maxLines ?? 1) > 1;
    final obscuring = node.stringProp('obscuringCharacter');
    return TextField(
      controller: _controller,
      focusNode: _focusNode,
      obscureText: obscure,
      obscuringCharacter:
          obscuring != null && obscuring.length == 1 ? obscuring : '•',
      keyboardType: explicitKeyboard ??
          (multilineInput ? TextInputType.multiline : TextInputType.text),
      textInputAction: textInputActionOf(node.stringProp('textInputAction')),
        textCapitalization:
            textCapitalizationOf(node.stringProp('textCapitalization')),
        maxLength: node.numProp('maxLength')?.round(),
        maxLengthEnforcement:
            maxLengthEnforcementOf(node.stringProp('maxLengthEnforcement')),
        minLines: minLines,
        maxLines: maxLines,
        expands: expands,
        autocorrect: node.boolProp('autocorrect') ?? true,
        enableSuggestions: node.boolProp('enableSuggestions') ?? true,
        enableInteractiveSelection:
            node.boolProp('enableInteractiveSelection'),
        readOnly: node.boolProp('readOnly') == true,
        showCursor: node.boolProp('showCursor'),
        autofocus: node.boolProp('autofocus') == true,
        cursorWidth: node.numProp('cursorWidth')?.toDouble() ?? 2.0,
        cursorHeight: node.numProp('cursorHeight')?.toDouble(),
        cursorRadius: _radius(node.numProp('cursorRadius')),
        cursorColor: parseColor(node.props['cursorColor']),
        mouseCursor:
            parseMouseCursor(node.stringProp('mouseCursor')) ?? MouseCursor.defer,
        textAlign: textAlignOf(node.stringProp('textAlign')),
        textDirection: textDirectionOf(node.stringProp('textDirection')),
        scrollPadding:
            parsePadding(node.props['scrollPadding']) ?? const EdgeInsets.all(20),
        restorationId: node.stringProp('restorationId'),
        smartDashesType: _smartDashes(node.boolProp('smartDashesType')),
        smartQuotesType: _smartQuotes(node.boolProp('smartQuotesType')),
        // ignore: deprecated_member_use
        toolbarOptions: toolbarOptionsOf(asMap(node.props['toolbarOptions'])),
        style: parseTextStyleMap(node.props['style']),
        decoration: inputDecoration(context, widget.ctx, node),
        onChanged: (value) => _changed(context, value),
    );
  }
}

Radius? _radius(num? value) =>
    value == null ? null : Radius.circular(value.toDouble());

SmartDashesType? _smartDashes(bool? value) =>
    value == null ? null : (value ? SmartDashesType.enabled : SmartDashesType.disabled);

SmartQuotesType? _smartQuotes(bool? value) =>
    value == null ? null : (value ? SmartQuotesType.enabled : SmartQuotesType.disabled);

/// The `keyboardType`/legacy `keyboard` literal set (§2.6); unknown literals
/// degrade to the default text keyboard.
TextInputType? keyboardTypeOf(String? name) {
  switch (name) {
    case 'number':
      return TextInputType.number;
    case 'phone':
      return TextInputType.phone;
    case 'email':
      return TextInputType.emailAddress;
    case 'url':
      return TextInputType.url;
    case 'visiblePassword':
      return TextInputType.visiblePassword;
    case 'multiline':
      return TextInputType.multiline;
    case 'text':
      return TextInputType.text;
  }
  return null;
}

/// The `textInputAction` IME literal set (§2.6); unknown literals degrade to
/// the platform default.
TextInputAction? textInputActionOf(String? name) {
  switch (name) {
    case 'none':
      return TextInputAction.none;
    case 'unspecified':
      return TextInputAction.unspecified;
    case 'done':
      return TextInputAction.done;
    case 'go':
      return TextInputAction.go;
    case 'next':
      return TextInputAction.next;
    case 'previous':
      return TextInputAction.previous;
    case 'search':
      return TextInputAction.search;
    case 'send':
      return TextInputAction.send;
    case 'newline':
      return TextInputAction.newline;
    case 'continueAction':
      return TextInputAction.continueAction;
    case 'join':
      return TextInputAction.join;
    case 'route':
      return TextInputAction.route;
  }
  return null;
}

/// The `textCapitalization` literal set (§2.6); unknown literals degrade to
/// `none`.
TextCapitalization textCapitalizationOf(String? name) {
  switch (name) {
    case 'words':
      return TextCapitalization.words;
    case 'sentences':
      return TextCapitalization.sentences;
    case 'characters':
      return TextCapitalization.characters;
  }
  return TextCapitalization.none;
}

/// The `maxLengthEnforcement` literal set (§2.6); unknown literals degrade to
/// the Flutter default.
MaxLengthEnforcement? maxLengthEnforcementOf(String? name) {
  switch (name) {
    case 'none':
      return MaxLengthEnforcement.none;
    case 'enforced':
      return MaxLengthEnforcement.enforced;
    case 'truncateAfterCompositionEnds':
      return MaxLengthEnforcement.truncateAfterCompositionEnds;
  }
  return null;
}

/// The `floatingLabelBehavior` literal set (§2.6); unknown literals degrade
/// to `auto`.
FloatingLabelBehavior floatingLabelBehaviorOf(String? name) {
  switch (name) {
    case 'never':
      return FloatingLabelBehavior.never;
    case 'always':
      return FloatingLabelBehavior.always;
  }
  return FloatingLabelBehavior.auto;
}

/// The `textAlign` literal set (§2.6); unknown literals degrade to `start`.
TextAlign textAlignOf(String? name) {
  switch (name) {
    case 'left':
      return TextAlign.left;
    case 'right':
      return TextAlign.right;
    case 'center':
      return TextAlign.center;
    case 'justify':
      return TextAlign.justify;
    case 'end':
      return TextAlign.end;
  }
  return TextAlign.start;
}

/// The `ltr`/`rtl` literal set (§2.6); unknown literals degrade to the
/// ambient direction.
TextDirection? textDirectionOf(String? name) {
  switch (name) {
    case 'ltr':
      return TextDirection.ltr;
    case 'rtl':
      return TextDirection.rtl;
  }
  return null;
}

/// The `toolbarOptions` map (§2.6): `{copy, cut, paste, selectAll}` bools.
// ignore: deprecated_member_use
ToolbarOptions? toolbarOptionsOf(Map<String, dynamic>? map) {
  if (map == null) return null;
  bool flag(String key, bool fallback) {
    final value = map[key];
    return value is bool ? value : fallback;
  }

  // ignore: deprecated_member_use
  return ToolbarOptions(
    copy: flag('copy', true),
    cut: flag('cut', true),
    paste: flag('paste', true),
    selectAll: flag('selectAll', true),
  );
}

/// The `border` spec (§2.6): `underline`/`outline`/`none` or a
/// `{style?, width?, radius?, color?}` map. Unknown literals and malformed
/// specs degrade to the underline default (§2.4).
InputBorder inputBorderOf(Object? value) {
  var style = 'underline';
  double? width;
  double? radius;
  Color? color;
  if (value is String) {
    style = value;
  } else if (value is Map) {
    final raw = asMap(value);
    if (raw != null) {
      final rawStyle = raw['style'];
      if (rawStyle is String) style = rawStyle;
      final rawWidth = raw['width'];
      if (rawWidth is num) width = rawWidth.toDouble();
      final rawRadius = raw['radius'];
      if (rawRadius is num) radius = rawRadius.toDouble();
      color = parseColor(raw['color']);
    }
  } else {
    return const UnderlineInputBorder();
  }
  switch (style) {
    case 'none':
      return InputBorder.none;
    case 'outline':
      return OutlineInputBorder(
        borderRadius:
            radius == null ? const BorderRadius.all(Radius.circular(4)) : BorderRadius.circular(radius),
        borderSide: BorderSide(
          width: width ?? 1.0,
          color: color ?? const Color(0xFF000000),
        ),
      );
    case 'underline':
      return UnderlineInputBorder(
        borderSide: BorderSide(
          width: width ?? 1.0,
          color: color ?? const Color(0xFF000000),
        ),
      );
  }
  return const UnderlineInputBorder();
}

/// Builds the field's `InputDecoration` (§2.6): the `decoration` map first
/// (the full InputDecoration surface), then the flattened keys on top —
/// they win when both are present.
InputDecoration inputDecoration(
  BuildContext context,
  RenderContext ctx,
  UiNode node,
) {
  final map = asMap(node.props['decoration']) ?? const <String, dynamic>{};
  Object? prop(String key) => node.props[key] ?? map[key];

  Widget? iconOf(Object? value) {
    if (value == null) return null;
    if (value is Map) return ctx.build(context, UiNode.fromJson(value));
    return buildIconValue(context, ctx, value);
  }

  return InputDecoration(
    labelText: (prop('labelText') ?? node.stringProp('label')) as String?,
    hintText: (prop('hintText') ?? node.stringProp('placeholder')) as String?,
    helperText: prop('helperText') as String?,
    errorText: ctx.state.errorFor(node.id ?? '') ??
        (map['errorText'] is String ? map['errorText'] as String : null),
    counterText: prop('counterText') as String?,
    semanticCounterText: prop('semanticCounterText') as String?,
    prefixText: prop('prefix') as String?,
    suffixText: prop('suffix') as String?,
    prefixIcon: iconOf(prop('prefixIcon')),
    suffixIcon: iconOf(prop('suffixIcon')),
    icon: iconOf(prop('icon')),
    filled: prop('filled') as bool?,
    fillColor: parseColor(prop('fillColor')),
    hoverColor: parseColor(prop('hoverColor')),
    focusColor: parseColor(prop('focusColor')),
    floatingLabelBehavior: floatingLabelBehaviorOf(prop('floatingLabelBehavior') as String?),
    border: _borderOrNull(prop('border')),
    enabledBorder: _borderOrNull(prop('enabledBorder')),
    focusedBorder: _borderOrNull(prop('focusedBorder')),
    errorBorder: _borderOrNull(prop('errorBorder')),
    focusedErrorBorder: _borderOrNull(prop('focusedErrorBorder')),
    disabledBorder: _borderOrNull(prop('disabledBorder')),
    contentPadding: parsePadding(prop('contentPadding')),
    isDense: prop('isDense') as bool? ?? prop('dense') as bool?,
    isCollapsed: prop('isCollapsed') as bool?,
    alignLabelWithHint: prop('alignLabelWithHint') as bool?,
    constraints: _constraintsOf(asMap(prop('constraints'))),
    helperStyle: parseTextStyleMap(prop('helperStyle')),
    hintStyle: parseTextStyleMap(prop('hintStyle')),
    labelStyle: parseTextStyleMap(prop('labelStyle')),
    counterStyle: parseTextStyleMap(prop('counterStyle')),
    prefixStyle: parseTextStyleMap(prop('prefixStyle')),
    suffixStyle: parseTextStyleMap(prop('suffixStyle')),
    errorStyle: parseTextStyleMap(prop('errorStyle')),
  );
}

InputBorder? _borderOrNull(Object? value) =>
    value == null ? null : inputBorderOf(value);

BoxConstraints? _constraintsOf(Map<String, dynamic>? map) {
  if (map == null) return null;
  double numOrInfinite(Object? value, double fallback) {
    if (value is num) return value.toDouble();
    return fallback;
  }

  return BoxConstraints(
    minWidth: numOrInfinite(map['minWidth'], 0),
    maxWidth: numOrInfinite(map['maxWidth'], double.infinity),
    minHeight: numOrInfinite(map['minHeight'], 0),
    maxHeight: numOrInfinite(map['maxHeight'], double.infinity),
  );
}
