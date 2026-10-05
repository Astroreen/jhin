/**
 * The T95 shell chrome: the {@code sessions} shell carries the top bar
 * (wordmark, breadcrumb, control cluster), the condensed compact variant,
 * the page header row (title + arrange action), the fixed 768 px breakpoint
 * and the stage-backdrop flag; an unknown slot name is rejected at build
 * time by the builder whitelist.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.ui.screens.ShellScreen;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ShellScreenTest {

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private SessionStore store;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        RecordingStreamRegistry streams = new RecordingStreamRegistry();
        FakePluginContext.FakeServices services = new FakePluginContext.FakeServices();
        new com.astroreen.jhin.plugin.sessions.SessionsPlugin()
                .start(new FakePluginContext(tmp, "jhin.sessions", db, streams, services));
        store = services.find(SessionStore.class).orElseThrow();
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void shellCarriesTheChromeSlotsAndMetrics() {
        Map<String, Object> shell = shellOf(render(false));

        assertThat(shell).containsEntry("breakpoint", 768).containsEntry("stageBackdrop", true);
        assertThat(shell).containsKeys("topbar", "topbarCompact", "pageHeader", "body");
        // Since T96 the body slot carries the sidebar split (the resizable
        // sections | content row); the fixed-width sidebar slot is unset.
        assertThat(shell).doesNotContainKey("sidebar");
        Map<String, Object> split = castMap(shell.get("body"));
        assertThat(split).containsEntry("type", "split")
                .containsEntry("persistKey", "chat_thread_sidebar_width")
                .containsEntry("initial", 256)
                .containsEntry("min", 208)
                .containsEntry("minSecond", 640);
    }

    @Test
    void topbarCarriesWordmarkBreadcrumbAndControlCluster() {
        Map<String, Object> topbar = castMap(shellOf(render(true)).get("topbar"));

        assertThat(stringsIn(topbar)).contains("Jhin", "Workspace", "/", "Threads");
        // The control cluster: the app navigation tabs, providers linked.
        Map<String, Object> nav = nodesOfType(topbar, "nav").get(0);
        assertThat(screensOf(nav)).contains("sessions", "settings", "plugins", "providers");
    }

    @Test
    void compactTopbarCondensesTheBreadcrumbToTheCurrentTitle() {
        Map<String, Object> compact = castMap(shellOf(render(false)).get("topbarCompact"));

        assertThat(stringsIn(compact)).contains("Jhin", "Threads");
        assertThat(stringsIn(compact)).doesNotContain("Workspace", "/");
    }

    @Test
    void pageHeaderCarriesTitleAndArrangeAction() {
        Map<String, Object> header = castMap(shellOf(render(false)).get("pageHeader"));

        assertThat(stringsIn(header)).contains("Threads");
        List<Map<String, Object>> buttons = nodesOfType(header, "button");
        assertThat(buttons).hasSize(1);
        assertThat(castMap(buttons.get(0).get("action")).get("name")).isEqualTo("arrange-toggle");
        // The flipped mode renders the "Done arranging" label.
        Map<String, Object> arranged = castMap(shellOf(render(true)).get("pageHeader"));
        assertThat(stringsIn(arranged)).contains("Done arranging");
    }

    @Test
    void unknownSlotNameIsRejectedAtBuild() {
        assertThatThrownBy(() -> Ui.shell().set("leftPanel", Ui.text("x").build()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("unsupported prop leftPanel on shell");
        // The documented slots stay accepted.
        assertThat(Ui.shell().set("terminal", Ui.text("x").build()).build().toJson())
                .containsKey("terminal");
    }

    private Map<String, Object> render(boolean arrange) {
        return com.astroreen.jhin.plugin.ui.screens.SessionsScreen
                .render(store, Optional.empty(), true, arrange).toJson();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> shellOf(Map<String, Object> screen) {
        return nodesOfType(screen, "shell").get(0);
    }

    private static List<String> stringsIn(Object fragment) {
        List<String> texts = new java.util.ArrayList<>();
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
            for (Object value : list) {
                collectStrings(value, texts);
            }
        }
    }

    /** The screen ids of one nav node's items. */
    private static List<String> screensOf(Map<String, Object> nav) {
        return castList(nav.get("items")).stream()
                .map(item -> String.valueOf(castMap(item).get("screen")))
                .toList();
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> nodesOfType(Object fragment, String type) {
        List<Map<String, Object>> found = new java.util.ArrayList<>();
        walk(fragment, map -> {
            if (type.equals(map.get("type"))) {
                found.add(map);
            }
        });
        return found;
    }

    private static void walk(Object fragment, java.util.function.Consumer<Map<String, Object>> visit) {
        if (fragment instanceof Map<?, ?> map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> typed = (Map<String, Object>) map;
            visit.accept(typed);
            for (Object value : map.values()) {
                walk(value, visit);
            }
        } else if (fragment instanceof List<?> list) {
            for (Object value : list) {
                walk(value, visit);
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> castList(Object value) {
        return (List<Object>) value;
    }
}
