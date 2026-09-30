import 'dart:convert';

/// One `text/event-stream` frame.
///
/// [id] — event id (`id:` frame; null when absent); [type] — event name
/// (`event:`, defaults to `message`); [data] — the `data:` payload (several
/// `data:` lines joined with `\n`) decoded as a JSON object (null when the
/// payload is empty or not a JSON object).
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

/// Pure `text/event-stream` parser (no IO).
///
/// Feed it lines ([addLine]) or decoded text chunks ([addChunk], splits frames
/// across chunk boundaries). A blank line dispatches the event; `: comment`
/// (heartbeat `: keepalive`) is ignored; unknown fields and malformed values
/// are ignored leniently (never throws).
///
/// Backend frame format: `id: <seq>\nevent: <type>\ndata: <json>\n\n`.
class SseParser {
  String _buffer = '';
  int? _id;
  String? _type;
  String? _data;

  /// Parses one line without its trailing newline.
  ///
  /// Returns the event when the line closes a frame (blank line), else null.
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

  /// Feeds a chunk of decoded text; returns the events it closed.
  ///
  /// An incomplete trailing line (and a dangling `\r` on a chunk boundary)
  /// stays buffered until the next chunk or [flush].
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
        // A `\r` at the end of the buffer may be half of `\r\n` — wait.
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

  /// Closes the stream: picks up a final line without a newline and any
  /// unclosed frame (the backend always ends frames with a blank line, so in
  /// practice this is rarely needed; the API mirrors [addChunk]).
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
      // SSE spec: an event without data fields is not dispatched.
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