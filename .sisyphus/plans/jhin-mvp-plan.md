# JHIN — MVP Plan

> **SUPERSEDED (2026-09-29)** by `.sisyphus/plans/jhin-plugin-first-plan.md`. Kept for history. Do not execute.

**Дата:** 2026-09-28 · **Статус:** одобрено юзером (ответы m0024) · **Исполнитель:** отдельная worker-сессия (`/start-work`)

---

## 1. Что это

Jhin — self-hosted coding agent (аналог Pi / opencode): Java (Spring Boot) backend + Flutter frontend. Всё построено вокруг плагинов: каждая строка кода пишется с расчётом, что плагин может подправить поведение. Backend исполняет агента и тулы; Flutter — тонкий рендерер, одинаковый UI на Android / Linux desktop / Web.

**MVP = один backend-инстанс (hub), исполняющий тулы локально.** Воркеров, удалённых хостов и синхронизации инстансов в MVP нет — только швы в схеме БД и конфиге.

## 2. Зафиксированные решения (спорить нельзя, юзер подтвердил)

| # | Решение |
|---|---------|
| D1 | Стек: Java 21 + Spring Boot (MVC/Tomcat, **не WebFlux**) + SQLite; Flutter (Android APK + Linux desktop + Web). Windows/iOS — совместимость кода, **не собираем** |
| D2 | Топология: hub-and-spoke, MVP = только hub. Одна кодовая база, `app.role=hub\|worker` в конфиге; worker-протокол в MVP не реализуется |
| D3 | Event-sourcing: hub — единственный писатель, монотонный `seq` на сессию. Всё (сообщения, тулы, UI-события) — события в логе. Реконнект = `GET /sessions/{id}/events?fromSeq=N` → replay → live |
| D4 | Мульти-клиент: телефон + десктоп висят на одной сессии одновременно, оба видят стрим, оба пишут (сознательное улучшение против Pi, где один attachmentId) |
| D5 | Доступ: **без VPN, без Traefik, без внешних прокси.** Бэкенд слушает `0.0.0.0:8443` по умолчанию (юзер меняет на `127.0.0.1` в конфиге если хочет). TLS — самоподписанный сертификат, генерируется при первом старте. Клиент — TOFU-pinning (показать fingerprint, запомнить) |
| D6 | Auth: аккаунты создаёт оператор CLI (`jhin-admin create-account`). Анонимных эндпоинтов ровно один: `POST /enroll`. Enrollment-код 128 бит base32, TTL 10 мин, одноразовый. Device-токены opaque 256 бит, в БД только SHA-256, мгновенный revoke. **Паролей/JWT/OAuth в MVP нет**. Rate-limit in-memory |
| D7 | LLM: LangChain4j `1.20.1` (BOM), модули `langchain4j-anthropic` + `langchain4j-open-ai`. Провайдеры: 3 wire-формата `{anthropic, openai, gemini}`; custom provider = формат + baseUrl + apiKey + model (OpenRouter/Ollama/LM Studio/vLLM/Meridian — всё через openai/anthropic формат с baseUrl). Gemini-модуль добавить если артефакт резолвится, иначе отложить |
| D8 | Тулы: паритет с Pi, 9 штук, **вся чистая Java — ноль внешних бинарников** (fd/ripgrep НЕ используем). Работает на любом Linux/macOS/Windows из коробки |
| D9 | Approval-гейта на тулы НЕТ (как в Pi). Path-sandbox остаётся (`..`-эскейп → ошибка) — защита от опечатки, честно так и документируем |
| D10 | Плагины: **Java-jar в `~/.jhin/plugins/`**. MVP-механизм: URLClassLoader + ServiceLoader. `/reload` = graceful restart процесса бэкенда (wrapper-скрипт перезапускает), SSE-resume скрывает разрыв от клиентов. Hot-swap в JVM — НЕТ (PF4J-автор отказался, ненадёжно) |
| D11 | UI: **server-driven**. Бэкенд шлёт JSON-описание UI; Flutter рендерит через собственный реестр примитивов. Примитивы (максимум): dropdown, list, drawer (burger), container/box, card, text, button, формы (textfield, checkbox, switch, slider), charts (line/bar/pie), figures (rectangle/circle/triangle), table, markdown. Реестр расширяется |
| D12 | Плагинные швы день 1 — 5 SPI-интерфейсов, core инжектит `List<T>` и итерирует сам: `PromptInterceptor`, `ToolCallGuard`, `ToolResultTransformer`, `ToolProvider`, `LlmProviderFactory` |
| D13 | MCP-клиент с первого дня: `io.modelcontextprotocol.sdk:mcp:2.0.1` + `dev.langchain4j:langchain4j-mcp:1.20.1-beta30`, конфиг `mcpServers` (stdio + HTTP), тулы MCP вливаются в общий реестр |
| D14 | devenv.nix в стиле юзера (русские комментарии, `languages.*`, `env` с NIX_LD, `scripts.*`, `enterShell`-баннер, автогенерация `.vscode/settings.json`). НО продукт **не требует nix** — gradle wrapper + fat jar работают на любой ОС |
| D15 | Данные: `JHIN_HOME` (по умолчанию `~/.jhin`): `jhin.db`, `plugins/`, `keystore/`, `logs/`. SQLite файл `0600`. LLM-ключи в БД (файл 0600 — этого достаточно для MVP) |
| D16 | Изоляция аккаунтов — **только app-layer** (accountId из Authentication, фильтр на уровне репозитория). OS-level изоляция (uid на аккаунт, nftables) — НЕ в MVP, не портируемо на чужие ОС |
| D17 | Имя пакета: `com.astroreen.jhin`. Репо: `/home/astroreen/Documents/jhin`, git init, можно пушить публично |

## 3. Структура репо

