import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/store/versioned_store.dart';

void main() {
  group('StoredValue envelope', () {
    test('encode/decode round-trips a map payload', () {
      final raw = encodeStoredValue(
        schema: 3,
        app: '0.1.0',
        data: {'profiles': [
          {'id': 'home', 'url': 'https://jhin.example.org'}
        ], 'activeProfileId': 'home'},
      );

      final stored = decodeStoredValue(raw)!;
      expect(stored.hasEnvelope, isTrue);
      expect(stored.schema, 3);
      expect(stored.app, '0.1.0');
      expect(stored.data, {
        'profiles': [
          {'id': 'home', 'url': 'https://jhin.example.org'}
        ],
        'activeProfileId': 'home',
      });
      // writtenAt is a valid ISO-8601 UTC timestamp.
      expect(DateTime.parse(stored.writtenAt).isUtc, isTrue);
    });

    test('encode/decode round-trips list, string and null payloads', () {
      for (final data in [
        <Object>['a', 'b'],
        'bare-string',
        42,
        null,
      ]) {
        final stored = decodeStoredValue(
            encodeStoredValue(schema: 3, app: '0.1.0', data: data))!;
        expect(stored.hasEnvelope, isTrue);
        expect(stored.schema, 3);
        expect(stored.data, data);
      }
    });

    test('a JSON array without an envelope is legacy schema 1', () {
      final raw = jsonEncode([
        {'id': 'legacy-1', 'label': 'Home', 'url': 'https://jhin.example.org'}
      ]);
      final stored = decodeStoredValue(raw)!;
      expect(stored.hasEnvelope, isFalse);
      expect(stored.schema, 1);
      expect(stored.data, isA<List>());
      expect((stored.data as List).single['id'], 'legacy-1');
    });

    test('a non-JSON raw string is legacy schema 1 carrying the raw value', () {
      final stored = decodeStoredValue('legacy-1')!;
      expect(stored.hasEnvelope, isFalse);
      expect(stored.schema, 1);
      expect(stored.data, 'legacy-1');
    });

    test('a JSON object without schema/data is legacy schema 1', () {
      final stored = decodeStoredValue('{"mode":"dark"}')!;
      expect(stored.hasEnvelope, isFalse);
      expect(stored.schema, 1);
      expect(stored.data, {'mode': 'dark'});
    });

    test('malformed JSON never throws and degrades to legacy', () {
      for (final raw in ['{not json', '{"schema":"x","data":{}}', '[', '']) {
        final stored = decodeStoredValue(raw);
        if (raw.isEmpty) {
          expect(stored, isNull); // empty = key absent
          continue;
        }
        expect(stored, isNotNull);
        expect(stored!.hasEnvelope, isFalse);
        expect(stored.schema, 1);
      }
    });

    test('null means the key is absent', () {
      expect(decodeStoredValue(null), isNull);
    });

    test('an envelope with a non-int schema degrades to legacy', () {
      final stored =
          decodeStoredValue('{"schema":"3","app":"0.1.0","data":{}}')!;
      expect(stored.hasEnvelope, isFalse);
      expect(stored.schema, 1);
    });
  });

  group('StoreKeys', () {
    test('bookkeeping keys are recognized', () {
      expect(StoreKeys.isBookkeeping('migration.quarantine'), isTrue);
      expect(StoreKeys.isBookkeeping('migration.backup:jhin.profiles'), isTrue);
      expect(
          StoreKeys.isBookkeeping('migration.quarantine:jhin.profiles:9'),
          isTrue);
      expect(StoreKeys.isBookkeeping('jhin.profiles'), isFalse);
      expect(StoreKeys.isBookkeeping('appearance'), isFalse);
    });

    test('quarantine copy keys carry the schema', () {
      expect(StoreKeys.quarantineCopy('jhin.profiles', 9),
          'migration.quarantine:jhin.profiles:9');
      expect(StoreKeys.backup('appearance'), 'migration.backup:appearance');
      expect(StoreKeys.sessionState('p1'), 'sessionState:p1');
    });
  });
}
