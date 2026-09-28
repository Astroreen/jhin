plugins {
    java
}

group = "com.astroreen"
version = "0.1.0"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

// SPI-контракты Jhin (ToolProvider, PromptInterceptor, ToolCallGuard и пр.) живут в
// backend. Кладём их compileOnly: классы SPI НЕ попадают в plugin-jar — иначе
// ServiceLoader увидит дубли интерфейсов и плагин не загрузится. В plugin-jar, кроме
// наших классов и META-INF/services, ничего не должно быть: только JDK + SPI ядра.
//
// Берём THIN jar (`jar`-таск backend, артефакт с классами на корне zip): bootJar-артефакт
// jhin-backend-*.jar — Spring Boot fat jar, его классы лежат под BOOT-INF/classes и javac
// их не видит. Порядок сборки: сначала backend (cd backend && ./gradlew bootJar jar),
// потом этот проект.
dependencies {
    compileOnly(files("../../backend/build/libs/jhin-backend-0.1.0-SNAPSHOT-plain.jar"))
}

// Gradle wrapper здесь не нужен: это dev-артефакт, сборка — `gradle jar` из окружения.
tasks.jar {
    archiveBaseName.set("jhin-example-plugin")
}
