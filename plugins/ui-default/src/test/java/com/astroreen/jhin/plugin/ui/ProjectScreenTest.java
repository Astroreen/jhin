/**
 * The T114 {@code project:<key>} screen: the shell chrome, the project header
 * (monogram, name, badges), the decorative branch toolbar, the real
 * threads-in-project subset, the decorative scripts card and the
 * {@code NoActiveThreadState} hero of the empty project. Every decorative
 * control carries {@code demo: true} (plan section 14.10).
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.ui.screens.ProjectScreen;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ProjectScreenTest {

    private static final String JHIN_PATH = "/home/astroreen/Documents/jhin";

    @Test
    void theFixtureResolvesByKey() {
        assertThat(ProjectScreen.find("jhin")).isPresent();
        assertThat(ProjectScreen.find("pinball-stats")).isPresent();
        assertThat(ProjectScreen.find("nope")).isEmpty();
        assertThat(ProjectScreen.projects()).hasSize(3);
    }

    @Test
    void theScreenIsAShellWithTheProjectHeader() {
        Map<String, Object> json = ProjectScreen.render(ProjectScreen.find("jhin").orElseThrow(),
                List.of()).toJson();

        assertThat(typesIn(json)).contains("screen", "shell", "card");
        Map<String, Object> shell = nodesOfType(json, "shell").get(0);
        assertThat(shell).containsEntry("id", ProjectScreen.SHELL_ID)
                .containsEntry("breakpoint", ProjectScreen.BREAKPOINT);
        assertThat(nodesWithId(json, ProjectScreen.HEADER_ID)).hasSize(1);
        assertThat(stringsIn(json)).contains("Jhin", "JH", JHIN_PATH, "Active", "Git");
    }

    @Test
    void theBranchToolbarIsDecorative() {
        Map<String, Object> json = ProjectScreen.render(ProjectScreen.find("jhin").orElseThrow(),
                List.of()).toJson();

        assertThat(nodesWithId(json, ProjectScreen.BRANCH_TOOLBAR_ID)).hasSize(1);
        List<Map<String, Object>> dropdowns = nodesOfType(json, "dropdown");
        assertThat(dropdowns).hasSize(2);
        assertThat(dropdowns).allSatisfy(node ->
                assertThat(node).containsEntry("demo", true));
    }

    @Test
    void theThreadsListIsTheRealSessionSubset() {
        Session matching = session("s1", "Fix the loader", JHIN_PATH);
        Session other = session("s2", "Other work", "/tmp/elsewhere");

        Map<String, Object> json = ProjectScreen.render(ProjectScreen.find("jhin").orElseThrow(),
                List.of(matching, other)).toJson();

        assertThat(nodesWithId(json, "project-thread-s1")).hasSize(1);
        assertThat(nodesWithId(json, "project-thread-s2")).isEmpty();
        assertThat(stringsIn(json)).contains("Fix the loader");
        assertThat(nodesWithId(json, ProjectScreen.EMPTY_ID)).isEmpty();
    }

    @Test
    void theEmptyProjectRendersTheNoActiveThreadStateHero() {
        Map<String, Object> json = ProjectScreen.render(ProjectScreen.find("jhin").orElseThrow(),
                List.of()).toJson();

        assertThat(nodesWithId(json, ProjectScreen.EMPTY_ID)).hasSize(1);
        assertThat(stringsIn(json)).contains("Pick a thread to continue",
                "Select an existing thread or create a new one to get started.");
        Map<String, Object> start = nodesWithId(json, ProjectScreen.START_ID).get(0);
        assertThat(castMap(start.get("action"))).containsEntry("op", "navigate")
                .containsEntry("screen", "chat:new");
    }

    @Test
    void theScriptsCardIsDecorative() {
        Map<String, Object> json = ProjectScreen.render(ProjectScreen.find("jhin").orElseThrow(),
                List.of()).toJson();

        assertThat(nodesWithId(json, ProjectScreen.SCRIPTS_ID)).hasSize(1);
        assertThat(nodesWithId(json, "project-script-build")).hasSize(1);
        assertThat(stringsIn(json)).contains("Build", "./gradlew build");
        List<Map<String, Object>> runs = new ArrayList<>();
        walk(json, map -> {
            if ("button".equals(map.get("type")) && "Run".equals(map.get("label"))) {
                runs.add(map);
            }
        });
        assertThat(runs).isNotEmpty();
        assertThat(runs).allSatisfy(node -> assertThat(node).containsEntry("demo", true));
    }

    private static Session session(String id, String title, String workdir) {
        return new Session(id, "demo", title, workdir, null, null, "active", 1L, 1L);
    }

    // --- node walking helpers over the JSON wire shape ---

    private static List<Map<String, Object>> nodesOfType(Object fragment, String type) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(fragment, map -> {
            if (type.equals(map.get("type"))) {
                found.add(map);
            }
        });
        return found;
    }

    private static List<Map<String, Object>> nodesWithId(Object fragment, String id) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(fragment, map -> {
            if (id.equals(map.get("id"))) {
                found.add(map);
            }
        });
        return found;
    }

    private static java.util.Set<String> typesIn(Object fragment) {
        java.util.Set<String> types = new java.util.HashSet<>();
        walk(fragment, map -> {
            if (map.get("type") != null) {
                types.add(String.valueOf(map.get("type")));
            }
        });
        return types;
    }

    private static List<String> stringsIn(Object fragment) {
        List<String> texts = new ArrayList<>();
        collectStrings(fragment, texts);
        return texts;
    }

    private static void collectStrings(Object fragment, List<String> texts) {
        if (fragment instanceof String text) {
            texts.add(text);
        } else if (fragment instanceof Map<?, ?> map) {
            for (Object value : map.values()) {
                collectStrings(value, texts);
            }
        } else if (fragment instanceof List<?> list) {
            for (Object nested : list) {
                collectStrings(nested, texts);
            }
        }
    }

    private static void walk(Object fragment, java.util.function.Consumer<Map<String, Object>> seen) {
        if (fragment instanceof Map<?, ?> map) {
            Map<String, Object> copy = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                copy.put(String.valueOf(entry.getKey()), entry.getValue());
            }
            seen.accept(copy);
            for (Object nested : map.values()) {
                walk(nested, seen);
            }
        } else if (fragment instanceof List<?> list) {
            for (Object nested : list) {
                walk(nested, seen);
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }
}