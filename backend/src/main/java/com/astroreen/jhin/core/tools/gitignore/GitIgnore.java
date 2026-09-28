package com.astroreen.jhin.core.tools.gitignore;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Ручной парсер и мэтчер .gitignore (только JDK, без внешних библиотек).
 *
 * <p><b>Источник правил.</b> Только корневой {@code {workdir}/.gitignore} — вложенные
 * .gitignore вне скоупа. {@link #load(Path)}: файла нет → пустой мэтчер. Пустые строки
 * и комментарии ({@code #...}) пропускаются. Синтаксис строк как у git.
 *
 * <p><b>Семантика паттернов:</b>
 * <ul>
 *   <li>{@code *} — любые символы без {@code /}; {@code **} — любые символы, включая
 *       {@code /} (ведущий {@code **} + слэш и срединный слэш + {@code **} + слэш —
 *       «любое число каталогов», хвостовой слэш + {@code **} — «всё внутри»);
 *       {@code ?} — один символ без {@code /};
 *       {@code [...]} — класс символов с диапазонами и негацией {@code !}/{@code ^}.</li>
 *   <li>Хвостовой {@code /} — паттерн только для каталогов: сам каталог и всё под ним.</li>
 *   <li>Ведущий {@code /} или любой {@code /} в середине (кроме хвостового) — якорь от
 *       корня workdir; без {@code /} — basename-матч на любой глубине.</li>
 *   <li>Экранирование: {@code \#}, {@code \!}, {@code \\} и прочие {@code \<символ>}.</li>
 *   <li>Негация {@code !...} — re-include; <b>побеждает последний совпавший паттерн</b>.</li>
 *   <li>Игнорированный каталог игнорирует всё своё содержимое: re-include файла под
 *       игнорируемым каталогом невозможен (как у git).</li>
 * </ul>
 *
 * <p>Каждый паттерн транслируется в regex вручную. Пути тестируются в POSIX-форме
 * (разделители {@code /}, относительно корня workdir). API: {@link #isIgnored(String, boolean)}.
 */
public final class GitIgnore {

    private final List<Rule> rules;

    private GitIgnore(List<Rule> rules) {
        this.rules = List.copyOf(rules);
    }

    /** Читает {@code {workdir}/.gitignore}; файла нет → пустой мэтчер (ничего не игнорирует). */
    public static GitIgnore load(Path workdir) throws IOException {
        Path file = workdir.resolve(".gitignore");
        if (!Files.isRegularFile(file)) {
            return new GitIgnore(List.of());
        }
        return parse(Files.readString(file));
    }

    /** Парсит содержимое .gitignore (используется и в тестах). */
    public static GitIgnore parse(String content) {
        List<Rule> rules = new ArrayList<>();
        for (String line : content.lines().toList()) {
            addRule(rules, line);
        }
        return new GitIgnore(rules);
    }

    /**
     * Игнорируется ли путь (workdir-relative, POSIX-разделители).
     * {@code isDirectory} — подсказка для паттернов с хвостовым {@code /}.
     */
    public boolean isIgnored(String relativePath, boolean isDirectory) {
        String path = normalize(relativePath);
        if (path.isEmpty()) {
            return false;
        }
        int slash = path.indexOf('/');
        while (slash >= 0) {
            if (lastMatch(path.substring(0, slash), true)) {
                return true;
            }
            slash = path.indexOf('/', slash + 1);
        }
        return lastMatch(path, isDirectory);
    }

    /** Последний совпавший паттерн решает; не совпал ни один → не игнорирован. */
    private boolean lastMatch(String path, boolean isDirectory) {
        Boolean ignored = null;
        for (Rule rule : rules) {
            if (rule.dirOnly() && !isDirectory) {
                continue;
            }
            if (rule.regex().matcher(path).matches()) {
                ignored = !rule.negated();
            }
        }
        return Boolean.TRUE.equals(ignored);
    }

    private static String normalize(String path) {
        String s = path.replace('\\', '/');
        while (s.startsWith("./")) {
            s = s.substring(2);
        }
        while (s.startsWith("/")) {
            s = s.substring(1);
        }
        while (s.endsWith("/")) {
            s = s.substring(0, s.length() - 1);
        }
        return s;
    }

    private static void addRule(List<Rule> rules, String line) {
        String s = line.strip();
        if (s.isEmpty() || s.startsWith("#")) {
            return;
        }
        boolean negated = false;
        if (s.startsWith("!")) {
            negated = true;
            s = s.substring(1);
            if (s.isEmpty()) {
                return;
            }
        }
        boolean dirOnly = false;
        while (s.endsWith("/")) {
            s = s.substring(0, s.length() - 1);
            dirOnly = true;
            if (s.isEmpty()) {
                return;
            }
        }
        boolean anchored = s.indexOf('/') >= 0;
        if (s.startsWith("/")) {
            s = s.substring(1);
            if (s.isEmpty()) {
                return;
            }
            anchored = true;
        }
        String body = translate(s);
        String regex = anchored ? body : "(?:.*/)?" + body;
        rules.add(new Rule(Pattern.compile("^" + regex + "$"), negated, dirOnly));
    }

    /** Трансляция glob-фрагмента в regex (тело паттерна без якоря/негации/слэшей-якорей). */
    private static String translate(String glob) {
        StringBuilder rx = new StringBuilder();
        int n = glob.length();
        int i = 0;
        while (i < n) {
            char c = glob.charAt(i);
            if (c == '*') {
                int j = i;
                while (j < n && glob.charAt(j) == '*') {
                    j++;
                }
                boolean afterSlash = i > 0 && glob.charAt(i - 1) == '/';
                boolean beforeSlash = j < n && glob.charAt(j) == '/';
                if (j - i >= 2) {
                    if (beforeSlash && (i == 0 || afterSlash)) {
                        // ведущий **/ или срединный /**/ — любое число каталогов
                        rx.append("(?:[^/]+/)*");
                        i = j + 1;
                    } else {
                        // хвостовой /** и голый ** — через разделители
                        rx.append(".*");
                        i = j;
                    }
                } else {
                    rx.append("[^/]*");
                    i = j;
                }
                continue;
            }
            if (c == '?') {
                rx.append("[^/]");
                i++;
                continue;
            }
            if (c == '[') {
                int next = appendClass(rx, glob, i);
                if (next < 0) {
                    appendLiteral(rx, '[');
                    i++;
                } else {
                    i = next;
                }
                continue;
            }
            if (c == '\\') {
                if (i + 1 < n) {
                    appendLiteral(rx, glob.charAt(i + 1));
                    i += 2;
                } else {
                    appendLiteral(rx, '\\');
                    i++;
                }
                continue;
            }
            appendLiteral(rx, c);
            i++;
        }
        return rx.toString();
    }

    /**
     * Класс символов {@code [...]} → regex-класс. Возвращает индекс за закрывающей
     * скобкой или -1 (незакрытый класс → литеральная {@code [}).
     */
    private static int appendClass(StringBuilder rx, String glob, int start) {
        int n = glob.length();
        int k = start + 1;
        StringBuilder cls = new StringBuilder("[");
        if (k < n && (glob.charAt(k) == '!' || glob.charAt(k) == '^')) {
            cls.append('^');
            k++;
        }
        boolean first = true;
        if (k < n && glob.charAt(k) == ']') {
            cls.append("\\]");
            k++;
            first = false;
        }
        while (k < n && glob.charAt(k) != ']') {
            char c = glob.charAt(k);
            if (c == '\\' && k + 1 < n) {
                appendClassLiteral(cls, glob.charAt(k + 1));
                k += 2;
            } else if (c == '-' && !first) {
                cls.append('-');
                k++;
            } else {
                appendClassLiteral(cls, c);
                k++;
            }
            first = false;
        }
        if (k >= n) {
            return -1;
        }
        cls.append(']');
        rx.append(cls);
        return k + 1;
    }

    private static void appendClassLiteral(StringBuilder cls, char c) {
        if (c == '\\' || c == ']' || c == '^' || c == '-' || c == '[') {
            cls.append('\\');
        }
        cls.append(c);
    }

    private static void appendLiteral(StringBuilder rx, char c) {
        if ("\\.[]{}()*+-?^$|".indexOf(c) >= 0) {
            rx.append('\\');
        }
        rx.append(c);
    }

    private record Rule(Pattern regex, boolean negated, boolean dirOnly) {}
}
