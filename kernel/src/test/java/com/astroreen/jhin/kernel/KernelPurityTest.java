package com.astroreen.jhin.kernel;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.charset.MalformedInputException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * Mechanically enforces the domain-free kernel rule (D-2) and the
 * dependency-purity rule (D-8). The kernel must never mention product
 * concepts (tool, session, agent, ...) and must never pull in
 * spring-security, langchain4j, or the MCP SDK.
 */
class KernelPurityTest {

    /** Domain words banned in kernel sources (case-insensitive, whole word). */
    private static final List<String> BANNED_WORDS =
            List.of(
                    "tool",
                    "session",
                    "agent",
                    "message",
                    "provider",
                    "enroll",
                    "account",
                    "device",
                    "llm",
                    "prompt",
                    "workdir",
                    "hub",
                    "worker",
                    "role");

    /** Whole-word pattern for the banned domain words. */
    private static final Pattern BANNED =
            Pattern.compile(
                    "\\b(" + String.join("|", BANNED_WORDS) + ")\\b", Pattern.CASE_INSENSITIVE);

    /**
     * Hard substring: raw {@code ServletRequest} must not appear anywhere.
     * {@code HttpServletRequest} is the standard Jakarta Servlet type used by
     * the HTTP layer and is exempt via the negative lookbehind.
     */
    private static final Pattern SERVLET_REQUEST =
            Pattern.compile("(?<!Http)ServletRequest", Pattern.CASE_INSENSITIVE);

    /** Hard substring: Spring Security session management must not appear. */
    private static final Pattern SESSION_MANAGEMENT =
            Pattern.compile("sessionManagement", Pattern.CASE_INSENSITIVE);

    /**
     * Wire-contract JSON keys that unavoidably collide with banned words.
     * These are string literals in JSON payloads, not domain identifiers.
     * Format: "path:line:word"
     */
    private static final Set<String> ALLOWED =
            Set.of(
                    "kernel/src/main/java/com/astroreen/jhin/kernel/KernelRoutes.java:117:message");

    /** Artifacts that must never appear on the kernel runtime classpath. */
    private static final Pattern BANNED_ARTIFACT =
            Pattern.compile("spring-security|langchain4j|modelcontextprotocol");

    @Test
    void kernelSourcesAreDomainFree() throws IOException {
        List<String> violations = new ArrayList<>();
        scan(Path.of("src/main/java"), violations);
        scan(Path.of("src/main/resources"), violations);
        assertThat(violations)
                .as("Kernel sources must not contain domain words")
                .isEmpty();
    }

    @Test
    void kernelClasspathIsDependencyPure() {
        String classpath = System.getProperty("java.class.path", "");
        String separator = System.getProperty("path.separator", ":");
        List<String> violations = new ArrayList<>();
        for (String entry : classpath.split(Pattern.quote(separator))) {
            if (entry.isBlank()) {
                continue;
            }
            String name = Path.of(entry).getFileName().toString();
            if (BANNED_ARTIFACT.matcher(name).find()) {
                violations.add(name);
            }
        }
        assertThat(violations)
                .as("Kernel classpath must not contain banned dependencies")
                .isEmpty();
    }

    private void scan(Path root, List<String> violations) throws IOException {
        if (!Files.isDirectory(root)) {
            return;
        }
        try (Stream<Path> paths = Files.walk(root)) {
            for (Path file : paths.filter(Files::isRegularFile).toList()) {
                String content;
                try {
                    content = Files.readString(file, StandardCharsets.UTF_8);
                } catch (MalformedInputException e) {
                    continue;
                }
                String display = "kernel/" + file.toString().replace('\\', '/');
                String[] lines = content.split("\r?\n", -1);
                for (int i = 0; i < lines.length; i++) {
                    int lineNum = i + 1;
                    String line = lines[i];
                    Matcher m = BANNED.matcher(line);
                    while (m.find()) {
                        String word = m.group().toLowerCase();
                        String key = display + ":" + lineNum + ":" + word;
                        if (!ALLOWED.contains(key)) {
                            violations.add(
                                    display
                                            + ":"
                                            + lineNum
                                            + " contains banned word '"
                                            + word
                                            + "'");
                        }
                    }
                    if (SERVLET_REQUEST.matcher(line).find()) {
                        violations.add(
                                display
                                        + ":"
                                        + lineNum
                                        + " contains banned substring 'ServletRequest'");
                    }
                    if (SESSION_MANAGEMENT.matcher(line).find()) {
                        violations.add(
                                display
                                        + ":"
                                        + lineNum
                                        + " contains banned substring 'sessionManagement'");
                    }
                }
            }
        }
    }
}