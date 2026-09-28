import 'package:flutter/material.dart';

import '../core/api/api_client.dart';
import '../core/jhin_client.dart';
import '../core/state/manifest_store.dart';

/// DI-точка: паузы reload-flow (смерть/подъём backend'а). В widget-тестах
/// подменяется на мгновенную — иначе pending-таймеры в FakeAsync.
typedef DelayFn = Future<void> Function(Duration duration);

/// Экран настроек: провайдеры LLM, перезапуск backend'а, состояние устройства.
///
/// Провайдеры: список карточек (apiKey НИКОГДА не рендерится — секрет живёт
/// только в поле ввода формы) + FAB «Добавить». Edit отсутствует намеренно:
/// API hub'а без update-эндпоинта (create/list/get/delete), поэтому правка =
/// удалить и создать заново. Delete — с confirm.
///
/// Reload: `POST /admin/reload` → 202 → пауза (процесс падает ~2с) → опрос
/// `GET /health` до успеха → перечитать провайдеров + `GET /ui/manifest`
/// (результат кладётся в [manifestStore], если он передан). 503 `restart
/// manually` (dev) → сообщение «вручную».
///
/// Устройство: fingerprint TOFU-пина из trustStore (95 chars) или «Не
/// закреплён» (web/TOFU) + «Забыть токен» → `JhinClient.signOut()` → очистка
/// стека навигации → [onSignedOut] (гейт показывает ConnectScreen).
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({
    super.key,
    required this.client,
    required this.onSignedOut,
    this.manifestStore,
    this.delay,
  });

  /// Клиент core-инфраструктуры: api (providers/reload), trustStore (пин),
  /// signOut (забыть токен).
  final JhinClient client;

  /// Вызывается после signOut и очистки стека навигации. Должен перевести
  /// приложение на ConnectScreen (токен уже очищен).
  final VoidCallback onSignedOut;

  /// Куда класть перечитанный UI-манифест после reload (T32). Опционален:
  /// без него запрос всё равно уходит, результат отбрасывается.
  final ManifestStore? manifestStore;

  /// Паузы reload-flow (тесты подменяют на `(_) async {}`).
  final DelayFn? delay;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

/// Ожидание «смерти» процесса после 202 restart.
const Duration _restartSettle = Duration(seconds: 2);

/// Интервал опроса `GET /health` после рестарта.
const Duration _pollInterval = Duration(milliseconds: 500);

/// Максимум попыток опроса (≈2с + 20×0.5с ≈ 12с — укладываемся в 5–10с
/// рабочего окна с запасом на медленный подъём).
const int _maxPollAttempts = 20;

class _SettingsScreenState extends State<SettingsScreen> {
  List<ProviderInfo> _providers = [];
  bool _loading = false;
  String? _error;
  bool _reloading = false;

  @override
  void initState() {
    super.initState();
    _loadProviders();
  }

