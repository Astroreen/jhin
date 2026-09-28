import 'dart:convert';

/// Одно событие `text/event-stream`.
///
/// [id] — seq события (`id:` фрейм; null, если строки id не было);
/// [type] — имя события (`event:`, дефолт `message`); [data] — payload
/// `data:` (склейка нескольких data-строк через `\n`) как JSON-объект
/// (null, если не JSON-объект или пустой).
class SseEvent {
  const SseEvent({required this.id, required this.type, required this.data});

  final int? id;
  final String type;
  final Map<String, dynamic>? data;

  @override
  String toString() => 'SseEvent(id: $id, type: $type, data: $data)';

  @override
  bool operator ==(Object other) =>
      other is SseEvent &&
      other.id == id &&
      other.type == type &&
      _mapEquals(other.data, data);

  @override
  int get hashCode => Object.hash(id, type, data?.length);

  static bool _mapEquals(Map<String, dynamic>? a, Map<String, dynamic>? b) {
    if (identical(a, b)) {
      return true;
    }
    if (a == null || b == null || a.length != b.length) {
      return false;
    }
    for (final entry in a.entries) {
      if (b[entry.key] != entry.value) {
        return false;
      }
    }
    return true;
  }
}

/// Чистый парсер `text/event-stream` (без IO).
///
/// Кормить построчно ([addLine]) или чанками декодированного текста
/// ([addChunk], умеет резать фреймы по границам чанков). Blank line — конец
/// события; `: comment` (heartbeat `: keepalive`) игнорируется; неизвестные
/// поля и кривые значения игнорируются юзательски (никогда не бросает).
///
/// Формат фрейма (backend): `id: <seq>\nevent: <type>\nevent: <type>\ndata: <json>\n\n`.
class SseParser {
  String _buffer = '';
  int? _id;
  String? _type;
  String? _data;

  /// Разбирает одну строку без завершающего перевода строки.
  ///
  /// Возвращает событие, если строка закрыла фрейм (blank line), иначе null.
  SseEvent? addLine(String line) {
    if (line.isEmpty) {
      return _dispatch();
    }
    if (line.startsWith(':')) {
      return null;
    }
    final colon = line.indexOf(':');
    final String field;
    var value = '';
    if (colon < 0) {
      field = line;
    } else {
      field = line.substring(0, colon);
      value = line.substring(colon + 1);
      if (value.startsWith(' ')) {
        value = value.substring(1);
      }
    }
    switch (field) {
      case 'id':
        if (value.contains('\u0000')) {
          break;
        }
        if (value.isEmpty) {
          _id = null;
          break;
        }
        final parsed = int.tryParse(value);
        if (parsed != null) {
          _id = parsed;
        }
      case 'event':
        _type = value;
      case 'data':
        _data = (_data == null) ? value : '$_data\n$value';
      default:
        break;
    }
    return null;
  }

  /// Кормит чанк декодированного текста; возвращает события, закрытые в нём.
  ///
  /// Неполная последняя строка (и висящий `\r` на границе чанка) остаётся в
  /// буфере до следующего чанка/закрытия.
  List<SseEvent> addChunk(String chunk) {
    _buffer += chunk;
    final events = <SseEvent>[];
    while (true) {
      final index = _indexOfTerminator(_buffer);
      if (index < 0) {
        break;
      }
      var skip = 1;
      if (_buffer.codeUnitAt(index) == 0x0D) {
        // `\r` в конце буфера может оказаться половиной `\r\n` — ждём чанк.
        if (index + 1 >= _buffer.length) {
          break;
        }
        if (_buffer[index + 1] == '\n') {
          skip = 2;
        }
      }
      final line = _buffer.substring(0, index);
      _buffer = _buffer.substring(index + skip);
      final event = addLine(line);
      if (event != null) {
        events.add(event);
      }
    }
    return events;
  }

  /// Дозакрывает поток: добирает последнюю строку без перевода строки и
  /// незакрытый фрейм (backend всегда закрывает фреймы blank line'ом — на
  /// практике не требуется, API симметрично addChunk).
  SseEvent? flush() {
    if (_buffer.isNotEmpty) {
      var line = _buffer;
      _buffer = '';
      if (line.endsWith('\r')) {
        line = line.substring(0, line.length - 1);
      }
      final event = addLine(line);
      if (event != null) {
        return event;
      }
    }
    return _dispatch();
  }

  static int _indexOfTerminator(String text) {
    var best = -1;
    for (final unit in const [0x0A, 0x0D]) {
      final index = text.indexOf(String.fromCharCode(unit));
      if (index >= 0 && (best < 0 || index < best)) {
        best = index;
      }
    }
    return best;
  }

  SseEvent? _dispatch() {
    final data = _data;
    final id = _id;
    final rawType = _type;
    _data = null;
    _id = null;
    _type = null;
    if (data == null) {
      // Спека SSE: без data-полей событие не диспатчится.
      return null;
    }
    final type = (rawType == null || rawType.isEmpty) ? 'message' : rawType;
    return SseEvent(id: id, type: type, data: _decode(data));
  }

  static Map<String, dynamic>? _decode(String data) {
    if (data.isEmpty) {
      return null;
    }
    try {
      final decoded = jsonDecode(data);
      return decoded is Map<String, dynamic> ? decoded : null;
    } on FormatException {
      return null;
    }
  }
}
