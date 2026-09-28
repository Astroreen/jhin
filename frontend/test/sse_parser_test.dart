import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/sse/sse_parser.dart';

void main() {
  group('SseParser.addLine', () {
    test('фрейминг id/event/data', () {
      final parser = SseParser();
      expect(parser.addLine('id: 7'), isNull);
      expect(parser.addLine('event: text_delta'), isNull);
      expect(parser.addLine('data: {"runId":"r1","text":"hi"}'), isNull);
      final event = parser.addLine('');
      expect(event, isNotNull);
      expect(event!.id, 7);
      expect(event.type, 'text_delta');
      expect(event.data, {'runId': 'r1', 'text': 'hi'});
    });

    test('несколько data-строк склеиваются через \\n', () {
      final parser = SseParser();
      parser.addLine('id: 1');
      parser.addLine('event: message_end');
      parser.addLine('data: {"runId":"r",');
      parser.addLine('data: "text":"a"}');
      final event = parser.addLine('');
      expect(event, isNotNull);
      expect(event!.data, {'runId': 'r', 'text': 'a'});
    });

    test('комментарии и keepalive игнорируются', () {
      final parser = SseParser();
      expect(parser.addLine(': keepalive'), isNull);
      expect(parser.addLine(':'), isNull);
      parser.addLine('id: 2');
      parser.addLine('event: run_end');
      parser.addLine('data: {"runId":"r","status":"DONE"}');
      expect(parser.addLine(': keepalive'), isNull);
      final event = parser.addLine('');
      expect(event!.id, 2);
      expect(event.type, 'run_end');
      expect(event.data, {'runId': 'r', 'status': 'DONE'});
    });

    test('отсутствие id → id=null, отсутствие event → type=message', () {
      final parser = SseParser();
      parser.addLine('data: {"text":"solo"}');
      final event = parser.addLine('');
      expect(event!.id, isNull);
      expect(event.type, 'message');
      expect(event.data, {'text': 'solo'});
    });

    test('пустая строка без полей не диспатчит событие', () {
      final parser = SseParser();
      expect(parser.addLine(''), isNull);
      expect(parser.addLine(''), isNull);
    });

    test('data: с пустым значением → событие с data=null', () {
      final parser = SseParser();
      parser.addLine('event: ui');
      parser.addLine('data:');
      final event = parser.addLine('');
      expect(event, isNotNull);
      expect(event!.type, 'ui');
      expect(event.data, isNull);
    });

    test('невалидный JSON в data → data=null, событие живо', () {
      final parser = SseParser();
      parser.addLine('event: error');
      parser.addLine('data: not json at all');
      final event = parser.addLine('');
      expect(event!.type, 'error');
      expect(event.data, isNull);
    });

    test('кривые строки игнорируются юзательски (не падаем)', () {
      final parser = SseParser();
      parser.addLine('garbage without colon');
      parser.addLine('id: not-a-number');
      parser.addLine('retry: oops');
      parser.addLine('id: 4');
      parser.addLine('weird: value');
      parser.addLine('event: user_message');
      parser.addLine('data: {"text":"ok"}');
      final event = parser.addLine('');
      expect(event!.id, 4);
      expect(event.data, {'text': 'ok'});
    });

    test('id с NUL игнорируется', () {
      final parser = SseParser();
      parser.addLine('id: 5');
      parser.addLine('id: 6\u00006');
      parser.addLine('data: {"a":1}');
      expect(parser.addLine('')!.id, 5);
    });
  });

  group('SseParser.addChunk', () {
    test('фрейм целиком в одном чанке', () {
      final parser = SseParser();
      final events =
          parser.addChunk('id: 1\nevent: run_start\ndata: {"runId":"r"}\n\n');
      expect(events, hasLength(1));
      expect(events.single.id, 1);
      expect(events.single.type, 'run_start');
      expect(events.single.data, {'runId': 'r'});
    });

    test('фрейм на границе чанков (обрезка строки)', () {
      final parser = SseParser();
      expect(parser.addChunk('id: 10\nevent: text_del'), isEmpty);
      expect(parser.addChunk('ta\ndata: {"te'), isEmpty);
      final events = parser.addChunk('xt":"x"}\n\n');
      expect(events, hasLength(1));
      expect(events.single.id, 10);
      expect(events.single.data, {'text': 'x'});
    });

    test('\\r\\n на границе чанков не рвёт строку', () {
      final parser = SseParser();
      expect(parser.addChunk('id: 3\r'), isEmpty);
      expect(parser.addChunk('\ndata: {"a":1}\r'), isEmpty);
      final events = parser.addChunk('\n\n');
      expect(events, hasLength(1));
      expect(events.single.id, 3);
      expect(events.single.data, {'a': 1});
    });

    test('несколько событий в чанке + keepalive', () {
      final parser = SseParser();
      final events = parser.addChunk(
          'id: 1\nevent: a\ndata: {"n":1}\n\n: keepalive\n\n'
          'id: 2\nevent: b\ndata: {"n":2}\n\n');
      expect(events, hasLength(2));
      expect(events[0].id, 1);
      expect(events[1].id, 2);
    });

    test('flush добирает хвост без blank line', () {
      final parser = SseParser();
      parser.addChunk('id: 9\nevent: run_end\ndata: {"runId":"r"}');
      final event = parser.flush();
      expect(event, isNotNull);
      expect(event!.id, 9);
      expect(event.type, 'run_end');
    });
  });
}
