# Jhin — AGENTS.md

## Что такое Jhin

Jhin — self-hosted coding agent (аналог Pi / opencode): Java (Spring Boot) backend + Flutter frontend. Backend исполняет агента и тулы; Flutter — тонкий рендерер, одинаковый UI на Android / Linux desktop / Web. Всё self-hosted: один backend-инстанс (hub), исполняющий тулы локально.

## Философия: каждая фича — точка расширения

Каждая строка кода пишется с расчётом, что плагин может подправить поведение. Плагины — Java-jar в `~/.jhin/plugins/`, загружаются через `URLClassLoader` + `ServiceLoader`.

Пять SPI-интерфейсов (core инжектит `List<T>`, сортирует по `@Order`, итерирует сам):

```java
public interface PromptInterceptor { PromptContext intercept(PromptContext ctx) throws PluginVetoException; }
public interface ToolCallGuard { ToolCallDecision check(ToolCall call); } // ALLOW | BLOCK(reason)
public interface ToolResultTransformer { ToolResult transform(ToolResult r); }
public interface ToolProvider { List<ToolDefinition> tools(); }
public interface LlmProviderFactory { String format(); ChatModel create(ProviderConfig cfg); }
```

Правила расширения:
- **UI только через JSON-примитивы** — server-driven UI: бэкенд шлёт JSON-описание, Flutter рендерит через собственный реестр примитивов (dropdown, list, drawer, container, card, text, button, формы, charts, figures, table, markdown). Неизвестный тип → карточка-заглушка, не падаем.
- **Тулы только через ToolProvider** — никаких прямых вызовов тулов мимо реестра и guard-цепочки.

## Архитектура

- **Hub-and-spoke**: MVP = один hub, исполняющий тулы локально. `app.role=hub|worker` в конфиге — шов на будущее, worker-протокол в MVP не реализуется.
- **Event-sourcing**: hub — единственный писатель. Всё (сообщения, тулы, UI-события) — события в логе SQLite.
- **Монотонный `seq` на сессию**: каждое событие получает seq = max+1 атомарно, без дыр.
- **SSE resume**: реконнект = `GET /sessions/{id}/events?fromSeq=N` → replay из БД → live-tail. Разрыв стрима (в т.ч. при `/reload`) скрыт от клиента.

## Правила (нельзя нарушать)

1. **Ноль внешних бинарников в тулах** — вся чистая Java (fd/ripgrep НЕ используем). Работает на любом Linux/macOS/Windows из коробки.
2. **Ноль ручных установок для юзера** — gradle wrapper + fat jar; продукт не требует nix.
3. **Зависимости только существующие** — используем опубликованные библиотеки (LangChain4j, MCP SDK, zt-exec, java-diff-utils), не пишем свои SDK/протоколы. Только JSON + SSE, никакого своего бинарного протокола.

## Структура репо

```
├── AGENTS.md              # этот файл: идея, философия плагинов
├── README.md
├── backend/               # Java 21 + Spring Boot + SQLite
│   ├── devenv.nix         # dev-окружение (продукт nix НЕ требует)
│   ├── build.gradle       # bootJar, fat jar
│   └── src/main/java/com/astroreen/jhin/...
├── frontend/              # Flutter: Android APK + Linux desktop + Web
│   ├── devenv.nix
│   └── pubspec.yaml, lib/, android/, linux/, web/
├── plugins/
│   └── example/           # исходник демо-плагина + README сборки
└── deploy/
    ├── README.md          # запуск: java -jar, systemd unit пример
    └── run.sh             # wrapper: рестарт-луп для /reload
```

## Как добавить плагин

1. Реализуй один или несколько из 5 SPI-интерфейсов (см. выше).
2. Зарегистрируй реализации через `META-INF/services/` (стандартный `ServiceLoader`).
3. Собери jar (`gradle jar`) и положи в `~/.jhin/plugins/`.
4. Перезапусти backend (`POST /admin/reload` или рестарт) — плагин подхватится.

Рабочий пример со всеми шагами: `plugins/example/` (исходник + README сборки).

## Что НЕ в MVP

- Worker-протокол / удалённое исполнение тулов / синхронизация инстансов
- PF4J, hot-swap классов в JVM, скриптовые движки (Groovy/GraalJS и т.п.)
- Пароли, JWT, OAuth/OIDC, passkeys, refresh-rotation (только enrollment-код → device-токен)
- Traefik/reverse-proxy, VPN/tsnet, mTLS клиентских сертификатов
- Внешние бинарники в тулах (fd, ripgrep, shell-обёртки поиска)
- MCP-сервер (только клиент), MCP Apps/iframe UI
- Approval-gate UI на тулы
- Compaction/branching сессий (переполнение контекста → ошибка, новая сессия)
- Kanban/todo/stats экраны, дропдаун хостов
- Windows/iOS сборки (код совместим, сборка не настраивается)
- NixOS-модуль (deploy = generic systemd пример + jar)
- OS-level изоляция аккаунтов (uid/nftables) — только app-layer
- Ресайз изображений в read (base64 as-is)
- Свой CBOR/бинарный протокол — только JSON + SSE
