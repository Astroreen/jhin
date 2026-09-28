import 'package:flutter/widgets.dart';

import 'primitives/primitive_helpers.dart';
import 'primitives/unknown_primitive.dart';
import 'ui_context.dart';

/// Строитель SDUI-примитива: JSON-узел + контекст → Widget.
typedef UiBuilder = Widget Function(
  Map<String, dynamic> json,
  UiContext ctx,
);

/// Реестр SDUI-примитивов: `type` → [UiBuilder].
///
/// Каждый примитив регистрируется сюда (философия Jhin: каждая фича —
/// точка расширения; плагин может дозарегистрировать свои типы через
/// [register]). Любой сбой внутри билдера — мягкий деград, не exception.
class UiRegistry {
  UiRegistry();

  final Map<String, UiBuilder> _builders = {};

  /// Регистрирует билдер для JSON-типа [type] (перезаписывает существующий).
  void register(String type, UiBuilder builder) {
    _builders[type] = builder;
  }

  /// Есть ли билдер для типа.
  bool supports(String type) => _builders.containsKey(type);

  /// Зарегистрированные типы (порядок регистрации; пригодится для /ui/manifest).
  List<String> supportedPrimitives() => _builders.keys.toList(growable: false);

  /// Диспетчеризация: неизвестный type → карточка-заглушка, сбой билдера →
  /// пустой виджет. Рекурсия `children` идёт через этот же реестр.
  Widget build(Map<String, dynamic> json, UiContext ctx) {
    final bound = identical(ctx.registry, this) ? ctx : ctx.withRegistry(this);
    final type = asString(json['type']) ?? '';
    final builder = _builders[type];
    if (builder == null) {
      return buildUnsupported(json, bound);
    }
    try {
      return builder(json, bound);
    } catch (_) {
      return const SizedBox.shrink();
    }
  }
}
