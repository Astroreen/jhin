plugins {
    java
    id("org.springframework.boot") version "4.1.1"
    id("io.spring.dependency-management") version "1.1.7"
}

group = "com.astroreen"
version = "0.1.0-SNAPSHOT"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

repositories {
    mavenCentral()
}

// LangChain4j публикует свой BOM отдельно от Spring-BOM — импортируем через dependencyManagement.
dependencyManagement {
    imports {
        mavenBom("dev.langchain4j:langchain4j-bom:1.20.1")
    }
}

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("org.springframework.boot:spring-boot-starter-jdbc")

    // SQLite JDBC-драйвер — единственное хранилище (event-sourcing лог в SQLite).
    implementation("org.xerial:sqlite-jdbc:3.53.4.0")

    // LangChain4j — версии моделей берём из BOM, коннекторы фиксируем явно.
    implementation("dev.langchain4j:langchain4j-anthropic")
    implementation("dev.langchain4j:langchain4j-open-ai")
    implementation("dev.langchain4j:langchain4j-google-ai-gemini")
    implementation("dev.langchain4j:langchain4j-mcp:1.20.1-beta30")

    // MCP Java SDK — используем только как клиент (правило: MCP-сервер не в MVP).
    implementation("io.modelcontextprotocol.sdk:mcp:2.0.1")

    // zt-exec — обёртка над ProcessBuilder для тулов, исполняющих внешние команды пользователя.
    implementation("org.zeroturnaround:zt-exec:1.13.0")

    // java-diff-utils — генерация unified diff для тула правки файлов.
    implementation("io.github.java-diff-utils:java-diff-utils:4.17")

    // BouncyCastle — крипто-примитивы для enrollment-кода/device-токенов (без JWT/OAuth).
    implementation("org.bouncycastle:bcprov-jdk18on:1.86")
    implementation("org.bouncycastle:bcpkix-jdk18on:1.86")

    testImplementation("org.springframework.boot:spring-boot-starter-test")
}

tasks.withType<Test> {
    useJUnitPlatform()
}
