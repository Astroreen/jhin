import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:provider/provider.dart';

import '../core/api/api_client.dart';
import '../core/state/session_store.dart';
import '../widgets/structured_content.dart';

/// Экран чата сессии: лента view-model сообщений + live SSE.
///
/// Appbar: title + статус run + Cancel (при активном run) + overflow (удалить).
/// Лента: user — вправо/подложка; assistant — markdown; tool — карточка
/// (свёрнутая: toolName + статус + первая строка; тело: arguments/content/
/// structured → [buildStructured] — T30 ExtensionPoint).
/// Внизу: multiline TextField (Enter=send, Shift+Enter=перенос) + Send.
class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key, required this.session});

  final SessionInfo session;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _inputController = TextEditingController();
  final _scrollController = ScrollController();
  int _lastMessageCount = 0;
  SessionStore? _store;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _store ??= context.read<SessionStore>();
  }

  @override
  void dispose() {
    _inputController.dispose();
    _scrollController.dispose();
    _store?.closeSession(silent: true);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final store = context.watch<SessionStore>();
    final running = store.runPhase == RunPhase.running;
    // Авто-скролл вниз при новых сообщениях.
    if (store.messages.length > _lastMessageCount) {
      _lastMessageCount = store.messages.length;
      WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
    }
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(widget.session.title, overflow: TextOverflow.ellipsis),
            if (running || store.lastRunStatus != null)
              Text(
                running ? 'выполняется…' : _statusLabel(store.lastRunStatus),
                style: Theme.of(context).textTheme.bodySmall,
              ),
          ],
        ),
        actions: [
          if (running)
            IconButton(
              key: const Key('btn-cancel-run'),
              icon: const Icon(Icons.stop_circle_outlined),
              tooltip: 'Отменить',
              onPressed: () => store.cancelRun(),
            ),
          PopupMenuButton<String>(
            key: const Key('btn-overflow'),
            onSelected: (value) {
              if (value == 'delete') {
                _confirmDelete(context);
              }
            },
            itemBuilder: (context) => const [
              PopupMenuItem(value: 'delete', child: Text('Удалить сессию')),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          Expanded(child: _buildFeed(store)),
          _buildInput(store),
        ],
      ),
    );
  }

  Widget _buildFeed(SessionStore store) {
    if (store.messages.isEmpty) {
      return const Center(child: Text('Начните диалог'));
    }
    return ListView.builder(
      controller: _scrollController,
      padding: const EdgeInsets.all(12),
      itemCount: store.messages.length,
      itemBuilder: (context, index) =>
          _MessageBubble(message: store.messages[index]),
    );
  }

  Widget _buildInput(SessionStore store) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: Focus(
                onKeyEvent: _handleKey,
                child: TextField(
                  key: const Key('field-message-input'),
                  controller: _inputController,
                  minLines: 1,
                  maxLines: 5,
                  decoration: const InputDecoration(
                    hintText: 'Сообщение… (Enter — отправить)',
                    border: OutlineInputBorder(),
                  ),
                  onSubmitted: (_) => _send(store),
                ),
              ),
            ),
            const SizedBox(width: 8),
            IconButton(
              key: const Key('btn-send'),
              icon: const Icon(Icons.send),
              onPressed: () => _send(store),
            ),
          ],
        ),
      ),
    );
  }

  /// Enter — send, Shift+Enter — перенос строки.
  KeyEventResult _handleKey(FocusNode node, KeyEvent event) {
    if (event is KeyDownEvent &&
        event.logicalKey == LogicalKeyboardKey.enter &&
        !HardwareKeyboard.instance.isShiftPressed) {
      _send(context.read<SessionStore>());
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  void _send(SessionStore store) {
    final text = _inputController.text.trim();
    if (text.isEmpty) {
      return;
    }
    _inputController.clear();
    store.sendMessage(text).then((_) {}, onError: (Object e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Ошибка отправки: $e')),
        );
      }
    });
  }

  void _scrollToBottom() {
    if (!_scrollController.hasClients) {
      return;
    }
    _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
  }

  Future<void> _confirmDelete(BuildContext context) async {
    final store = context.read<SessionStore>();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Удалить сессию?'),
        content: Text(widget.session.title),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Отмена'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Удалить'),
          ),
        ],
      ),
    );
    if (confirmed == true && context.mounted) {
      final navigator = Navigator.of(context);
      await store.deleteSession(widget.session.id);
      if (!mounted) {
        return;
      }
      navigator.pop();
    }
  }
}

String _statusLabel(String? status) => switch (status) {
      'CANCELLED' => 'отменено',
      'ERROR' => 'ошибка',
      'INTERRUPTED' => 'прервано',
      'DONE' => 'готово',
      _ => status ?? '',
    };

/// Пузырь сообщения ленты: user / assistant / tool-карточка / error.
class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.message});

  final ChatMessage message;

  @override
  Widget build(BuildContext context) {
    return switch (message) {
      UserChatMessage(:final text) => _UserBubble(text: text),
      AssistantChatMessage(:final text) => _AssistantBubble(text: text),
      ToolChatCard() => _ToolCardWidget(card: message as ToolChatCard),
      ErrorChatMessage(:final message) => _ErrorBubble(message: message),
    };
  }
}

class _UserBubble extends StatelessWidget {
  const _UserBubble({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.all(12),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.75,
        ),
        decoration: BoxDecoration(
          color: scheme.primaryContainer,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Text(text),
      ),
    );
  }
}

class _AssistantBubble extends StatelessWidget {
  const _AssistantBubble({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.all(8),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.85,
        ),
        child: MarkdownBody(data: text),
      ),
    );
  }
}

class _ErrorBubble extends StatelessWidget {
  const _ErrorBubble({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.errorContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(message),
    );
  }
}

/// Tool-карточка: свёрнутое тело (toolName + статус + первая строка).
/// Тело: arguments JSON / content / structured → [buildStructured] (T30 hook).
class _ToolCardWidget extends StatelessWidget {
  const _ToolCardWidget({required this.card});

  final ToolChatCard card;

  @override
  Widget build(BuildContext context) {
    final (icon, label) = switch ((card.done, card.isError)) {
      (true, true) => (Icons.error_outline, 'error'),
      (true, false) => (Icons.check_circle_outline, 'done'),
      (false, _) => (Icons.hourglass_empty, 'running'),
    };
    final summary = card.done && card.content.isNotEmpty
        ? card.content.split('\n').first
        : card.arguments.split('\n').first;
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: ExpansionTile(
        key: Key('tool-card-${card.callId}'),
        leading: Icon(icon, size: 20),
        title: Text('${card.toolName} — $label'),
        subtitle: Text(
          summary.length > 80 ? '${summary.substring(0, 80)}…' : summary,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (card.arguments.isNotEmpty) ...[
                  Text('arguments:',
                      style: Theme.of(context).textTheme.labelSmall),
                  Text(card.arguments,
                      style: const TextStyle(
                          fontFamily: 'monospace', fontSize: 12)),
                  const SizedBox(height: 8),
                ],
                if (card.content.isNotEmpty) ...[
                  Text('result:',
                      style: Theme.of(context).textTheme.labelSmall),
                  SelectableText(card.content),
                  const SizedBox(height: 8),
                ],
                if (card.structured != null) ...[
                  Text('structured:',
                      style: Theme.of(context).textTheme.labelSmall),
                  // T30 ExtensionPoint: SDUI-рендер вместо сырого JSON.
                  buildStructured(card.structured),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}
