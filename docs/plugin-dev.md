# Разработка плагинов Jhin

## Идея

Каждая фича Jhin — точка расширения: поведение агента можно подправить плагином, не трогая core. Плагин — обычный Java-jar в `$JHIN_HOME/plugins/`, загружается через `URLClassLoader` + `ServiceLoader` на старте процесса. Перечитка каталога — рестартом: `POST /admin/reload` (см. [deploy/README.md](../deploy/README.md)) завершает процесс, рестартер поднимает его заново и плагины грузятся с нуля. Hot-swap классов в MVP нет и не планируется.

Пять SPI-интерфейсов (core инжектит `List<T>`, сортирует по `@Order`, итерирует сам):

| SPI | Что даёт |
|---|---|
| `PromptInterceptor` | мутирует/переписывает system prompt, может ветовать run |
| `ToolCallGuard` | ALLOW \| BLOCK вызова тула до исполнения |
| `ToolResultTransformer` | заменяет результат тула после исполнения |
| `ToolProvider` | добавляет новые тулы |
| `LlmProviderFactory` | добавляет LLM-бэкенд (свой формат провайдера) |

Рабочий образец со всеми шагами — [`plugins/example/`](../plugins/example/): тул `example_time`, interceptor в system prompt, guard, блокирующий `rm -rf /` в `bash`/`powershell`.

## Сигнатуры SPI

### PromptInterceptor

```java
package com.astroreen.jhin.core.agent.spi;

public interface PromptInterceptor {
    PromptContext intercept(PromptContext ctx) throws PluginVetoException;
}

/** Иммутабельный контекст сборки system prompt. */
public record PromptContext(String workdir, String sessionId, String runId, String systemPrompt) {
    /** Новый контекст с заменённым system prompt. */
    public PromptContext withSystemPrompt(String systemPrompt) {
        return new PromptContext(workdir, sessionId, runId, systemPrompt);
    }
}

/** Вето плагина: прерывает сборку system prompt (и run) с причиной. */
public class PluginVetoException extends Exception {
    public PluginVetoException(String reason);
    public String getReason();
}
```

Interceptors вызываются после сборки финального system prompt (база + секции тулов + инструкции проекта); возврат `null` → вето «interceptor returned null». `PluginVetoException` прерывает run — агент получает причину.

### ToolCallGuard

```java
package com.astroreen.jhin.core.tools.spi;

public interface ToolCallGuard {
    ToolCallDecision check(ToolCall call);
}

/** ALLOW (reason = null) или BLOCK(reason). */
public record ToolCallDecision(boolean allowed, String reason) {
    public static ToolCallDecision allow();
    public static ToolCallDecision block(String reason);
}

/** Вызов тула: имя, аргументы (null → empty), опциональный callId. */
public record ToolCall(String toolName, Map<String, Object> arguments, String callId) {
    public ToolCall(String toolName, Map<String, Object> arguments);
}
```

### ToolResultTransformer

```java
package com.astroreen.jhin.core.tools.spi;

public interface ToolResultTransformer {
    ToolResult transform(ToolResult r);
}
```

Исключение трансформера ловится реестром: трансформер пропускается, результат сохраняется.

### ToolProvider и ToolDefinition

```java
package com.astroreen.jhin.core.tools.spi;

public interface ToolProvider {
    List<ToolDefinition> tools();
}

public interface ToolDefinition {
    String name();                       // уникальное имя, например "bash"
    String label();                      // человекочитаемый ярлык
    String description();                // описание для LLM
    Map<String, Object> parametersSchema(); // JSON Schema объекта аргументов
    String promptSnippet();              // строка в system prompt
    List<String> promptGuidelines();     // буллеты в system prompt
    ToolResult execute(ToolCall call, ToolContext ctx);
}
```

Результат тула (immutable; фабрики `ok`/`error`):

```java
public record ToolResult(
        String content, boolean error, boolean truncated, Object structured, Map<String, Object> meta) {
    public static ToolResult ok(String content);
    public static ToolResult ok(String content, Object structured);
    public static ToolResult error(String content);
}
```

- `content` — текст для LLM;
- `structured` — JSON-объект SDUI-карточки (см. «UI-примитивы»), попадает в событие `tool_result`;
- `meta` — служебные флаги (`matchLimitReached` и т.п.).

