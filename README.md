# Jhin

Jhin — self-hosted coding agent (аналог Pi / opencode): Java 21 + Spring Boot backend и один Flutter-клиент на Android / Linux desktop / Web. Backend (hub) исполняет агента и тулы локально, хранит всё в SQLite (event-sourcing: сообщения, тулы, UI-события — события с монотонным `seq` на сессию) и отдаёт клиентам JSON + SSE. Flutter — тонкий рендерер: один код, нативный вид на всех платформах.

Всё расширяемо: плагины (Java-jar в `$JHIN_HOME/plugins/`) подключаются через 5 SPI — system prompt, вызовы тулов, результаты тулов, новые тулы, LLM-провайдеры. UI — server-driven: бэкенд шлёт JSON-примитивы, клиент рендерит их через свой реестр. Один hub на инстанс, клиенты подключаются по device-токенам.

Философия, архитектура и MUST-NOT-список — в [AGENTS.md](AGENTS.md). Написание плагинов и SDUI-схема — в [docs/plugin-dev.md](docs/plugin-dev.md). Запуск как сервиса, бэкап, обновление — в [deploy/README.md](deploy/README.md).

![Скриншот Jhin](docs/screenshot.png)

*(скриншот-плейсхолдер)*

## Quickstart

### 1. Требования

- **Сборка backend:** JDK 21 (в комплекте gradle wrapper 9.8.0 — ничего ставить не нужно).
- **Запуск backend:** любой Java 21 JRE.
- **Клиент:** Flutter 3.47+; для Android — Android SDK, для Linux desktop — GTK3/libsecret (см. «Сборка Flutter»).

### 2. Сборка backend

```bash
cd backend
./gradlew bootJar
```

Артефакт: `backend/build/libs/jhin-backend-0.1.0-SNAPSHOT.jar` (fat jar, самодостаточный). Дальше команды — из корня репо.

### 3. Запуск

```bash
java -jar backend/build/libs/jhin-backend-0.1.0-SNAPSHOT.jar [--server.port=8443]
```

Слушает `https://0.0.0.0:8443` (порт перекрывается свойством `server.port`). При первом старте в `$JHIN_HOME` (дефолт `~/.jhin`) создаются:

- `jhin.db` — SQLite, права 0600;
- `keystore/server.p12` + `keystore/server.p12.password` — самоподписанный TLS, 0600;
- в логе — `TLS fingerprint (SHA-256): AA:BB:...` (95 символов, формат `AA:BB:…`): понадобится клиенту для TOFU-pinning.

### 4. Аккаунт и enrollment-код

```bash
java -jar backend/build/libs/jhin-backend-0.1.0-SNAPSHOT.jar admin create-account alice
java -jar backend/build/libs/jhin-backend-0.1.0-SNAPSHOT.jar admin create-enrollment alice
```

`create-enrollment` печатает одноразовый код из 26 символов (`A-Z2-7`) и `expires_at`: TTL 10 минут, после погашения или истечения — недействителен.

**Важно:** admin CLI (`java -jar jhin.jar admin ...`) использует `JHIN_HOME` так же, как сервер — если не задать `JHIN_HOME`, и сервер, и CLI пишут в `~/.jhin`. Для изолированного прогона задайте `JHIN_HOME` **одинаково** и серверу, и CLI.

Прочие команды: `list-accounts`, `list-devices <account>`, `revoke-device <deviceId>`.

### 5. Клиент

Соберите/запустите Flutter-приложение (см. ниже), на экране Connect укажите **Server URL** (`https://host:8443`), **Enrollment code** и **Device name**, нажмите Connect. Клиент покажет TLS-фингерпринт сервера — сверьте с логом сервера и примите (TOFU: первый принятый фингерпринт пинится, несовпадение при следующих подключениях — отказ). Дальше код погашается в `POST /enroll`, device-токен сохраняется в secure storage. На web фингерпринт-диалог пропускается (браузер сам решает вопрос самоподписанного сертификата).

### 6. Дальше

В Settings создайте LLM-провайдер (формат `anthropic` / `openai` / `gemini`, ключ, модель; `baseUrl` — для openai-совместимых эндпоинтов), создайте сессию с рабочим каталогом и говорите. Прочее: `admin list-devices`, плагины и MCP — см. [docs/plugin-dev.md](docs/plugin-dev.md) и раздел «Конфиг».