  Future<void> _loadProviders() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final providers = await widget.client.api.listProviders();
      if (!mounted) {
        return;
      }
      setState(() {
        _providers = providers;
        _loading = false;
      });
    } on Exception catch (e) {
      if (!mounted) {
        return;
      }
      setState(() {
        _error = 'Не удалось загрузить провайдеров: $e';
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Настройки')),
      body: ListView(
        padding: const EdgeInsets.only(bottom: 88),
        children: [
          const _SectionHeader('Провайдеры'),
          if (_loading && _providers.isEmpty)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (_error != null)
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                children: [
                  Text(_error!),
                  const SizedBox(height: 8),
                  OutlinedButton(
                    onPressed: _loadProviders,
                    child: const Text('Повторить'),
                  ),
                ],
              ),
            )
          else if (_providers.isEmpty)
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text(
                'Провайдеров нет. Нажмите «+» чтобы добавить.',
                key: Key('text-no-providers'),
              ),
            )
          else
            for (final provider in _providers) _ProviderCard(
                  provider: provider,
                  onDelete: () => _deleteProvider(provider),
                ),
          const _SectionHeader('Backend'),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                FilledButton.tonal(
                  key: const Key('btn-reload'),
                  onPressed: _reloading ? null : _reloadBackend,
                  child: const Text('Перезапустить backend'),
                ),
                if (_reloading) ...[
                  const SizedBox(height: 12),
                  const LinearProgressIndicator(
                    key: Key('indicator-reload'),
                  ),
                  const SizedBox(height: 8),
                  const Text('Перезапуск…', key: Key('text-restarting')),
                ],
              ],
            ),
          ),
          const _SectionHeader('Устройство'),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'TLS-сертификат',
                  style: Theme.of(context).textTheme.labelLarge,
                ),
                const SizedBox(height: 4),
                _buildPinInfo(),
                const SizedBox(height: 16),
                OutlinedButton(
                  key: const Key('btn-forget-token'),
                  onPressed: _forgetToken,
                  child: const Text('Забыть токен'),
                ),
              ],
            ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton(
        key: const Key('btn-add-provider'),
        tooltip: 'Добавить провайдера',
        onPressed: () => _showProviderForm(context),
        child: const Icon(Icons.add),
      ),
    );
  }

  Widget _buildPinInfo() {
    final pinned = widget.client.trustStore.pinnedFingerprint;
    if (pinned == null) {
      return const Text('Не закреплён', key: Key('text-pin-none'));
    }
    return Text(
      pinned,
      key: const Key('text-pin-fingerprint'),
      style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
    );
  }

  Future<void> _showProviderForm(BuildContext context) async {
    final created = await showDialog<bool>(
      context: context,
      builder: (context) => _ProviderFormDialog(api: widget.client.api),
    );
    if (created == true && mounted) {
      await _loadProviders();
    }
  }

  Future<void> _deleteProvider(ProviderInfo provider) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Удалить провайдера?'),
        content: Text(provider.name),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Отмена'),
          ),
          FilledButton(
            key: const Key('btn-confirm-delete-provider'),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Удалить'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) {
      return;
    }
    final messenger = ScaffoldMessenger.of(context);
    try {
      await widget.client.api.deleteProvider(provider.id);
    } on Exception catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('Ошибка удаления: $e')));
      return;
    }
    await _loadProviders();
  }

  Future<void> _reloadBackend() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Перезапустить backend?'),
        content: const Text('Клиент переподключится автоматически.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Отмена'),
          ),
          FilledButton(
            key: const Key('btn-confirm-reload'),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Перезапустить'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) {
      return;
    }
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _reloading = true);
    try {
      await widget.client.api.reload();
    } on ApiClientException catch (e) {
      if (mounted) {
        setState(() => _reloading = false);
      }
      messenger.showSnackBar(SnackBar(content: Text(_reloadErrorText(e))));
      return;
    } on Exception catch (e) {
      if (mounted) {
        setState(() => _reloading = false);
      }
      messenger.showSnackBar(SnackBar(content: Text('Ошибка перезапуска: $e')));
      return;
    }
    // Процесс падает через ~2с и поднимается заново (под restart-loop/wrapper):
    // даём осесть, затем опрашиваем health до первого успеха.
    await _pause(_restartSettle);
    var alive = false;
    for (var attempt = 0; attempt < _maxPollAttempts; attempt++) {
      try {
        await widget.client.api.health();
        alive = true;
        break;
      } on Exception {
        await _pause(_pollInterval);
      }
    }
    if (!alive) {
      if (mounted) {
        setState(() => _reloading = false);
      }
      messenger.showSnackBar(
        const SnackBar(content: Text('Backend не ответил после перезапуска')),
      );
      return;
    }
    await _loadProviders();
    try {
      // 404/401 → null — нормально (манифест опционален).
      final manifest = await widget.client.api.getUiManifest();
      widget.manifestStore?.updateFrom(manifest);
    } on Exception {
      // reload удался, манифест опционален.
    }
    if (mounted) {
      setState(() => _reloading = false);
    }
    messenger.showSnackBar(
      const SnackBar(content: Text('Backend перезапущен')),
    );
  }

  String _reloadErrorText(ApiClientException e) {
    if (e.statusCode == 503) {
      return 'Автоперезапуск недоступен. Перезапустите backend вручную.';
    }
    return 'Ошибка перезапуска: ${e.error ?? e.statusCode}';
  }

  Future<void> _forgetToken() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Забыть токен?'),
        content: const Text('Устройство будет отвязано от сервера.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Отмена'),
          ),
          FilledButton(
            key: const Key('btn-confirm-forget'),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Забыть'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) {
      return;
    }
    final nav = Navigator.of(context);
    final onSignedOut = widget.onSignedOut;
    await widget.client.signOut();
    nav.popUntil((route) => route.isFirst);
    onSignedOut();
  }

  Future<void> _pause(Duration duration) {
    final delay = widget.delay;
    if (delay != null) {
      return delay(duration);
    }
    return Future<void>.delayed(duration);
  }
}

/// Заголовок секции экрана.
class _SectionHeader extends StatelessWidget {
  const _SectionHeader(this.title);

  final String title;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 24, 16, 8),
      child: Text(
        title,
        key: Key('section-${title.toLowerCase()}'),
        style: Theme.of(context).textTheme.titleMedium,
      ),
    );
  }
}

/// Карточка провайдера: name, `format · model`, baseUrl, badge isDefault.
/// Секретный ключ не рендерится никогда — DTO его не содержит.
class _ProviderCard extends StatelessWidget {
  const _ProviderCard({required this.provider, required this.onDelete});