```
/home/astroreen/Documents/jhin/
├── AGENTS.md              # идея, направление, философия плагинов (см. задачу 1)
├── README.md
├── .gitignore
├── .envrc                 # корневой: подсказка «cd backend && direnv allow»
├── backend/
│   ├── .envrc             # use devenv
│   ├── devenv.nix
│   ├── build.gradle.kts   # bootJar, fat jar
│   ├── settings.gradle.kts
│   ├── gradle/wrapper/    # gradle wrapper — работает без nix
│   └── src/main/java/com/astroreen/jhin/...
├── frontend/
│   ├── .envrc
│   ├── devenv.nix
│   └── pubspec.yaml, lib/, android/, linux/, web/
├── plugins/
│   ├── .gitkeep
│   └── example/           # исходник демо-плагина + README сборки
└── deploy/
    ├── README.md          # запуск на любой ОС: java -jar, systemd unit пример
    └── run.sh             # wrapper: рестарт-луп для /reload
```

## 4. Схема БД (SQLite, миграции — самописный раннер, БЕЗ Flyway)

Файл `backend/src/main/resources/db/V1__init.sql`. Таблица `schema_version(version INT)`.

```sql
CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE devices (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL,
  last_seen TEXT, last_ip TEXT, revoked INT NOT NULL DEFAULT 0);
CREATE TABLE enrollment_codes (code_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at TEXT NOT NULL, used INT NOT NULL DEFAULT 0);
CREATE TABLE sessions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
  title TEXT NOT NULL, workdir TEXT NOT NULL, model TEXT, provider_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE events (session_id TEXT NOT NULL, seq INT NOT NULL, ts TEXT NOT NULL,
  type TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (session_id, seq));
CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  status TEXT NOT NULL, -- RUNNING|DONE|CANCELLED|ERROR|INTERRUPTED
  model TEXT, provider_id TEXT, usage_json TEXT, error TEXT,
  started_at TEXT NOT NULL, ended_at TEXT);
CREATE TABLE providers (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL, format TEXT NOT NULL, -- anthropic|openai|gemini
  base_url TEXT, api_key TEXT NOT NULL, model TEXT NOT NULL, is_default INT NOT NULL DEFAULT 0);
CREATE TABLE workers (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
  last_heartbeat TEXT); -- ШОВ под будущих воркеров. MVP: hub сам регистрирует строку 'local'
```

Типы событий (`events.type`): `user_message`, `message_start`, `text_delta`, `message_end`, `tool_use`, `tool_result`, `run_start`, `run_end`, `error`, `session_meta`, `ui` (JSON-карточка от плагина).

## 5. REST/SSE API

Анонимный: `POST /enroll` `{code, deviceName}` → `{deviceToken, accountId}`.
Авторизованные (Bearer token):
- `GET /health` — тоже анонимный (проверка живости, без данных)
- `GET /sessions`, `POST /sessions {title, workdir, model?, providerId?}`, `GET /sessions/{id}`
- `POST /sessions/{id}/messages {text}` → запускает run
- `POST /sessions/{id}/cancel`
- `GET /sessions/{id}/events?fromSeq=N` — SSE: replay из БД → live-tail; heartbeat каждые 15с; cap жизни стрима 15 мин (клиент реконнектится с fromSeq)
- `GET /providers`, `POST /providers`, `DELETE /providers/{id}`
- `GET /ui/manifest` — `{tools:[...], primitives:[...], version}`
- `POST /admin/reload` — graceful restart

Authz: `accountId` ТОЛЬКО из `Authentication`; проверка `session.accountId == principal.accountId` в репозитории (`findByIdAndAccountId`), не в контроллере.

## 6. Тулы (паритет с Pi, чистая Java)

| Тул | Параметры | Реализация |
|-----|-----------|------------|
| `bash` | `command`, `timeout?` (сек) | `zt-exec:1.13.0`, стриминг stdout/stderr построчно, tree-kill через `ProcessHandle.descendants()` |
| `read` | `path`, `offset?`, `limit?` | Java NIO; текст 2000 строк/51200 байт; изображение (png/jpg/gif/webp) → base64 ImageContent без ресайза |
| `write` | `path`, `content` | guard «сначала прочитай файл» (трекинг прочитанных путей в рамках run) |
| `edit` | `path`, `oldString`, `newString`, `replaceAll?` | literal-замена (НЕ regex — проще и безопаснее Pi-варианта), ошибка «No matches found» |
| `edit-diff` | `path`, `oldString`, `newString` | unified diff через `io.github.java-diff-utils:java-diff-utils` (версию проверить на Maven Central, ожидание 4.x) |
| `find` | `pattern` (glob), `path?`, `limit?=1000` | `Files.walk()` + glob matcher, уважает `.gitignore` |
| `grep` | `pattern`, `path?`, `glob?`, `ignoreCase?`, `literal?`, `context?=0`, `limit?=100` | `Files.lines()` + `java.util.regex`; лимит строки 2000 симв; уважает `.gitignore` |
| `ls` | `path?`, `limit?=500` | Java NIO, каталоги с `/`, сортировка |
| `powershell` | `command`, `timeout?` | только Windows (`pwsh`/`powershell`), на других ОС не регистрируется |

Усечение везде: 2000 строк / 51200 байт. Path-sandbox: нормализация + запрет выхода за workdir (`..` → ошибка «Path goes outside of workspace»).

`.gitignore`-парсер: самописный, простой (комментарии, `*`, `**`, `?`, `[...]`, negation `!`, каталоги с `/`). Библиотеку не тянем.

Системный промпт: base (свой, по мотивам Pi: роль coding agent, правила работы с тулами) + guidance каждого тула (`promptSnippet` + `promptGuidelines`) + содержимое `AGENTS.md` из workdir если есть.

## 7. Плагинные SPI (день 1)

```java
public interface PromptInterceptor { PromptContext intercept(PromptContext ctx) throws PluginVetoException; }
public interface ToolCallGuard { ToolCallDecision check(ToolCall call); } // ALLOW | BLOCK(reason)
public interface ToolResultTransformer { ToolResult transform(ToolResult r); }
public interface ToolProvider { List<ToolDefinition> tools(); }
public interface LlmProviderFactory { String format(); ChatModel create(ProviderConfig cfg); }
```

