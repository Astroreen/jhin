import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/sdui/action_dispatcher.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_state.dart';

import 'sdui_fakes.dart';

void main() {
  group('ActionDispatcherTest', () {
    late ScriptedTransport transport;
    late UiState state;
    late List<dynamic> directives;
    late bool changed;
    late UiNode root;

    UiNode makeRoot() => UiNode.fromJson({
          'type': 'container',
          'children': [
            {
              'type': 'input',
              'id': 'messageInput',
              'label': 'Message',
              'value': 'hello',
            },
            {
              'type': 'checkbox',
              'id': 'attachCheck',
              'label': 'Attach',
              'value': true,
            },
            {
              'type': 'switch',
              'id': 'streamSwitch',
              'label': 'Stream',
              'value': false,
            },
            {
              'type': 'slider',
              'id': 'tempSlider',
              'min': 0,
              'max': 2,
              'value': 1.5,
            },
            {
              'type': 'dropdown',
              'id': 'modelDropdown',
              'items': [
                {'label': 'GPT', 'value': 'gpt'},
                {'label': 'Local', 'value': 7},
              ],
              'value': 'gpt',
            },
            {
              'type': 'input',
              'id': 'emptyInput',
              'value': '',
            },
          ],
        });

    ActionDispatcher makeDispatcher() => ActionDispatcher(
          transport: transport,
          state: state,
          root: () => root,
          onChanged: () => changed = true,
          runDirectives: (list) async {
            directives.addAll(list);
          },
        );

    Map<String, dynamic> sendAction({List<String>? include}) => {
          'path': '/ui/action/send',
          'method': 'POST',
          'name': 'send',
          'payload': {'sessionId': 's1'},
          'include': [
            'messageInput',
            'attachCheck',
            'streamSwitch',
            'tempSlider',
            'modelDropdown',
            'emptyInput',
            ...?include,
          ],
        };

    setUp(() {
      transport = ScriptedTransport();
      state = UiState();
      directives = [];
      changed = false;
      root = makeRoot();
      for (final node in root.flatten()) {
        final id = node.id;
        final value = node.props['value'];
        if (id != null && value != null) state.seedValue(id, value);
      }
    });

    test('include typing produces the exact JSON body', () async {
      await makeDispatcher().dispatch(sendAction());

      expect(transport.calls, hasLength(1));
      final call = transport.calls.single;
      expect(call.method, 'POST');
      expect(call.path, '/ui/action/send');
      expect(call.body, {
        'action': 'send',
        'payload': {
          'sessionId': 's1',
          'messageInput': 'hello',
          'attachCheck': true,
          'streamSwitch': false,
          'tempSlider': 1.5,
          'modelDropdown': 'gpt',
          'emptyInput': '',
        },
      });
      final payload = (call.body as Map)['payload'] as Map;
      expect(payload['messageInput'], isA<String>());
      expect(payload['attachCheck'], isA<bool>());
      expect(payload['streamSwitch'], isA<bool>());
      expect(payload['tempSlider'], isA<double>());
      expect(payload['emptyInput'], isA<String>());
    });

    test('include values win over static payload keys', () async {
      final action = sendAction()
        ..['payload'] = {'sessionId': 's1', 'messageInput': 'stale'};
      await makeDispatcher().dispatch(action);

      final body = transport.calls.single.body as Map;
      expect((body['payload'] as Map)['messageInput'], 'hello');
    });

    test('dropdown include sends the selected item value as-is', () async {
      state.setValue('modelDropdown', 7);
      await makeDispatcher().dispatch(sendAction(include: []));

      final body = transport.calls.single.body as Map;
      expect((body['payload'] as Map)['modelDropdown'], 7);
    });

    test('required input blocks dispatch and nothing is sent', () async {
      root = UiNode.fromJson({
        'type': 'container',
        'children': [
          {
            'type': 'input',
            'id': 'messageInput',
            'required': true,
            'errorText': 'Message is required',
            'value': '',
          },
        ],
      });
      state.setValue('messageInput', '');

      await makeDispatcher().dispatch({
        'path': '/ui/action/send',
        'name': 'send',
        'include': ['messageInput'],
      });

      expect(transport.calls, isEmpty);
      expect(changed, isTrue);
      expect(state.errorFor('messageInput'), 'Message is required');
    });

    test('pattern input blocks dispatch and nothing is sent', () async {
      root = UiNode.fromJson({
        'type': 'container',
        'children': [
          {
            'type': 'input',
            'id': 'messageInput',
            'pattern': r'^\d+$',
            'errorText': 'Digits only',
          },
        ],
      });
      state.setValue('messageInput', 'abc');

      await makeDispatcher().dispatch({
        'path': '/ui/action/send',
        'name': 'send',
        'include': ['messageInput'],
      });

      expect(transport.calls, isEmpty);
      expect(state.errorFor('messageInput'), 'Digits only');
    });

    test('min/max input blocks dispatch and nothing is sent', () async {
      root = UiNode.fromJson({
        'type': 'container',
        'children': [
          {
            'type': 'input',
            'id': 'messageInput',
            'min': 10,
            'max': 20,
            'errorText': 'Out of range',
          },
        ],
      });
      state.setValue('messageInput', '5');

      await makeDispatcher().dispatch({
        'path': '/ui/action/send',
        'name': 'send',
        'include': ['messageInput'],
      });

      expect(transport.calls, isEmpty);
      expect(state.errorFor('messageInput'), 'Out of range');

      state.setValue('messageInput', '15');
      await makeDispatcher().dispatch({
        'path': '/ui/action/send',
        'name': 'send',
        'include': ['messageInput'],
      });
      expect(transport.calls, hasLength(1));
    });

    test('only included fields are validated', () async {
      root = UiNode.fromJson({
        'type': 'container',
        'children': [
          {
            'type': 'input',
            'id': 'other',
            'required': true,
            'value': '',
          },
        ],
      });
      state.setValue('other', '');

      await makeDispatcher().dispatch({
        'path': '/ui/action/send',
        'name': 'send',
        'include': ['messageInput'],
      });

      expect(transport.calls, hasLength(1));
    });

    test('successful post runs the response client directives', () async {
      transport.onPost = (path, body) => {
            'client': [
              {'op': 'toast', 'text': 'sent'},
            ],
          };

      await makeDispatcher().dispatch(sendAction());

      expect(directives, [
        {'op': 'toast', 'text': 'sent'},
      ]);
    });

    test('action without a path is ignored', () async {
      await makeDispatcher().dispatch({'name': 'send'});
      expect(transport.calls, isEmpty);
    });
  });
}