## Сборка Flutter

Из каталога `frontend/`:

```bash
# dev-окружение (nix/devenv, используется в этой репе):
devenv shell -- flutter build linux

# обычный Flutter SDK (без nix):
flutter build linux     # Linux desktop: нужны GTK3, libsecret (flutter_secure_storage_linux)
flutter build web       # Web
flutter build apk       # Android
flutter run             # дев-запуск на выбранном устройстве
```

## Конфиг

Свойства Spring: флаги запуска (`--server.port=18443`) или переменные окружения; дефолты — в `backend/src/main/resources/application.yml`.

| Свойство | Дефолт | Что делает |
|---|---|---|
| `JHIN_HOME` (env) | `~/.jhin` | каталог данных: `jhin.db`, `keystore/`, `plugins/`, `mcp.json` |
| `jhin.home` | `${JHIN_HOME}` | то же свойством Spring |
| `server.port` | `8443` | HTTPS-порт |
| `server.address` | `0.0.0.0` | интерфейс |
| `jhin.role` | `hub` | `hub`\|`worker` — шов на будущее, worker-протокол в MVP не реализован |
| `jhin.sse.heartbeat-seconds` | `15` | период heartbeat-комментариев в SSE |
| `jhin.sse.cap-seconds` | `900` | жёсткий cap жизни SSE-соединения; клиент реконнектится с `fromSeq` |
| `jhin.reload.exit-delay-millis` | `2000` | задержка до `System.exit` после `POST /admin/reload` |
| `jhin.version` | `0.1.0` | версия в ответе `/ui/manifest` |
| `server.ssl.enabled` | `true` | `false` — escape hatch: отключает TLS-кастомизацию (hub за reverse-proxy с терминацией TLS) |
| `jhin.dev-mode` | авто | авто-детект (exploded classes без `.jar`); `true` — `/admin/reload` отвечает 503 «restart manually» |

**`mcp.json`** (в `$JHIN_HOME`) — MCP-серверы, Claude-Desktop-style:

```json
{
  "mcpServers": {
    "myserver": {
      "command": "bash",
      "args": ["/path/to/server.sh"],
      "env": {"FOO": "bar"}
    },
    "myhttp": {
      "url": "https://example.com/mcp",
      "headers": {"Authorization": "Bearer x"}
    }
  }
}
```

`command`+`args` — stdio transport, `url` — HTTP transport. Битые записи — warn + skip; нет файла — ноль MCP-тулов.

**`plugins/`** (в `$JHIN_HOME`) — plugin-jar'ы, сортируются по имени файла и грузятся при старте. Подробности — [docs/plugin-dev.md](docs/plugin-dev.md).

## API

Все пути (кроме `/enroll` и `/health`) требуют `Authorization: Bearer <device-токен>`. Ответы ошибок — JSON `{"error":"<code>"}`.

| Метод | Путь | Что делает |
|---|---|---|
| `POST` | `/enroll` | анонимный; `{code, deviceName}` → `{deviceToken, accountId, accountName}` |
| `GET` | `/health` | анонимный; `{"status":"UP"}` |
| `GET` | `/sessions` | список сессий аккаунта |
| `POST` | `/sessions` | `{title, workdir, model?, providerId?}` → 201 сессия |
| `GET` | `/sessions/{id}` | сессия |
| `PATCH` | `/sessions/{id}` | `{title?, model?, providerId?}` |
| `DELETE` | `/sessions/{id}` | 204 |
| `POST` | `/sessions/{id}/messages` | `{text}` → `{runId}` — асинхронный run |
| `POST` | `/sessions/{id}/cancel` | отмена активного run'а → `{runId}` (`null` — активного нет) |
| `POST` | `/sessions/{id}/ui-action` | `{action, payload?}` → `{seq}` — событие `ui` в стриме |
| `GET` | `/sessions/{id}/events?fromSeq=N` | SSE-поток событий сессии |
| `GET` | `/providers` | список LLM-провайдеров (без ключа) |
| `POST` | `/providers` | `{name, format, apiKey, model, baseUrl?, isDefault?}` → 201 |
| `GET` | `/providers/{id}` | провайдер |
| `DELETE` | `/providers/{id}` | 204 |
| `POST` | `/admin/reload` | graceful restart (202; в dev-mode 503) |
| `GET` | `/ui/manifest` | `{tools:[{name,description}], primitives:[…], version}` |

