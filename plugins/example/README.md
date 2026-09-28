# Пример плагина для Jhin

Демо-плагин: минимальный, но рабочий пример расширения Jhin через 5 SPI-точек.
Standalone Gradle-проект, в plugin-jar не попадает ничего, кроме наших классов и
`META-INF/services` — SPI-контракты берутся из classloader'а ядра (см. «Сборка»).

## Что внутри

Три реализации SPI + один тул (`src/main/java/com/astroreen/jhin/example/`):

1. **`ExampleToolProvider`** (`ToolProvider`) — регистрирует тул `example_time`:
   возвращает текущее время (`Instant.now()`, ISO-8601), аргументов нет
   (`parametersSchema` = `{}`). Результат отдаётся и текстом, и structured-карточкой
   SDUI `{"type":"card","title":"Example","children":[{"type":"text",...}]}` —
   иллюстрация, что тулы могут отдавать UI (форма примитивов — T30).
2. **`ExamplePromptInterceptor`** (`PromptInterceptor`) — дописывает строку в конец
   system prompt: «The example plugin is active: current time is available via the
   example_time tool.»
3. **`ExampleToolCallGuard`** (`ToolCallGuard`) — блокирует вызовы `bash` и `powershell`,
   где `arguments["command"]` содержит `rm -rf /` → `ToolCallDecision.block("dangerous command")`;
   исполнение тула не начинается, агент получает ответ «Blocked: dangerous command».

Регистрация — стандартный `ServiceLoader`: `src/main/resources/META-INF/services/` содержит
3 файла (по имени каждого SPI-интерфейса, внутри — FQCN реализации).

## Сборка

Порядок важен: SPI-контракты берутся из backend-jar, сначала собираем backend.

```bash
cd backend && ./gradlew bootJar jar
cd ../plugins/example && gradle jar
```

`bootJar` — fat jar для запуска backend, `jar` — thin jar (`*-plain.jar`, классы на корне
zip) с SPI-контрактами: именно он нужен плагину на этапе компиляции.

Результат: `plugins/example/build/libs/jhin-example-plugin-0.1.0.jar`.

Gradle wrapper для плагина не нужен — это dev-артефакт, собирается `gradle jar` из окружения
(свой `settings.gradle.kts` + `build.gradle.kts`, Java 21 toolchain). Daemon JVM зафиксирован
на Java 21 (`gradle/gradle-daemon-jvm.properties`) — иначе на JDK с 4-компонентным
`java.version` (NixOS) Kotlin DSL Gradle падает в `JavaVersion.parse`. JDK 21 Gradle ищет
стандартно (JAVA_HOME, PATH) и через `JDK21_HOME` (`gradle.properties`); если не найден —
`JDK21_HOME=/path/to/jdk-21 gradle jar`. Аварийный запас на совсем старом Gradle без daemon
JVM criteria — wrapper backend (Gradle 9.8.0): `../../backend/gradlew jar`.

В `build.gradle.kts` backend-jar подключён **`compileOnly`** (`files("../../backend/build/libs/*-plain.jar")`) —
классы SPI не пакуются в plugin-jar (иначе `ServiceLoader` увидит дубли интерфейсов и плагин
не загрузится; fat jar `jhin-backend-*.jar` для этого не годится — его классы лежат под
`BOOT-INF/classes`, javac их не видит). Других зависимостей у плагина нет: только JDK + SPI ядра.

## Установка

Положите jar в каталог плагинов и перезапустите backend:

```bash
cp build/libs/jhin-example-plugin-0.1.0.jar "${JHIN_HOME:-$HOME/.jhin}/plugins/"
# рестарт: POST /admin/reload или запуск java -jar заново
```

## Проверка

1. **Тул**: в агентском промпте появляется секция `## example_time` (описание из
   `promptSnippet`/`promptGuidelines`); вызов тула возвращает текущее время.
2. **Guard**: вызов `bash` с `command: "rm -rf /"` (или `powershell` с той же командой)
   завершается ответом «Blocked: dangerous command» — команда не исполняется.
3. **Interceptor**: финальный system prompt заканчивается строкой
   «The example plugin is active: current time is available via the example_time tool.»
4. **Лог старта**: ошибки загрузки плагина видны как `ERROR ... Plugin jar ... — skipped`
   (битый jar, битые `META-INF/services`, ни одной реализации). Успешная загрузка строк
   в лог не пишет; сводка загруженного плагина (имя jar, тулы, guards, interceptors) доступна
   кодом через `PluginManager.loadedPlugins()`.

## Как написать свой плагин

1. Реализуйте один или несколько из 5 SPI:
   `core.agent.spi.PromptInterceptor`, `core.tools.spi.ToolCallGuard`,
   `core.tools.spi.ToolResultTransformer`, `core.tools.spi.ToolProvider`,
   `core.llm.LlmProviderFactory`.
2. Зарегистрируйте реализации в `META-INF/services/<FQCN SPI>` (как здесь).
3. Соберите jar и положите в `${JHIN_HOME:-$HOME/.jhin}/plugins/`, перезапустите backend.

Правила:

- **`compileOnly` на backend-jar** — SPI-классы не пакуются в plugin-jar;
  всё остальное — только JDK (никаких новых зависимостей).
- **Не переопределяйте built-in имена** (`bash`, `read`, `write`, `edit`, `edit-diff`,
  `find`, `grep`, `ls`, `powershell`) и форматы LLM-провайдеров — действует first-wins:
  первый зарегистрированный тул/формат побеждает, повторный пропускается с warn.
- Guards/transformers/interceptors — аддитивны и добавляются в конец цепочек
  (порядок — порядок загрузки jar по имени файла).