Core инжектит `List<T>` (Spring сортирует по `@Order`), итерирует сам, ловит veto. `ApplicationEvent` — только для observe (аудит/метрики позже). Загрузка: скан `~/.jhin/plugins/*.jar` → `URLClassLoader` на каждый jar → `ServiceLoader.load(SPI.class, cl)`. Регистрация в реестры при старте. `/reload` = `System.exit(0)` после graceful-паузы, wrapper перезапускает.

## 8. Flutter клиент

- Зависимости: `http`, `flutter_secure_storage` (native) / `shared_preferences` (web-фолбэк за интерфейсом `TokenStorage`), `provider` (стейт), `fl_chart` (чарты), `flutter_markdown_plus` (markdown; **проверить на pub.dev** — оригинальный flutter_markdown discontinued; фолбэк `markdown_widget`), `path_provider`
- SSE: **самописный клиент за интерфейсом `SseTransport`** (~150 строк): io — `HttpClient` с `Authorization` header, парсер `text/event-stream`; web — `fetch` + Stream через `package:web`. `eventflux` НЕ используем (resume у нас свой, по fromSeq). Reconnect с backoff+jitter
- TLS: native — `badCertificateCallback` + TOFU (SHA-256 fingerprint peer-сертификата, показать юзеру при первом коннекте, хранить в TokenStorage); web — браузер сам, юзер принимает warning
- Экраны: Connect (URL + enrollment-код), Sessions (список), Chat (сообщения + tool-карточки + input + cancel + выбор модели), Settings (провайдеры CRUD, Reload-кнопка, fingerprint устройства)
- UI-рендерер: `Widget buildUi(Map<String,dynamic> json)` + реестр `Map<String, UiPrimitiveBuilder>`. Примитивы из D11. Неизвестный тип → карточка-заглушка с именем типа (не падаем)
- HTTP-слой за интерфейсом `ApiClient` (шов под tsnet в будущем)

## 9. Фазы и задачи

Формат задачи: **цель → файлы → шаги → приёмка → QA → commit**. QA-команды исполняются исполнителем, доказательства (вывод) прикладываются в отчёт задачи.

---

### Фаза 0 — Каркас

**T1. Repo init + корневые файлы**
- Файлы: `AGENTS.md`, `README.md`, `.gitignore`, `.envrc`, `plugins/.gitkeep`, `deploy/README.md`, `deploy/run.sh`
- AGENTS.md содержание: (а) что такое Jhin — self-hosted coding agent, Java backend + Flutter client; (б) философия: **каждая фича проектируется как точка расширения** — 5 SPI из §7, UI только через JSON-примитивы, тулы только через ToolProvider; (в) архитектура: hub-and-spoke, event-sourcing, seq, SSE resume; (г) правила: ноль внешних бинарников в тулах, ноль ручных установок для юзера, зависимости только существующие (не писать свои SDK); (д) структура репо; (е) как добавить плагин (кратко, ссылка на plugins/example); (ж) что НЕ в MVP (список из §11)
- `.gitignore`: `.devenv*`, `.direnv/`, `.gradle_home/`, `*.db`, `secrets/`, `build/`, `.dart_tool/`, `.idea/`, `*.iml`, `.env`, `keystore/`, `dist/`
- `deploy/run.sh`: `#!/usr/bin/env bash` + `while true; do java -jar "$1"; echo "exit=$?, restart in 1s"; sleep 1; done` (chmod +x)
- Приёмка: `git init` сделан, первый commit содержит все корневые файлы
- QA: `git status` чистый после commit; `bash -n deploy/run.sh` без ошибок
- Commit: `chore: repo scaffold, AGENTS.md, gitignore, deploy wrapper`

**T2. Backend devenv + Gradle скелет**
- Файлы: `backend/devenv.nix`, `backend/.envrc`, `backend/settings.gradle.kts`, `backend/build.gradle.kts`, `backend/gradle/wrapper/*` (`gradle wrapper --gradle-version 9.0` или актуальная 9.x), `backend/src/main/java/com/astroreen/jhin/JhinApplication.java`, `backend/src/main/resources/application.yml`, `backend/src/test/java/com/astroreen/jhin/SmokeTest.java`
- devenv.nix — стиль юзера (русские комментарии): `let jdk = pkgs.openjdk21; in { languages.java = { enable = true; jdk.package = jdk; gradle = { enable = true; package = pkgs.gradle_9; }; }; env = { JDK21_HOME = jdk.home; NIX_LD = ...; NIX_LD_LIBRARY_PATH = ...; LD_LIBRARY_PATH = config.env.NIX_LD_LIBRARY_PATH; LOCALE_ARCHIVE = ...; }; scripts.start.exec = "gradle bootRun"; scripts.test.exec = "gradle test"; enterShell = баннер с java -version; }`
- build.gradle.kts: `org.springframework.boot` v4.1.1 + `io.spring.dependency-management`, `java` plugin, toolchain 21, deps: `spring-boot-starter-web`, `spring-boot-starter-security`, `spring-boot-starter-test`, `org.xerial:sqlite-jdbc`, `org.springframework.boot:spring-boot-jdbc` (JdbcClient), Jackson (идёт со стартером), `dev.langchain4j:langchain4j-bom:1.20.1` (import) + `langchain4j-anthropic`, `langchain4j-open-ai`, `langchain4j-mcp:1.20.1-beta30`, `io.modelcontextprotocol.sdk:mcp:2.0.1`, `org.zeroturnaround:zt-exec:1.13.0`, `io.github.java-diff-utils:java-diff-utils:<latest 4.x>`, `org.bouncycastle:bcprov-jdk18on` + `bcpkix-jdk18on` (latest 1.x). Все версии сверить с Maven Central на момент исполнения
- application.yml: `server.address: 0.0.0.0`, `server.port: 8443`, `jhin.home: ${JHIN_HOME:${user.home}/.jhin}`, `jhin.role: hub`
- SmokeTest: `@SpringBootTest` + `@TestConfiguration` — контекст поднимается
- Приёмка: `direnv allow` в backend/ → `gradle bootRun` стартует, `curl -k https://localhost:8443/health` → 401 (пока всё закрыто — норм) или 200 если health открыт на этом этапе
- QA: `gradle test` зелёный; вывод `java -version` = 21
- Commit: `feat(backend): spring boot skeleton with devenv`

