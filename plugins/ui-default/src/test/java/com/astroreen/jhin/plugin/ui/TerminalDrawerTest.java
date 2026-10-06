/**
 * T106: the decorative terminal drawer — the grip handle, the {@code Terminal}
 * title, the close {@code X}, the fixture transcript and the resize /
 * persistence props the client shell reads.
 *
 * <p>The drawer is a {@code container} gated by the chat header's
 * {@code chat_terminal} {@code setState} toggle; the body is the
 * {@code fixtures/terminal-fixtures.json} transcript rendered as a
 * {@code code_block}. There is no PTY (plan section 14.1): the transcript is
 * a build-time fixture.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.ui.screens.ChatScreen;
import com.astroreen.jhin.plugin.ui.screens.SessionsScreen;
import com.astroreen.jhin.plugin.ui.screens.TerminalDrawerBuilder;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class TerminalDrawerTest {

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
    void theDrawerIsAGatedContainerWithTheTerminalTokenPair() {
        Map<String, Object> drawer = drawerOf(TerminalDrawerBuilder.build().toJson());

        assertThat(drawer).containsEntry("type", "container")
                .containsEntry("id", TerminalDrawerBuilder.DRAWER_ID)
                .containsEntry("direction", "column")
                .containsEntry("when", ChatScreen.STATE_TERMINAL + " == true")
                .containsEntry("color", "$color.code")
                .containsEntry("border", "$color.border")
                .containsEntry("borderWidth", 1)
                .containsEntry("initialHeight", TerminalDrawerBuilder.DEFAULT_HEIGHT)
                .containsEntry("minDrawerHeight", TerminalDrawerBuilder.MIN_HEIGHT)
                .containsEntry("maxDrawerRatio", TerminalDrawerBuilder.MAX_RATIO)
                .containsEntry("persistKey", TerminalDrawerBuilder.PERSIST_KEY)
                .containsEntry("closeState", ChatScreen.STATE_TERMINAL)
                .containsEntry("cursorColor", "$color.foreground")
                .containsEntry("selectionColor", "$color.accent");
    }

    @Test
    void theHeaderCarriesTheGripTitleAndClose() {
        Map<String, Object> drawer = drawerOf(TerminalDrawerBuilder.build().toJson());

        Map<String, Object> grip = node(drawer, "icon", TerminalDrawerBuilder.GRIP_ID);
        assertThat(grip).containsEntry("icon", "drag_indicator");

        assertThat(stringsIn(drawer)).contains(TerminalDrawerBuilder.TITLE);

        Map<String, Object> close = node(drawer, "icon_button", TerminalDrawerBuilder.CLOSE_ID);
        assertThat(close).containsEntry("icon", "close");
        assertThat(castMap(close.get("action")))
                .containsEntry("op", "setState")
                .containsEntry("id", ChatScreen.STATE_TERMINAL)
                .containsEntry("value", false);
    }

    @Test
    void theBodyIsTheFixtureTranscriptCodeBlock() {
        Map<String, Object> drawer = drawerOf(TerminalDrawerBuilder.build().toJson());

        Map<String, Object> transcript =
                node(drawer, "code_block", TerminalDrawerBuilder.TRANSCRIPT_ID);
        assertThat(transcript).containsEntry("language", "shell")
                .containsEntry("syntax", true);
        String code = String.valueOf(transcript.get("code"));
        assertThat(code).contains("$ jhin health").contains("ok");
        // The fixture is the 20-line transcript (plan section 4.8).
        assertThat(code.split("\n", -1)).hasSize(20);
    }

    @Test
    void theShellMountsTheDrawerInItsTerminalSlot() {
        Map<String, Object> screen = SessionsScreen
                .render(store, Optional.empty(), true, false).toJson();
        Map<String, Object> shell = nodesOfType(screen, "shell").get(0);
        assertThat(shell).containsKey("terminal");
        Map<String, Object> drawer = castMap(shell.get("terminal"));
        assertThat(drawer).containsEntry("id", TerminalDrawerBuilder.DRAWER_ID);
    }

    // --- fixture and walkers ---

    private static Map<String, Object> drawerOf(Map<String, Object> tree) {
        return node(tree, "container", TerminalDrawerBuilder.DRAWER_ID);
    }

    private static Map<String, Object> node(Map<String, Object> tree, String type, String id) {
        return descendantsOfType(tree, type).stream()
                .filter(found -> id.equals(found.get("id")))
                .findFirst()
                .orElseThrow(() -> new AssertionError("no " + type + " node with id " + id));
    }

    private static List<String> stringsIn(Object fragment) {
        List<String> texts = new ArrayList<>();
        walk(fragment, map -> {
            Object text = map.get("text");
            if (text instanceof String value) {
                texts.add(value);
            }
        });
        return texts;
    }

    private static List<Map<String, Object>> descendantsOfType(Object fragment, String type) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(fragment, map -> {
            if (type.equals(map.get("type"))) {
                found.add(map);
            }
        });
        return found;
    }

    private static List<Map<String, Object>> nodesOfType(Object fragment, String type) {
        return descendantsOfType(fragment, type);
    }

    private static void walk(Object fragment,
                             java.util.function.Consumer<Map<String, Object>> seen) {
        if (fragment instanceof Map<?, ?> map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> typed = (Map<String, Object>) map;
            seen.accept(typed);
            for (Object value : map.values()) {
                walk(value, seen);
            }
        } else if (fragment instanceof List<?> list) {
            for (Object value : list) {
                walk(value, seen);
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }
}
