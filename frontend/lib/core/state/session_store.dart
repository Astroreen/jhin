import 'dart:async';

import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../sse/sse_transport.dart' show SseEvent, SseTransportStatus;
import 'chat_models.dart';

export 'chat_models.dart';

/// Фаза run'а: idle — нет активного, running — идёт.
enum RunPhase { idle, running }

/// SessionStore: список сессий + лента текущей сессии как view-model.
///
/// - Сессии: загрузка/создание/удаление через [ApiClient].
/// - Лента: SSE-подписка на текущую сессию (fromSeq=0 — вся история; далее
///   транспорт сам резюмит с lastId+1). Склейка событий → [ChatMessage].
/// - Send: POST messages → runId для кнопки Cancel; user_message НЕ дублируем
///   (приходит событием — лента строится только из событий).
class SessionStore extends ChangeNotifier {
  SessionStore({
    required this.api,
    required Stream<SseEvent> Function(String sessionId, {int? fromSeq})
        events,
  }) : _events = events;

  final ApiClient api;
  final Stream<SseEvent> Function(String sessionId, {int? fromSeq}) _events;

  // ── Session list ──────────────────────────────────────────────────────

  List<SessionInfo> sessions = [];
  bool loadingSessions = false;
  String? sessionsError;

  // ── Current session chat ──────────────────────────────────────────────

  SessionInfo? currentSession;
  final List<ChatMessage> messages = [];
  int? lastSeq;
  RunPhase runPhase = RunPhase.idle;

  /// Последний статус run'а: DONE | CANCELLED | ERROR | INTERRUPTED.
  String? lastRunStatus;
  String? currentRunId;
  bool sseConnected = false;

  StreamSubscription<SseEvent>? _sseSub;

  // ── Session list ops ──────────────────────────────────────────────────

  Future<void> loadSessions() async {
    loadingSessions = true;
    sessionsError = null;
    notifyListeners();
    try {
      sessions = await api.listSessions();
    } on Exception catch (e) {
      sessionsError = e.toString();
    }
    loadingSessions = false;
    notifyListeners();
  }

  Future<SessionInfo> createSession(CreateSession request) async {
    final session = await api.createSession(request);
    sessions = [...sessions, session];
    notifyListeners();
    return session;
  }

  Future<void> deleteSession(String id) async {
    await api.deleteSession(id);
    sessions = sessions.where((s) => s.id != id).toList(growable: false);
    if (currentSession?.id == id) {
      closeSession();
    }
    notifyListeners();
  }

  /// Провайдеры для dropdown моделей при создании сессии.
  Future<List<ProviderInfo>> loadProviders() => api.listProviders();

  // ── Chat ops ──────────────────────────────────────────────────────────

  /// Открыть сессию: подписка SSE fromSeq=0 (вся история).
  void openSession(SessionInfo session) {
    closeSession();
    currentSession = session;
    messages.clear();
    lastSeq = null;
    runPhase = RunPhase.idle;
    lastRunStatus = null;
    currentRunId = null;
    _subscribe(session.id);
    notifyListeners();
  }

  /// Отписка от текущей сессии (смена сессии / выход).
  /// [silent] — без notifyListeners (dispose виджета, чтобы не ребилдить).
  void closeSession({bool silent = false}) {
    _sseSub?.cancel();
    _sseSub = null;
    currentSession = null;
    messages.clear();
    lastSeq = null;
    runPhase = RunPhase.idle;
    lastRunStatus = null;
    currentRunId = null;
    if (!silent) {
      notifyListeners();
    }
  }

  /// Отправить сообщение. Backend пришлёт `user_message` событием —
  /// НЕ дублируем в ленте; input очищается на стороне UI сразу.
  Future<RunRef> sendMessage(String text) async {
    final session = currentSession;
    if (session == null) {
      throw StateError('no open session');
    }
    final ref = await api.sendMessage(session.id, text);
    currentRunId = ref.runId;
    runPhase = RunPhase.running;
    notifyListeners();
    return ref;
  }

  /// Отменить текущий run (идемпотентен).
  Future<RunRef> cancelRun() async {
    final session = currentSession;
    if (session == null) {
      throw StateError('no open session');
    }
    return api.cancelRun(session.id);
  }

  /// Обновить статус SSE-транспорта (из callback JhinClient).
  void updateSseStatus(SseTransportStatus status) {
    sseConnected = status == SseTransportStatus.connected;
    notifyListeners();
  }

  // ── SSE ───────────────────────────────────────────────────────────────

  void _subscribe(String sessionId) {
    _sseSub = _events(sessionId, fromSeq: 0).listen(
      _onEvent,
      onError: (Object e) {
        debugPrint('Jhin SSE error: $e');
      },
    );
  }

  void _onEvent(SseEvent event) {
    lastSeq = event.id ?? lastSeq;
    final data = event.data;
    if (data == null) {
      return;
    }
    switch (event.type) {
      case 'user_message':
        messages.add(UserChatMessage(
          seq: event.id ?? 0,
          text: data['text'] as String? ?? '',
        ));
      case 'message_start':
        messages.add(AssistantChatMessage(
          seq: event.id ?? 0,
          messageId: data['messageId'] as String? ?? '',
        ));
      case 'text_delta':
        final msg = _currentAssistant;
        if (msg != null) {
          msg.text += data['text'] as String? ?? '';
        }
      case 'message_end':
        final msg = _currentAssistant;
        if (msg != null) {
          msg.text = data['text'] as String? ?? msg.text;
          msg.finalized = true;
        }
      case 'tool_use':
        messages.add(ToolChatCard(
          seq: event.id ?? 0,
          callId: data['callId'] as String? ?? '',
          toolName: data['toolName'] as String? ?? '',
          arguments: encodeArguments(data['arguments']),
        ));
      case 'tool_result':
        final card = _findToolCard(data['callId'] as String? ?? '');
        if (card != null) {
          final streaming = data['streaming'] as bool? ?? false;
          final content = data['content'] as String? ?? '';
          if (streaming) {
            card.content += content;
          } else {
            card.content = content;
            card.done = true;
            card.structured = data['structured'];
            final err = data['error'];
            card.isError = err != null && err != false && err != '';
          }
        }
      case 'run_start':
        currentRunId = data['runId'] as String?;
        runPhase = RunPhase.running;
        lastRunStatus = null;
      case 'run_end':
        runPhase = RunPhase.idle;
        lastRunStatus = data['status'] as String? ?? 'DONE';
        currentRunId = null;
      case 'error':
        messages.add(ErrorChatMessage(
          seq: event.id ?? 0,
          message: data['message'] as String? ?? 'Unknown error',
        ));
      case 'ui':
        // T30: SDUI-обработка. Пока игнорируем.
        break;
      default:
        break;
    }
    notifyListeners();
  }

  /// Незавершённое сообщение ассистента (склейка text_delta идёт в него).
  AssistantChatMessage? get _currentAssistant {
    for (var i = messages.length - 1; i >= 0; i--) {
      final m = messages[i];
      if (m is AssistantChatMessage && !m.finalized) {
        return m;
      }
    }
    return null;
  }

  ToolChatCard? _findToolCard(String callId) {
    for (var i = messages.length - 1; i >= 0; i--) {
      final m = messages[i];
      if (m is ToolChatCard && m.callId == callId) {
        return m;
      }
    }
    return null;
  }

  @override
  void dispose() {
    _sseSub?.cancel();
    super.dispose();
  }
}