**T3. Frontend devenv + Flutter скелет**
- Файлы: `frontend/devenv.nix`, `frontend/.envrc`, `frontend/pubspec.yaml`, `frontend/lib/main.dart`, платформы `android/`, `linux/`, `web/` (`flutter create --platforms=android,linux,web .`)
- devenv.nix — стиль юзера etransportas-примера: `packages = [flutter jdk17 android-tools cmake ninja pkg-config gtk3 pcre aapt]`; env: `ANDROID_HOME/ANDROID_SDK_ROOT=$HOME/Android/Sdk`, `JAVA_HOME`, `GRADLE_USER_HOME=$PWD/.gradle_home`, `PATH`, `LD_LIBRARY_PATH`; `dotenv.enable = true`; `scripts.run/runp/runr`; **enterShell генерирует `.vscode/settings.json` через mktemp+cmp** (`dart.flutterSdkPath`, `java.import.gradle.java.home`, `java.server.launchMode=LightWeight`); `flutter config --jdk-dir`
- pubspec: `sdk: ^3.5`, deps: `http`, `flutter_secure_storage`, `shared_preferences`, `provider`, `fl_chart`, `flutter_markdown_plus` (проверить pub.dev; фолбэк `markdown_widget`), `path_provider`
- main.dart: счётчик-заглушка (стандартный шаблон)
- Приёмка: `direnv allow` → `flutter run -d linux` открывает окно; `flutter build web` успешен
- QA: `flutter analyze` — 0 ошибок; `flutter test` зелёный
- Commit: `feat(frontend): flutter skeleton with devenv (android/linux/web)`

**T4. Smoke-верификация каркаса**
- Проверить ВСЁ сквозное: backend стартует из `gradle bootRun` И из `java -jar` (после `gradle bootJar`); frontend запускается на linux и web
- QA: логи обоих приложений прикладываются; `gradle bootJar` создаёт `build/libs/*.jar`
- Commit: отсутствует (верификация), либо фикс-коммиты если что-то чинилось

---

### Фаза 1 — Домен и хранилище

