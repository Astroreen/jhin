import 'package:flutter/foundation.dart';

import '../api/api_client.dart';

/// Описание тула из UI-манифеста (`GET /ui/manifest`, T32).
class ToolInfo {
  const ToolInfo({required this.name, required this.description});

  factory ToolInfo.fromJson(Map<String, dynamic> json) => ToolInfo(
        name: json['name'] as String? ?? '',
        description: json['description'] as String? ?? '',
      );

  final String name;
  final String description;
}

/// UI-манифест hub'а: тулы (name + description) + SDUI-примитивы + версия.
/// Форма ответа — см. `UiManifestController` на backend'е.
class Manifest {
  const Manifest({
    required this.tools,
    required this.primitives,
    required this.version,
  });

  factory Manifest.fromJson(Map<String, dynamic> json) {
    final toolsJson = json['tools'];
    final primitivesJson = json['primitives'];
    return Manifest(
      tools: toolsJson is List
          ? [
              for (final item in toolsJson)
                if (item is Map<String, dynamic>) ToolInfo.fromJson(item),
            ]
          : const [],
      primitives: primitivesJson is List
          ? [for (final item in primitivesJson) if (item is String) item]
          : const [],
      version: json['version'] as String? ?? '',
    );
  }

  final List<ToolInfo> tools;
  final List<String> primitives;
  final String version;
}

/// ManifestStore: nullable-манифест UI (T32).
///
/// [refresh] перечитывает `GET /ui/manifest` через [ApiClient.getUiManifest]:
/// null/401/404/ошибка → [manifest] = null, исключения не вылетают. Повторный
/// refresh обновляет данные (например, после добавления плагина — новый тул
/// появляется в [Manifest.tools]).
class ManifestStore extends ChangeNotifier {
  ManifestStore({required this.api});

  final ApiClient api;

  /// Манифест или null (нет/старый backend, ошибка, 401/404).
  Manifest? manifest;

  /// Загружен ли сейчас валидный манифест.
  bool get isLoaded => manifest != null;

  /// Перечитывает манифест. Никогда не бросает исключений.
  Future<void> refresh() async {
    Map<String, dynamic>? json;
    try {
      json = await api.getUiManifest();
    } on Exception {
      json = null;
    }
    updateFrom(json);
  }

  /// Кладёт манифест из уже полученного JSON (null → очистить).
  void updateFrom(Map<String, dynamic>? json) {
    manifest = json == null ? null : Manifest.fromJson(json);
    notifyListeners();
  }
}
