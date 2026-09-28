import 'dart:convert';

/// View-model сообщений ленты чата (не сырые SSE-события).
///
/// Склейка событий AgentLoop → сообщения:
///  - `user_message` → [UserChatMessage];
///  - `message_start` + `text_delta`* + `message_end` → один [AssistantChatMessage]
///    (склейка дельт по messageId, финализация по message_end);
///  - `tool_use` + `tool_result`* → одна [ToolChatCard] по callId
///    (streaming:true — накопление чанков content, streaming:false — финал);
///  - `error` → [ErrorChatMessage];
///  - `run_start`/`run_end` — статус run'а (не сообщение ленты);
///  - `ui` — T30 SDUI, пока игнорируется.
sealed class ChatMessage {
  ChatMessage({required this.seq});

  /// seq SSE-события, из которого родилось сообщение (отладка/сортировка).
  final int seq;
}

/// Пользовательское сообщение (`user_message`).
class UserChatMessage extends ChatMessage {
  UserChatMessage({required super.seq, required this.text});

  final String text;
}

/// Ассистент-текст: склейка `text_delta`, финализация `message_end`.
class AssistantChatMessage extends ChatMessage {
  AssistantChatMessage({required super.seq, required this.messageId});

  final String messageId;
  String text = '';
  bool finalized = false;
}

/// Tool-карточка: `tool_use` → ожидающая; `tool_result` накапливает content.
class ToolChatCard extends ChatMessage {
  ToolChatCard({
    required super.seq,
    required this.callId,
    required this.toolName,
    required this.arguments,
  });

  final String callId;
  final String toolName;

  /// JSON-строка arguments из `tool_use`.
  final String arguments;

  /// Накопленный content из `tool_result` (streaming:true — чанки).
  String content = '';
  bool isError = false;
  bool done = false;

  /// structured content из финального `tool_result` (T30: SDUI).
  dynamic structured;
}

/// Ошибка run'а (`error`).
class ErrorChatMessage extends ChatMessage {
  ErrorChatMessage({required super.seq, required this.message});

  final String message;
}

/// Сериализует arguments tool-вызова в JSON-строку для отображения.
String encodeArguments(dynamic arguments) {
  if (arguments == null) {
    return '';
  }
  if (arguments is String) {
    return arguments;
  }
  try {
    return const JsonEncoder.withIndent('  ').convert(arguments);
  } on JsonUnsupportedObjectError {
    return arguments.toString();
  }
}
