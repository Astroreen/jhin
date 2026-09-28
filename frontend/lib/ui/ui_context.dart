import 'ui_registry.dart';

/// Колбэк UI-действия: `action` + `payload` (JSON-объект или null).
///
/// Реализация на экранах зовёт `api.sendUiAction(sessionId, UiAction(...))`,
/// backend публикует событие `ui` в event log сессии.
typedef UiActionCallback = void Function(
  String action,
  Map<String, dynamic>? payload,
);

/// Контекст рендера SDUI-дерева.
///
/// [sessionId] — сессия, которой принадлежит UI (для ui-action вызовов).
/// [onAction] — колбэк кнопок/форм/дропдаунов.
/// [registry] — реестр для рекурсии `children` (ядро биндит его само;
/// снаружи обычно null → используется defaultUiRegistry).
class UiContext {
  UiContext({
    required this.sessionId,
    required this.onAction,
    this.registry,
  });

  final String sessionId;
  final UiActionCallback onAction;
  final UiRegistry? registry;

  /// Копия контекста с привязанным реестром (рекурсия в том же реестре).
  UiContext withRegistry(UiRegistry registry) => UiContext(
        sessionId: sessionId,
        onAction: onAction,
        registry: registry,
      );
}