Контекст исполнения (не Spring-бин, один на вызов):

```java
public class ToolContext {
    public Path workdir();
    public String sessionId();
    public String runId();
    public String accountId();
    public Path resolvePath(String path);   // path sandbox: выход за workdir → ToolException
    public Set<String> readPaths();
    public void markRead(Path p);
    public boolean hasRead(Path p);
    public boolean isCancelled();
    public void cancel();
    public void publish(ToolUpdate u);      // стриминг построчных апдейтов (no-op без подписчика)
}

/** Стриминговый чанк от тула. */
public record ToolUpdate(String toolName, String chunk, boolean streaming) {}

/** Ошибки sandbox и исполнения (unchecked). */
public class ToolException extends RuntimeException {
    public ToolException(String message);
    public ToolException(String message, Throwable cause);
}
```

`resolvePath` — единственный корректный способ получить путь к файлу: выход за workdir сессии (включая symlink-escape) → `ToolException("Path goes outside of workspace")`.

### LlmProviderFactory

```java
package com.astroreen.jhin.core.llm;

import dev.langchain4j.model.chat.ChatModel;

public interface LlmProviderFactory {
    String format();                       // строка формата (колонка providers.format)
    ChatModel create(ProviderConfig cfg);  // без сетевых вызовов при сборке
}

/** baseUrl — nullable (openai-совместимые кастомные эндпоинты). */
public record ProviderConfig(String format, String apiKey, String model, String baseUrl) {}
```

Встроенные форматы: `anthropic`, `openai`, `gemini`. Свой формат регистрируется один раз (first-wins), дальше доступен в `POST /providers` и в Settings клиента.

## Сборка

Плагин — standalone Gradle-проект (Java 21 toolchain). SPI-контракты берутся из backend-jar **`compileOnly`** — тонкий jar `jhin-backend-*-plain.jar` (классы на корне zip), не fat jar: у `jhin-backend-*.jar` классы лежат под `BOOT-INF/classes`, javac их не видит. Собирайте backend первым:

```bash
cd backend
./gradlew bootJar jar        # bootJar — fat jar запуска; jar — thin jar для компиляции плагинов
cd ../plugins/example
gradle jar                   # wrapper для плагина не нужен; JDK21_HOME=/path/to/jdk-21, если не найден
cp build/libs/jhin-example-plugin-0.1.0.jar "${JHIN_HOME:-$HOME/.jhin}/plugins/"
# рестарт: POST /admin/reload или запуск java -jar заново
```

Ключевые правила `build.gradle.kts` (см. [`plugins/example/build.gradle.kts`](../plugins/example/build.gradle.kts)):

```kotlin
dependencies {
    compileOnly(files("../../backend/build/libs/jhin-backend-0.1.0-SNAPSHOT-plain.jar"))
}
```

SPI-классы **не пакуются** в plugin-jar (иначе `ServiceLoader` увидит дубли интерфейсов и плагин не загрузится). В jar'е плагина — только ваши классы и `META-INF/services/`; других зависимостей нет (только JDK).

Регистрация — стандартный `ServiceLoader`: файл `src/main/resources/META-INF/services/<FQCN SPI>` на каждый реализованный интерфейс, внутри — FQCN реализации (несколько строк — несколько реализаций). Пример: [`plugins/example/src/main/resources/META-INF/services/`](../plugins/example/src/main/resources/META-INF/services/).

Плагины грузятся на старте процесса, jar'ы сортируются по имени файла (детерминированный порядок). Ошибки изолированы: битый jar (не zip) → ERROR + skip всего jar; битый `META-INF/services` → ERROR + skip одной реализации; jar без ни одной загруженной реализации → ERROR + skip. Hub от ошибок плагинов не падает.

## Правила цепочек