**T5. Миграции + DataSource**
- Файлы: `db/V1__init.sql` (§4), `core/db/DatabaseConfig.java`, `core/db/MigrationRunner.java`
- MigrationRunner: при старте читает `schema_version`, применяет `.sql` из classpath по порядку в транзакции. SQLite прагмы при создании соединения: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`
- Файл БД: `${jhin.home}/jhin.db`, права `0600` (Files.setPosixFilePermissions, на Windows — skip)
- Приёмка: старт создаёт БД со всеми таблицами; повторный старт не падает (idempotent)
- QA: `sqlite3 $JHIN_HOME/jhin.db ".tables"` выводит 8 таблиц; тест `MigrationRunnerTest` (temp dir)
- Commit: `feat(backend): sqlite schema + migration runner`

**T6. Single-writer очередь записи**
- Файлы: `core/db/WriteQueue.java`
- Все INSERT/UPDATE идут через один `ExecutorService` (single thread) → `CompletableFuture`. Чтения — напрямую из DataSource. Обоснование: SQLite + конкурентные писатели = SQLITE_BUSY
- Приёмка: тест 100 параллельных записей → все в БД, порядок seq не нарушен
- QA: `WriteQueueTest` зелёный
- Commit: `feat(backend): single-writer queue for sqlite`

**T7. Event log service**
- Файлы: `core/events/EventLogService.java`, `core/events/Event.java`, `core/events/EventTypes.java`
- API: `append(sessionId, type, payload) → Event` (seq = max+1 внутри write-queue, атомарно), `readRange(sessionId, fromSeq, toSeq)`, `latestSeq(sessionId)`
- Payload — Jackson `Map<String,Object>` → JSON-строка
- Приёмка: append 10 событий → seq 1..10 без дыр; readRange(5) возвращает 6..10
- QA: `EventLogServiceTest` (последовательность, конкурентный append через WriteQueue)
- Commit: `feat(backend): event log with monotonic seq`

**T8. Аккаунты, устройства, enrollment + admin CLI**
- Файлы: `core/accounts/AccountService.java`, `DeviceService.java`, `EnrollmentService.java`, `admin/AdminCli.java`, `admin/AdminMain.java`
- Enrollment: код = 128 бит → base32 (26 симв), хранится SHA-256, TTL 10 мин, одноразовый, сверка constant-time (`MessageDigest.isEqual`)
- Device token: 256 бит → base64url, в БД SHA-256, revoke мгновенный, `last_seen`/`last_ip` обновляются при auth
- AdminMain: `main()` проверяет `args[0]=="admin"` ДО запуска Spring → режим без веб-сервера (`spring.main.web-application-type=none`). Команды: `create-account <name>` (печатает enrollment-код), `create-enrollment <account>`, `list-accounts`, `list-devices <account>`, `revoke-device <id>`
- Сборка: bootJar manifest `Main-Class` → AdminMain (или `Start-Class` + launch script); `java -jar jhin.jar admin create-account alice` работает
- Приёмка: create-account печатает код; list-devices пуст; revoke работает
- QA: `AdminCliTest` (temp JHIN_HOME, код валиден один раз, второй раз отклонён, протухший отклонён)
- Commit: `feat(backend): accounts, devices, enrollment, admin cli`

---

### Фаза 2 — Безопасность

**T9. Spring Security filter chain**
- Файлы: `core/security/SecurityConfig.java`, `BearerTokenFilter.java`, `DevicePrincipal.java`
- `sessionManagement(STATELESS)`, `csrf.disable()`, `authorizeHttpRequests`: permitAll = `POST /enroll`, `GET /health`; остальное `authenticated()`
- BearerTokenFilter: `Authorization: Bearer <token>` → SHA-256 → lookup devices (не revoked) → `DevicePrincipal(accountId, deviceId)` в SecurityContextHolder; невалидный → 401
- Rate limit на анонимные эндпоинты: in-memory, `/enroll` 3/мин/IP, `/auth/*` зарезервировано; простой sliding window Map<ip, deque>
- Приёмка: без токена всё кроме /enroll и /health → 401; с токеном → 200
- QA: `SecurityConfigTest` (MockMvc): 401/200 матрица
- Commit: `feat(backend): stateless bearer auth filter chain`

**T10. /enroll эндпоинт**
- Файлы: `api/EnrollController.java`, `api/dto/`
- `POST /enroll {code, deviceName}` → проверка кода (constant-time, TTL, one-time) → создание device + токен → `{deviceToken, accountId, accountName}`. Ошибки: 400 (невалидный/протухший/used)
- Приёмка: свежий код → токен; повтор → 400
- QA: `EnrollControllerTest` (MockMvc, happy + used + expired + rate-limit 4-й запрос за минуту → 429)
- Commit: `feat(backend): enrollment endpoint`

**T11. TLS: самоподписанный сертификат + TOFU**
- Файлы: `core/security/TlsKeyStoreGenerator.java`, правки `application.yml`
- При первом старте: BouncyCastle генерирует RSA-2048 self-signed (CN=hostname, SAN=IP+hostname), пишет `${jhin.home}/keystore/server.p12` (пароль случайный, рядом в файле `0600`), `server.ssl.*` из него. Fingerprint SHA-256 сертификата печатается в лог при каждом старте
- Приёмка: первый старт генерит keystore; `curl -k https://host:8443/health` работает; fingerprint в логе
- QA: `TlsKeyStoreGeneratorTest` (генерация, повторный старт переиспользует); ручной curl с `-vk`
- Commit: `feat(backend): self-signed tls generation on first start`

**T12. SSE-инфраструктура: cap + реестр эмиттеров**
- Файлы: `core/sse/SseRegistry.java` (реестр `SseEmitter` по deviceId), `core/sse/SseStreamService.java`
- Cap жизни стрима 15 мин → `complete()`; heartbeat каждые 15с (`: ping`); при revoke токена — немедленный `complete()` всех эмиттеров deviceId
- Приёмка: стрим закрывается сам через 15 мин (тест с укороченным cap через конфиг), revoke закрывает мгновенно
- QA: `SseRegistryTest`
- Commit: `feat(backend): sse registry, stream cap, revoke propagation`

---

### Фаза 3 — Тулы

**T13. Tool SPI + реестр**
- Файлы: `core/tools/spi/ToolDefinition.java`, `ToolResult.java`, `ToolContext.java`, `ToolCallGuard.java`, `ToolResultTransformer.java`, `ToolProvider.java`, `core/tools/ToolRegistry.java`
- ToolDefinition: `name, label, description, parametersSchema (Map — JSON Schema), promptSnippet, promptGuidelines, execute(ToolCall, ToolContext) → ToolResult`
- ToolRegistry: собирает из `List<ToolProvider>` (Spring-инъекция), guard-цепочка (`List<ToolCallGuard>` по @Order, первый BLOCK → результат-ошибка), transformer-цепочка после исполнения
- Path-sandbox в ToolContext: `resolvePath(path)` — нормализация, выход за workdir → `ToolException("Path goes outside of workspace")`
- Приёмка: registry отдаёт 9 тулов; guard BLOCK останавливает; sandbox режет `../`
- QA: `ToolRegistryTest`, `PathSandboxTest` (symlink-эскейп тоже: `toRealPath` + startsWith)
- Commit: `feat(backend): tool spi, registry, path sandbox`

**T14. bash tool**
- Файлы: `core/tools/impl/BashTool.java`
- zt-exec: стриминг stdout/stderr построчно в ToolUpdate (событие `tool_result` с флагом streaming), timeout (сек → null = без лимита, max Int.MAX ms), по cancel/timeout — tree-kill: `ProcessHandle.of(pid).descendants()` + self, `destroyForcibly`
- Усечение: 2000 строк / 51200 байт, флаг `truncated`
- Приёмка: `echo hi` → вывод; `sleep 100` с timeout=2 → убит; фоновый `sh -c 'sleep 100 & echo ok'` → потомки убиты
- QA: `BashToolTest` (happy, timeout, tree-kill через spawn дочернего)
- Commit: `feat(backend): bash tool with streaming and tree-kill`

**T15. read / write / edit / edit-diff**
- Файлы: `core/tools/impl/ReadTool.java`, `WriteTool.java`, `EditTool.java`, `EditDiffTool.java`
- read: offset/limit (1-indexed), усечение 2000/51200; изображение по magic-байтам/mime → `{type:image, mimeType, data:base64}` (без ресайза)
- write: guard «сначала прочитай» — ToolContext хранит Set прочитанных путей текущего run; новый файл — разрешён без guard
- edit: literal replace (String.replace), `replaceAll?` (default false → замена первого вхождения), нет совпадений → ошибка «No matches found for oldString»
- edit-diff: unified diff через java-diff-utils, не применяет
- Приёмка: каждый сценарий Pi-паритета
- QA: `FileToolsTest` (read offset/limit, image, write guard, edit no-match, diff формат)
- Commit: `feat(backend): file tools read/write/edit/edit-diff`

**T16. find / grep / ls + gitignore**
- Файлы: `core/tools/impl/FindTool.java`, `GrepTool.java`, `LsTool.java`, `core/tools/gitignore/GitIgnore.java`
- GitIgnore: парсер (комментарии, `*`, `**`, `?`, `[...]`, `!negation`, `dir/`), применяется к относительным путям от workdir
- find: `Files.walk` + glob (`pattern`), limit 1000, сортировка
- grep: `Files.lines` + `Pattern` (literal → `Pattern.quote`), ignoreCase, context N строк до/после, лимит строки 2000 симв, limit 100 совпадений, флаги `matchLimitReached`/`linesTruncated`
- ls: записи, каталоги с `/`, limit 500
- Приёмка: на тестовом дереве с .gitignore все три тула уважают игнор
- QA: `GitIgnoreTest` (паттерны-матрица), `SearchToolsTest`
- Commit: `feat(backend): find/grep/ls pure java with gitignore`

**T17. powershell tool**
- Файлы: `core/tools/impl/PowerShellTool.java`
- Регистрируется ТОЛЬКО если `System.getProperty("os.name")` содержит windows. Реализация через zt-exec + `powershell -Command`. На Linux в тестах — проверка что тул отсутствует в registry
- QA: `PowerShellToolTest` (conditional registration)
- Commit: `feat(backend): powershell tool (windows only)`

**T18. Сборка системного промпта**
- Файлы: `core/agent/SystemPromptBuilder.java`, `resources/prompts/base-prompt.md`
- base-prompt.md: свой текст по мотивам Pi (роль coding agent, аккуратность с файлами, использование тулов). Секции: base + `\n## {tool.name}\n{promptSnippet}\nGuidelines:\n- ...` для каждого тула + содержимое `{workdir}/AGENTS.md` если есть
- PromptInterceptor SPI применяется последним (мутирует итог)
- Приёмка: промпт содержит все 3 секции; interceptor может переписать
- QA: `SystemPromptBuilderTest`
- Commit: `feat(backend): system prompt assembly with tool guidance`

---

### Фаза 4 — Агент

**T19. Provider registry + CRUD API**
- Файлы: `core/llm/LlmProviderFactory.java` (SPI), `core/llm/ProviderRegistry.java`, `core/llm/BuiltinFactories.java` (AnthropicFactory, OpenAiFactory, GeminiFactory), `api/ProviderController.java`
- Builtin: anthropic → `AnthropicChatModel` (LC4j), openai → `OpenAiChatModel` с `.baseUrl()` (OpenRouter/Ollama/LM Studio/vLLM/Meridian — всё этим путём), gemini → модуль LC4j google (**артефакт сверить на Maven Central; если не резолвится — factory не регистрировать, задокументировать в README, задача не падает**)
- Провайдер = `{name, format, baseUrl?, apiKey, model, isDefault}`. API ключи в БД (файл 0600 — принято)
- Приёмка: CRUD через API; registry строит ChatModel по конфигу
- QA: `ProviderRegistryTest` (фабрики создают модели с тестовыми конфигами, без реальных вызовов); MockMvc CRUD
- Commit: `feat(backend): llm provider registry and crud`

**T20. Agent loop**
- Файлы: `core/agent/AgentLoop.java`, `core/agent/RunService.java`, `core/agent/RunContext.java`
- Цикл: user message → событие `run_start` → LLM streaming call (`StreamingChatResponseHandler`: onPartialResponse → событие `text_delta`) → tool calls из ответа → на каждый: событие `tool_use` → guard-цепочка → execute → transformer → событие `tool_result` → результаты в историю → повторный вызов LLM → пока есть tool calls → `run_end`
- Отмена: `cancel(runId)` → `CompletableFuture.cancel` + abort LLM stream + tree-kill активного bash → статус CANCELLED
- Run живёт в собственном executor (не блокирует SSE); обрыв SSE НЕ убивает run
- Usage: `TokenUsage` из ответа → `runs.usage_json`
- Ошибка рестарта hub во время run: при старте все RUNNING → INTERRUPTED
- Приёмка: сквозной прогон с mock-ChatModel (тестовая фабрика, отдающая фиксированные tool calls) — события в логе в правильном порядке
- QA: `AgentLoopTest` (mock-модель: text-only, tool-call loop, cancel, guard-block)
- Commit: `feat(backend): agent loop with streaming, tools, cancel`

**T21. MCP client**
- Файлы: `core/mcp/McpService.java`, конфиг `${jhin.home}/mcp.json` (`{"mcpServers": {"name": {"command": [...]} | {"url": "..."}}}`)
- `langchain4j-mcp` `McpToolProvider`: stdio + HTTP транспорты; тулы MCP вливаются в ToolRegistry как ToolDefinition-обёртки (name prefix `mcp_{server}_`)
- Отсутствие файла/серверов — норма (пустой реестр)
- Приёмка: с тестовым MCP-сервером (echo-сервер из примеров SDK или минимальный скрипт) тул появляется в registry и вызывается
- QA: `McpServiceTest` (stdio echo-сервер: обнаружение тула + вызов)
- Commit: `feat(backend): mcp client integration`

---

### Фаза 5 — API и SSE

**T22. REST API: sessions + messages + cancel**
- Файлы: `api/SessionController.java`, `api/MessageController.java`, `core/sessions/SessionService.java`
- Эндпоинты из §5. `POST /sessions/{id}/messages` → создаёт run, возвращает `{runId}` немедленно (run асинхронный)
- Authz: `findByIdAndAccountId` в репозитории
- Приёмка: полный CRUD; чужая сессия → 404 (не 403 — не раскрываем существование)
- QA: `SessionControllerTest` (два аккаунта, изоляция)
- Commit: `feat(backend): session and message api`

**T23. SSE stream endpoint**
- Файлы: `api/EventStreamController.java`
- `GET /sessions/{id}/events?fromSeq=N` → SseEmitter: replay из БД (события с seq >= N) → live-tail (подписка на EventLogService). Каждое событие SSE: `id: {seq}`, `event: {type}`, `data: {payload}`
- Интеграция с SseRegistry (T12): cap 15 мин, heartbeat, revoke-close
- Приёмка: клиент с fromSeq=0 получает всю историю + live; реконнект с fromSeq=последний — только новые
- QA: `EventStreamControllerTest` (replay, live, resume после разрыва)
- Commit: `feat(backend): sse event stream with fromseq resume`

**T24. /admin/reload + graceful restart**
- Файлы: `api/AdminController.java`, `core/reload/ReloadService.java`
- `POST /admin/reload` (auth): пометить runs RUNNING → INTERRUPTED, закрыть SSE-эмиттеры (клиенты реконнектятся), `System.exit(0)` через 2 сек. Wrapper `deploy/run.sh` перезапускает. Клиент после реконнекта перечитывает `/ui/manifest`
- Dev-режим (`gradle bootRun`): reload отвечает 503 с текстом «restart manually» (нет wrapper)
- Приёмка: под run.sh — процесс перезапускается, БД целая, клиент реконнектится
- QA: ручной сценарий + `ReloadServiceTest` (unit: статус-переходы)
- Commit: `feat(backend): graceful reload endpoint`

---

### Фаза 6 — Плагины

**T25. Plugin loader**
- Файлы: `core/plugins/PluginLoader.java`, `core/plugins/PluginManager.java`
- Скан `${jhin.home}/plugins/*.jar` → URLClassLoader (parent = app classloader) → `ServiceLoader.load` для всех 5 SPI → регистрация в реестры (tools, guards, transformers, interceptors, provider factories). Ошибка одного jar — лог + пропуск, не падение
- Порядок: плагины после built-in. `/reload` перечитывает всё (рестарт процесса)
- Приёмка: jar в plugins/ → тул/интерсептор появляются после рестарта
- QA: `PluginLoaderTest` (тестовый jar в temp plugins/, загрузка + изоляция ошибки битого jar)
- Commit: `feat(backend): plugin loader (serviceLoader + urlclassloader)`

**T26. Example plugin**
- Файлы: `plugins/example/build.gradle.kts`, `plugins/example/src/...`, `plugins/example/README.md`
- Демо-плагин: (а) ToolProvider с тулом `example_time` (возвращает текущее время), (б) PromptInterceptor, добавляющий строку в промпт, (в) ToolCallGuard, блокирующий `bash` с паттерном `rm -rf /`, (г) UI-пример: событие `ui` с JSON-карточкой (см. T30 примитивы)
- README: как собрать (`gradle jar`), куда положить, как проверить
- Приёмка: собранный jar в plugins/ → после рестарта тул виден модели, guard блокирует rm -rf /
- QA: ручной сценарий по README + скриншот/лог в отчёт
- Commit: `feat(plugins): example plugin with tool, guard, interceptor`

---

### Фаза 7 — Flutter клиент

**T27. Core инфраструктура клиента**
- Файлы: `frontend/lib/core/api/api_client.dart` (интерфейс + http-реализация), `sse_transport.dart` (интерфейс), `sse_io.dart` (HttpClient + парсер text/event-stream), `sse_web.dart` (fetch + Stream, `package:web`), `token_storage.dart` (интерфейс), `secure_token_storage.dart` (flutter_secure_storage), `prefs_token_storage.dart` (shared_preferences, web), `tls_trust.dart` (TOFU: badCertificateCallback + fingerprint SHA-256)
- Парсер SSE: строки `id:`, `event:`, `data:`, dispatch по event
- Приёмка: unit-тесты парсера; io-транспорт коннектится к локальному тестовому серверу
- QA: `flutter test` (парсер, storage-фолбэк)
- Commit: `feat(frontend): api/sse/token infrastructure with tofu`

**T28. Connect + enrollment экран**
- Файлы: `frontend/lib/screens/connect_screen.dart`
- Поля: URL хоста, enrollment-код (вставка строкой). Кнопка Connect → `POST /enroll` → токен в TokenStorage + fingerprint сертификата показывается и сохраняется (TOFU). Ошибки валидно показываются
- Приёмка: реальный enrollment против локального бэкенда проходит
- QA: ручной сценарий + widget-тест полей
- Commit: `feat(frontend): connect screen with enrollment`

**T29. Sessions + Chat экраны**
- Файлы: `frontend/lib/screens/sessions_screen.dart`, `chat_screen.dart`, `lib/core/state/session_store.dart`
- Sessions: список (GET /sessions), создание (title, workdir, модель)
- Chat: лента событий → сообщения (user_message, text_delta склейка, tool_use/tool_result карточки с заголовком и свёрнутым телом), input + send (POST messages), кнопка Cancel во время run, dropdown выбора модели (из /providers)
- SSE: подключение к стриму сессии с fromSeq=latest при открытии, реконнект с backoff
- Приёмка: два клиента (linux + web) на одной сессии видят один поток, оба пишут
- QA: ручной сценарий двух клиентов + widget-тесты ленты
- Commit: `feat(frontend): sessions and chat with live sse`

**T30. UI-рендерер примитивов**
- Файлы: `frontend/lib/ui/renderer/ui_renderer.dart`, `primitives/*.dart` (по файлу на примитив), `ui_registry.dart`
- `buildUi(Map json) → Widget`; реестр `Map<String, Builder>`; примитивы: `container, card, text, button, dropdown, list, drawer, form(textfield, checkbox, switch, slider), chart_line, chart_bar, chart_pie (fl_chart), figure(rectangle|circle|triangle, CustomPaint), table, markdown`
- События кнопок/форм → POST на указанный в JSON endpoint (или событие `ui_action` в стрим — решение: POST `/sessions/{id}/ui-action {action, payload}` → бэкенд публикует событие `ui` в лог)
- Неизвестный тип → карточка-заглушка с именем типа
- Приёмка: демо-JSON со всеми примитивами рендерится без падений
- QA: `flutter test` — golden/widget-тесты на каждый примитив
- Commit: `feat(frontend): sdui renderer with full primitive set`

**T31. Settings экран + Reload**
- Файлы: `frontend/lib/screens/settings_screen.dart`
- Провайдеры: список + форма (name, format dropdown {anthropic,openai,gemini}, baseUrl, apiKey, model, isDefault), CRUD на API
- Кнопка Reload → `POST /admin/reload` → ожидание → реконнект + перечитать `/ui/manifest`
- Показ fingerprint устройства + кнопка «забыть токен» (локально)
- Приёмка: провайдер создаётся и появляется в dropdown чата; reload переживается с реконнектом
- QA: ручной сценарий
- Commit: `feat(frontend): settings with providers and reload`

**T32. UI manifest интеграция**
- Файлы: backend `api/UiManifestController.java` (если не сделан в T22 — сделать здесь), frontend `lib/core/state/manifest_store.dart`
- Manifest: `{tools: [{name, description}], primitives: [names], version}`. Клиент хранит, обновляет после reload
- Приёмка: после добавления плагина manifest содержит новый тул
- QA: интеграционный тест backend
- Commit: `feat: ui manifest endpoint and client store`

---

### Фаза 8 — QA и документация

**T33. Сквозные интеграционные тесты backend**
- Файлы: `backend/src/test/java/com/astroreen/jhin/it/`
- Сценарии (SpringBootTest со случайным портом, temp JHIN_HOME): (1) enroll → auth → create session → mock-provider run с tool call → события в логе корректны; (2) два SSE-клиента одна сессия — оба получают; (3) resume с fromSeq после разрыва; (4) изоляция аккаунтов (аккаунт B не видит сессию A); (5) revoke токена → 401 + SSE закрыт
- Приёмка: `gradle test` весь зелёный
- QA: полный вывод `gradle test`
- Commit: `test(backend): end-to-end integration scenarios`

**T34. README + deploy docs**
- Файлы: `README.md` (полный), `deploy/README.md`, `docs/plugin-dev.md`
- README: что это, скриншот-плейсхолдер, quickstart (собрать jar → запустить → create-account → enroll в приложении), сборка Flutter (android/linux/web), конфиг (port, address, JHIN_HOME), безопасность (что защищает, что НЕТ — честно), roadmap-ссылка на AGENTS.md
- deploy/README: systemd unit пример (generic linux), запуск под любым юзером, бэкап = копия jhin.db
- docs/plugin-dev.md: гайд по 5 SPI + сборка плагина + UI-примитивы JSON-схема
- Приёмка: fresh-clone сценарий по README воспроизводим
- QA: прогон quickstart с нуля в temp dir
- Commit: `docs: readme, deploy guide, plugin dev guide`

---

## 10. Матрица зависимостей

```
T1 → T2, T3
T2 → T4; T3 → T4
T2 → T5 → T6 → T7 → T8
T8 → T9 → T10, T11, T12
T9 → T13 → T14, T15, T16, T17 (параллельно)
T13 → T18
T18 → T19 → T20 → T21
T20 → T22 → T23; T12 → T23
T23 → T24
T13 → T25 → T26
T4 → T27 → T28 → T29 → T31; T27 → T30 → T32
T22 → T32 (manifest endpoint)
T24, T26, T29, T30, T31, T32 → T33 → T34
```

Параллелизация: после T9 ветки backend (T13+) и frontend (T27+, нужен только T4) идут параллельно.

## 11. Must-NOT-Have (MVP не строит — исполнителю запрещено)

- Worker-протокол / удалённое исполнение тулов / синхронизация инстансов (только таблица `workers` как шов)
- PF4J, hot-swap классов в JVM, скриптовые движки (Groovy/GraalJS/hetu/dart_eval)
- Пароли, JWT, OAuth/OIDC, passkeys, refresh-rotation (только enrollment-код → device-токен)
- Traefik/reverse-proxy конфиги, VPN/tsnet, mTLS клиентских сертификатов
- Внешние бинарники в тулах (fd, ripgrep, shell-обёртки поиска)
- MCP-сервер (только клиент), MCP Apps/iframe UI
- Approval-gate UI на тулы
- Compaction/branching сессий (Pi-фичи; при переполнении контекста — ошибка + юзер создаёт новую сессию)
- Kanban/todo/stats экраны, дропдаун хостов (швы в схеме есть — фичи позже)
- Windows/iOS сборки (код совместим, сборка не настраивается)
- NixOS-модуль (deploy = generic systemd пример + jar)
- OS-level изоляция аккаунтов (uid/nftables) — только app-layer
- Ресайз изображений в read (base64 as-is)
- Свой CBOR/бинарный протокол — только JSON + SSE

## 12. UNVERIFIED — проверить при исполнении (не блокирует старт)

1. Артефакт LC4j Gemini (`langchain4j-google-ai-gemini`?) — сверить на Maven Central; нет → пропустить factory
2. `flutter_markdown_plus` на pub.dev (оригинал discontinued) — фолбэк `markdown_widget`
3. `java-diff-utils` актуальная 4.x версия
4. SSE через fetch на Flutter Web с кастомными заголовками — спайк в T27; если fetch-стрим не читается — фолбэк: web-клиент передаёт токен через cookie, выставленную `/auth/token-set` (одноразовый POST → httpOnly cookie), задокументировать
5. BouncyCastle/BOM версии — сверить с Maven Central на день исполнения
6. Spring Boot 4.1.1 + gradle 9 совместимость — если bootRun падает, откатиться на последний проверенный Boot 3.5.x (решение исполнителя, задокументировать)

## 13. Риски

- **SQLite + JPA** — не используем JPA вообще (JdbcClient), риск снят
- **Переполнение контекста** — без compaction длинные сессии упрутся; ошибка обрабатывается явно, сообщение юзеру
- **TOFU на web** — браузер сам, юзер принимает warning; задокументировать
- **Prompt injection** — агент исполняет shell на хосте бэкенда; MVP принимает риск (один юзер-владелец), аудит/сандбокс — фаза 2 (записано в AGENTS.md)