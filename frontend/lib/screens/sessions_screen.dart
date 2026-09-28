import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/api/api_client.dart';
import '../core/state/session_store.dart';
import 'chat_screen.dart';

/// Экран списка сессий: загрузка/создание/удаление, tap → [ChatScreen].
///
/// FAB «Новая сессия» — диалог (title, workdir, model dropdown из
/// GET /providers). Пустой список провайдеров → заглушка про Settings (T31).
class SessionsScreen extends StatefulWidget {
  const SessionsScreen({
    super.key,
    required this.accountName,
    required this.onSignOut,
    this.onOpenSettings,
  });

  final String accountName;
  final Future<void> Function() onSignOut;

  /// Открытие Settings (T31); null — кнопка скрыта (тесты без навигации).
  final VoidCallback? onOpenSettings;

  @override
  State<SessionsScreen> createState() => _SessionsScreenState();
}

class _SessionsScreenState extends State<SessionsScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        context.read<SessionStore>().loadSessions();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final store = context.watch<SessionStore>();
    return Scaffold(
      appBar: AppBar(
        title: const Text('Jhin'),
        actions: [
          IconButton(
            key: const Key('btn-refresh'),
            icon: const Icon(Icons.refresh),
            onPressed: () => store.loadSessions(),
          ),
          if (widget.onOpenSettings != null)
            IconButton(
              key: const Key('btn-settings'),
              icon: const Icon(Icons.settings),
              tooltip: 'Настройки',
              onPressed: widget.onOpenSettings,
            ),
          IconButton(
            key: const Key('btn-sign-out'),
            icon: const Icon(Icons.logout),
            onPressed: () => widget.onSignOut(),
          ),
        ],
      ),
      body: _buildBody(store),
      floatingActionButton: FloatingActionButton.extended(
        key: const Key('btn-new-session'),
        onPressed: () => _showCreateDialog(context),
        icon: const Icon(Icons.add),
        label: const Text('Новая сессия'),
      ),
    );
  }

  Widget _buildBody(SessionStore store) {
    if (store.loadingSessions && store.sessions.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (store.sessionsError != null && store.sessions.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(store.sessionsError!),
            const SizedBox(height: 8),
            OutlinedButton(
              onPressed: () => store.loadSessions(),
              child: const Text('Повторить'),
            ),
          ],
        ),
      );
    }
    if (store.sessions.isEmpty) {
      return const Center(
        child: Text(
          'Нет сессий.\nНажмите «Новая сессия» чтобы начать.',
          textAlign: TextAlign.center,
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: store.loadSessions,
      child: ListView.builder(
        itemCount: store.sessions.length,
        itemBuilder: (context, index) {
          final session = store.sessions[index];
          return Dismissible(
            key: ValueKey(session.id),
            direction: DismissDirection.endToStart,
            background: Container(
              color: Colors.red,
              alignment: Alignment.centerRight,
              padding: const EdgeInsets.only(right: 16),
              child: const Icon(Icons.delete, color: Colors.white),
            ),
            confirmDismiss: (_) => _confirmDelete(context, session),
            onDismissed: (_) {
              context.read<SessionStore>().deleteSession(session.id);
            },
            child: ListTile(
              key: Key('session-${session.id}'),
              title: Text(session.title),
              subtitle: Text(
                '${_formatDate(session.updatedAt)}'
                '${session.model != null ? ' · ${session.model}' : ''}',
              ),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => _openChat(context, session),
            ),
          );
        },
      ),
    );
  }

  void _openChat(BuildContext context, SessionInfo session) {
    final store = context.read<SessionStore>();
    store.openSession(session);
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ChatScreen(session: session),
      ),
    );
  }

  Future<bool?> _confirmDelete(BuildContext context, SessionInfo session) {
    return showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Удалить сессию?'),
        content: Text(session.title),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Отмена'),
          ),
          FilledButton(
            key: const Key('btn-confirm-delete'),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Удалить'),
          ),
        ],
      ),
    );
  }

  Future<void> _showCreateDialog(BuildContext context) async {
    final store = context.read<SessionStore>();
    final providers = await store.loadProviders();
    if (!context.mounted) {
      return;
    }
    final created = await showDialog<bool>(
      context: context,
      builder: (context) => _CreateSessionDialog(providers: providers),
    );
    if (created == true && context.mounted) {
      await store.loadSessions();
    }
  }
}

/// Диалог создания сессии: title, workdir, model dropdown из провайдеров.
class _CreateSessionDialog extends StatefulWidget {
  const _CreateSessionDialog({required this.providers});

  final List<ProviderInfo> providers;

  @override
  State<_CreateSessionDialog> createState() => _CreateSessionDialogState();
}

class _CreateSessionDialogState extends State<_CreateSessionDialog> {
  final _titleController = TextEditingController();
  final _workdirController = TextEditingController();
  ProviderInfo? _selected;

  @override
  void initState() {
    super.initState();
    if (widget.providers.isNotEmpty) {
      _selected = widget.providers.firstWhere(
        (p) => p.isDefault,
        orElse: () => widget.providers.first,
      );
    }
  }

  @override
  void dispose() {
    _titleController.dispose();
    _workdirController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Новая сессия'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            key: const Key('field-session-title'),
            controller: _titleController,
            decoration: const InputDecoration(labelText: 'Название'),
          ),
          TextField(
            key: const Key('field-session-workdir'),
            controller: _workdirController,
            decoration: const InputDecoration(labelText: 'Рабочая папка'),
          ),
          const SizedBox(height: 12),
          if (widget.providers.isEmpty)
            const Text(
              'Нет провайдеров, добавьте в Settings',
              key: Key('text-no-providers'),
            )
          else
            DropdownButtonFormField<ProviderInfo>(
              key: const Key('dropdown-model'),
              initialValue: _selected,
              decoration: const InputDecoration(labelText: 'Модель'),
              items: widget.providers
                  .map(
                    (p) => DropdownMenuItem(
                      value: p,
                      child: Text('${p.name} · ${p.model} · ${p.format}'),
                    ),
                  )
                  .toList(),
              onChanged: (value) => setState(() => _selected = value),
            ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('Отмена'),
        ),
        FilledButton(
          key: const Key('btn-create-session'),
          onPressed: _submit,
          child: const Text('Создать'),
        ),
      ],
    );
  }

  Future<void> _submit() async {
    final title = _titleController.text.trim();
    final workdir = _workdirController.text.trim();
    if (title.isEmpty || workdir.isEmpty) {
      return;
    }
    final store = context.read<SessionStore>();
    try {
      await store.createSession(CreateSession(
        title: title,
        workdir: workdir,
        model: _selected?.model,
        providerId: _selected?.id,
      ));
      if (mounted) {
        Navigator.of(context).pop(true);
      }
    } on Exception catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Ошибка: $e')),
        );
      }
    }
  }
}

/// Короткий/относительный формат даты ISO-8601 (`updatedAt` сессии).
String _formatDate(String iso) {
  final date = DateTime.tryParse(iso)?.toLocal();
  if (date == null) {
    return iso;
  }
  final diff = DateTime.now().difference(date);
  if (diff.inMinutes < 1) {
    return 'только что';
  }
  if (diff.inHours < 1) {
    return '${diff.inMinutes} мин назад';
  }
  if (diff.inDays < 1) {
    return '${diff.inHours} ч назад';
  }
  if (diff.inDays < 7) {
    return '${diff.inDays} дн назад';
  }
  final d = date.day.toString().padLeft(2, '0');
  final m = date.month.toString().padLeft(2, '0');
  return '$d.$m.${date.year % 100}';
}