Коды ошибок: `bad_request` (400), `invalid_code` / `code_used` / `code_expired` (400, `/enroll`), `unknown_format` (400, `/providers`), `not_found` (404), `unauthorized` (401), `forbidden` (403), `rate_limited` (429, `/enroll`, + `Retry-After`), `restart manually` (503, `/admin/reload` в dev-mode).

**SSE-фрейминг** — стандартный: `id:` — `seq` события, `event:` — тип, `data:` — JSON-полезная нагрузка:

```
id: 42
event: text_delta
data: {"text":"..."}
```

Типы событий: `user_message`, `message_start`, `text_delta`, `message_end`, `tool_use`, `tool_result`, `run_start`, `run_end`, `error`, `session_meta`, `ui`. Heartbeat — SSE-комментарии (`: ...`). Резюм без дыр и дублей: реконнект с `?fromSeq=N` (последний полученный `id`), без параметра — вся история с 0.

## Безопасность — честно

### Что защищает

- **Enrollment-код** — 128 бит энтропии, base32 (26 символов `A-Z2-7`), TTL 10 минут, одноразовый (атомарное погашение), сравнение constant-time; в БД только SHA-256-хеш.
- **Device-токен** — 256 бит, base64url; в БД только SHA-256-хеш, plaintext возвращается один раз при `/enroll`; revoke через `admin revoke-device` мгновенный (lookup отвергает отозванные, SSE-потоки закрываются).
- **Self-signed TLS + TOFU-pinning** на io-клиентах: SHA-256-фингерпринт сертификата (95 символов, `AA:BB:…`) показывается при первом подключении, пинится клиентом; несовпадение — отказ подключиться.
- **Path-sandbox тулов** — выход за workdir сессии (включая symlink-escape) → ошибка «Path goes outside of workspace».
- **Guard-цепочка плагинов** — любой `ToolCallGuard` может заблокировать вызов до исполнения.
- **Rate-limit** на `/enroll` — 3 запроса за 60 секунд на IP, 429 + `Retry-After`.
- **Изоляция аккаунтов** на уровне приложения: scope — по device-токену, чужая сессия/провайдер — 404 без утечки 403.
- **Права файлов**: `jhin.db` и `keystore/*` — 0600.

### Что НЕ защищает

- **Паролей / JWT / OAuth / passkeys нет.** Device-токен — bearer: утечка токена = полный доступ до revoke; храните и отзывайте.
- **На web app-level TOFU невозможен** — браузер сам решает вопрос самоподписанного сертификата, пиннинг приложения недоступен.
- **Approval-gate на тулы нет.** И bash, и прочие тулы исполняются с правами юзера процесса hub — sandbox только path-level (workdir), это НЕ изоляция ОС.
- **OS-level изоляции аккаунтов нет** (uid/nftables и т.п.) — только app-layer.
- **БД не шифруется** — `api_key` провайдеров лежит в `jhin.db` plaintext-ом.
- **Rate-limit только на `/enroll`** — остальные эндпоинты не троттлятся.
- **Unmapped-пути отвечают 401** (не 404) — маскировка; existence эндпоинтов по коду не выдаётся.
- **Пароль TLS-keystore лежит рядом с keystore** (`server.p12.password`, 0600) — компрометация каталога = компрометация ключа.
- **Worker-протокол не реализован** — один hub, удалённое исполнение тулов недоступно.
- **Compaction / branching сессий нет** — переполнение контекста → ошибка run'а, заводите новую сессию.

## Структура репо

```
├── AGENTS.md              # идея, философия плагинов, MUST-NOT
├── README.md              # этот файл
├── backend/               # Java 21 + Spring Boot + SQLite (fat jar, gradle wrapper)
├── frontend/              # Flutter: Android APK + Linux desktop + Web
├── plugins/example/       # демо-плагин (5 SPI) + README сборки
├── docs/plugin-dev.md     # гайд по плагинам и SDUI-примитивам
└── deploy/                # запуск как сервиса: systemd, run.sh, бэкап
```
