import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `input` (§8.3): `id`, `label?`, `value?`, `placeholder?`, `multiline?`,
/// `obscure?`, `keyboard?`, `required?`, `min?`, `max?`, `pattern?`,
/// `errorText?`.
///
/// Writes every change into the screen's `UiState` under `id` (§8.4); the
/// `required`/`min`/`max`/`pattern` rules are enforced by the
/// `ActionDispatcher` before an action fires, and the dispatcher's failure
/// text (the node's `errorText`) is shown inline. A missing `id` degrades
/// to a visible placeholder.
Widget buildInput(BuildContext context, UiNode node, RenderContext ctx) {
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

  String get _id => widget.node.id ?? '';

  @override
  void initState() {
    super.initState();
    final initial = fieldValue(widget.ctx, widget.node);
    _controller = TextEditingController(text: initial?.toString() ?? '');
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
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final node = widget.node;
    final multiline = node.boolProp('multiline') == true;
    return TextField(
      controller: _controller,
      obscureText: node.boolProp('obscure') == true,
      maxLines: multiline ? 5 : 1,
      keyboardType:
          multiline ? TextInputType.multiline : _keyboard(node.stringProp('keyboard')),
      decoration: InputDecoration(
        labelText: node.stringProp('label'),
        hintText: node.stringProp('placeholder'),
        errorText: widget.ctx.state.errorFor(_id),
      ),
      onChanged: (value) => widget.ctx.setState(_id, value),
    );
  }

  static TextInputType _keyboard(String? name) {
    switch (name) {
      case 'number':
        return TextInputType.number;
      case 'email':
        return TextInputType.emailAddress;
      case 'phone':
        return TextInputType.phone;
      case 'url':
        return TextInputType.url;
    }
    return TextInputType.text;
  }
}