- **first-wins на имена тулов**: повторное имя → warn + skip, первая регистрация побеждает. Не перетирайте built-in имена: `bash`, `read`, `write`, `edit`, `edit-diff`, `find`, `grep`, `ls`, `powershell` (и форматы `anthropic`/`openai`/`gemini`).
- **Guard-цепочка**: guards вызываются по порядку цепочки (плагинные — в порядке загрузки jar, в конец); первый `BLOCK` решает — исполнение не начинается, агент получает `Blocked: <reason>`. Исключение guard'а тоже блокирует вызов.
- **Трансформеры** аддитивны, добавляются в конец; падающий пропускается, результат сохраняется.
- **Interceptors** идут в порядке цепочки (плагинные — в порядке загрузки jar, в конец). Вето (`PluginVetoException`) прерывает run.

## UI-примитивы (SDUI)

Server-driven UI: тул (или плагин) отдаёт JSON-описание интерфейса, Flutter рендерит его через свой реестр. Общий вид узла:

```json
{"type": "<primitive>", ...}
```

Рекурсивные списки узлов — поле `children` (у `list` — `items`); дочерний узел — такой же объект либо строка (эквивалент `{"type":"text","text":"..."}`). Неизвестный `type` → карточка-заглушка «Unsupported UI element: &lt;type&gt;»; любой сбой парсинга полей — мягкий деград (пусто/заглушка), никогда не падает.

### 14 примитивов

| type | Поля |
|---|---|
| `container` | `children`, `direction` `"row"`\|`"column"` (дефолт `"column"`), `padding`, `gap` (logical px, опционально) |
| `card` | `title?`, `children` |
| `text` | `text`, `style` `"h1"`\|`"h2"`\|`"body"`\|`"caption"`\|`"mono"` (дефолт `"body"`), `bold?`, `color?` |
| `button` | `label`, `action`, `payload?` (JSON-объект), `style` `"primary"`\|`"secondary"`\|`"danger"` (дефолт `"secondary"`); без `action` — disabled |
| `dropdown` | `items` `[{label, value}]`, `value?` (начальный выбор), `action` |
| `list` | `items` `[UiNode \| "строка", ...]`; прокручиваемый (высота до ~300px) |
| `drawer` | `title?`, `children` |
| `form` | `fields` (см. ниже), `submit` `{label, action}` |
| `chart_line` | `series` `[{name, color?, points: [{x, y}]}]` |
| `chart_bar` | `items` `[{label, value}]` (одна серия) **или** `series` `[{name, values: [{label, value}]}]` |
| `chart_pie` | `items` `[{label, value, color?}]` |
| `figure` | `shape` `"rectangle"`\|`"circle"`\|`"triangle"`, `color`, `width`, `height` |
| `table` | `columns` `[{label}]`, `rows` `[[ячейка, ...], ...]` |
| `markdown` | `text` |

Поля формы (`form.fields`):

```json
[
  {"kind": "textfield", "name": "f", "label": "Имя", "value": "v", "multiline": false},
  {"kind": "checkbox",  "name": "c", "label": "Галка", "value": true},
  {"kind": "switch",    "name": "s", "label": "Тумблер", "value": false},
  {"kind": "slider",    "name": "r", "label": "Уровень", "min": 0, "max": 100, "value": 50}
]
```

Неизвестные/кривые поля пропускаются. `color` везде — hex `#RRGGBB` | `#AARRGGBB` | `0xFFRRGGBB` | int.

### Как тул отдаёт карточку

`ToolResult.ok(content, structured)` — `structured` = JSON-объект примитива (обычно `card` с детьми). Пример из [`plugins/example/`](../plugins/example/):

```json
{"type": "card", "title": "Example",
 "children": [{"type": "text", "text": "2026-09-28T18:03:14Z"}]}
```

`structured` попадает в событие `tool_result` SSE-стрима, клиент рендерит его под текстом результата.

### Действия пользователя

`button` / `dropdown` / `form` зовут `onAction(action, payload)`; реализация на экранах отправляет:

```
POST /sessions/{id}/ui-action
{"action": "apply", "payload": {"name": "значение каждого поля"}}
```

Ответ — `{seq}` нового события; в SSE-стриме появляется событие типа `ui` с полезной нагрузкой `{"action": ..., "payload": ...}`. Для `dropdown` payload — `{"value": <оригинальное value>}`, для `form` — `{name: значение}` (textfield → String, checkbox/switch → bool, slider → double).

Актуальный список примитивов отдаёт и сам hub: `GET /ui/manifest` → `{tools:[{name, description}], primitives:[...], version}`.