  final ProviderInfo provider;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final baseUrl = provider.baseUrl;
    return Card(
      key: Key('provider-card-${provider.id}'),
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      child: ListTile(
        title: Text(provider.name),
        subtitle: Text(
          [
            '${provider.format} · ${provider.model}',
            if (baseUrl != null && baseUrl.isNotEmpty) baseUrl,
          ].join('\n'),
        ),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (provider.isDefault)
              const Padding(
                padding: EdgeInsets.only(right: 8),
                child: Chip(
                  key: Key('badge-default'),
                  label: Text('по умолчанию'),
                  visualDensity: VisualDensity.compact,
                ),
              ),
            IconButton(
              key: Key('btn-delete-provider-${provider.id}'),
              tooltip: 'Удалить',
              icon: const Icon(Icons.delete_outline),
              onPressed: onDelete,
            ),
          ],
        ),
      ),
    );
  }
}

/// Форма создания провайдера (create-only: update-эндпоинта в API нет).
///
/// Поля: name, format (anthropic|openai|gemini), baseUrl (опционально),
/// apiKey (required, obscure — единственный показ секрета), model (required),
/// isDefault. Ошибки 400 → человекочитаемо в [Key('text-provider-form-error')].
class _ProviderFormDialog extends StatefulWidget {
  const _ProviderFormDialog({required this.api});

  final ApiClient api;

  @override
  State<_ProviderFormDialog> createState() => _ProviderFormDialogState();
}

const List<String> providerFormats = ['anthropic', 'openai', 'gemini'];

class _ProviderFormDialogState extends State<_ProviderFormDialog> {
  final _nameController = TextEditingController();
  final _baseUrlController = TextEditingController();
  final _apiKeyController = TextEditingController();
  final _modelController = TextEditingController();
  String _format = providerFormats.first;
  bool _isDefault = false;
  String? _formError;
  bool _submitting = false;

  @override
  void dispose() {
    _nameController.dispose();
    _baseUrlController.dispose();
    _apiKeyController.dispose();
    _modelController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Новый провайдер'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              key: const Key('field-provider-name'),
              controller: _nameController,
              decoration: const InputDecoration(labelText: 'Название'),
            ),
            DropdownButtonFormField<String>(
              key: const Key('dropdown-provider-format'),
              initialValue: _format,
              decoration: const InputDecoration(labelText: 'Формат'),
              items: [
                for (final format in providerFormats)
                  DropdownMenuItem(value: format, child: Text(format)),
              ],
              onChanged: (value) {
                if (value != null) {
                  setState(() => _format = value);
                }
              },
            ),
            TextField(
              key: const Key('field-provider-base-url'),
              controller: _baseUrlController,
              decoration: const InputDecoration(
                labelText: 'Base URL',
                helperText:
                    'Для openai-совместимых: OpenRouter/Ollama/LM Studio/vLLM',
              ),
            ),
            TextField(
              key: const Key('field-provider-api-key'),
              controller: _apiKeyController,
              obscureText: true,
              decoration: const InputDecoration(labelText: 'API-ключ'),
            ),
            TextField(
              key: const Key('field-provider-model'),
              controller: _modelController,
              decoration: const InputDecoration(labelText: 'Модель'),
            ),
            SwitchListTile(
              key: const Key('switch-provider-default'),
              contentPadding: EdgeInsets.zero,
              title: const Text('По умолчанию'),
              value: _isDefault,
              onChanged: (value) => setState(() => _isDefault = value),
            ),
            if (_formError != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  _formError!,
                  key: const Key('text-provider-form-error'),
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.error,
                  ),
                ),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('Отмена'),
        ),
        FilledButton(
          key: const Key('btn-create-provider'),
          onPressed: _submitting ? null : _submit,
          child: const Text('Создать'),
        ),
      ],
    );
  }

  Future<void> _submit() async {
    final name = _nameController.text.trim();
    final apiKey = _apiKeyController.text.trim();
    final model = _modelController.text.trim();
    final baseUrl = _baseUrlController.text.trim();
    if (name.isEmpty || apiKey.isEmpty || model.isEmpty) {
      setState(
        () => _formError = 'Заполните название, API-ключ и модель',
      );
      return;
    }
    setState(() {
      _submitting = true;
      _formError = null;
    });
    try {
      await widget.api.createProvider(CreateProvider(
        name: name,
        format: _format,
        apiKey: apiKey,
        model: model,
        baseUrl: baseUrl.isEmpty ? null : baseUrl,
        isDefault: _isDefault,
      ));
      if (mounted) {
        Navigator.of(context).pop(true);
      }
    } on ApiClientException catch (e) {
      if (mounted) {
        setState(() {
          _formError = _createErrorText(e);
          _submitting = false;
        });
      }
    } on Exception catch (e) {
      if (mounted) {
        setState(() {
          _formError = 'Ошибка: $e';
          _submitting = false;
        });
      }
    }
  }

  String _createErrorText(ApiClientException e) {
    switch (e.error) {
      case 'unknown_format':
        return 'Неизвестный формат провайдера';
      case 'bad_request':
        return 'Некорректные данные: проверьте поля';
      default:
        return 'Ошибка: ${e.error ?? e.statusCode}';
    }
  }
}
