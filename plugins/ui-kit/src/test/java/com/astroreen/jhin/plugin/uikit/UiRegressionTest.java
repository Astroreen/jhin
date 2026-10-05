/**
 * Regression guard for the T55 builder-lattice refactor: re-emits a
 * representative node for every builder (every existing setter exercised) and
 * compares the JSON wire shape byte-for-byte against the fixtures captured
 * before the refactor.
 *
 * <p>Capture mode: run with the environment variable {@code JHIN_UIKIT_CAPTURE=<dir>}
 * (files are written there; the special values {@code 1}/{@code true} target
 * the committed fixture directory src/test/resources/regression). Compare
 * mode (default, variable unset) fails on any byte difference.
 */
package com.astroreen.jhin.plugin.uikit;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.sdk.json.Json;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class UiRegressionTest {

    private static final String CAPTURE_VARIABLE = "JHIN_UIKIT_CAPTURE";

    private static final Path FIXTURE_DIR =
            Path.of("src", "test", "resources", "regression");

    private static Map<String, Object> action(String name) {
        Map<String, Object> action = new LinkedHashMap<>();
        action.put("name", name);
        action.put("method", "POST");
        action.put("path", "/ui/action/" + name);
        return action;
    }

    /** Deterministic insertion-ordered map; {@code Map.of} iteration order is randomized per JVM run. */
    private static Map<String, Object> orderedMap(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }

    /**
     * One node per builder, every setter that existed before the T55 refactor
     * exercised exactly once. The order of the list is the fixture numbering.
     */
    private static List<UiNode> sampleNodes() {
        List<UiNode> nodes = new ArrayList<>();

        nodes.add(Ui.screen()
                .id("s1").visible(true).padding(8).flex(1).when("showHint")
                .title("Sessions")
                .appBar(Ui.text("bar").build())
                .body(Ui.container()
                        .direction("column")
                        .gap(8)
                        .align("center")
                        .scroll(true)
                        .child(Ui.text("Sign in").style("h2").bold(true).color("#112233").build())
                        .child("string child")
                        .build())
                .floatingAction(Ui.button("Go").build())
                .build());

        nodes.add(Ui.nav()
                .kind("drawer")
                .item("Home", "home", "sessions")
                .item("Settings", "settings")
                .build());

        nodes.add(Ui.card().title("Card").child(Ui.text("inside").build()).child("raw").build());

        nodes.add(Ui.text("Hello").style("h1").bold(true).color("#AABBCC").color(0x112233).build());

        nodes.add(Ui.markdown("# Heading\n\nbody").build());

        nodes.add(Ui.button("Enroll")
                .style("primary")
                .action(action("enroll"))
                .icon("check")
                .confirm("Sure?")
                .build());

        nodes.add(Ui.input("code")
                .label("Code").value("v").placeholder("p")
                .multiline(true).obscure(false).keyboard("number").required(true)
                .min(1).max(9).pattern("[0-9]+").errorText("bad")
                .build());

        nodes.add(Ui.dropdown("d1")
                .item("a", 1)
                .item("b", "two")
                .value(1)
                .action(action("pick"))
                .build());

        nodes.add(Ui.checkbox("c1", "Label").value(true).build());

        nodes.add(Ui.toggle("s1", "Label").value(false).build());

        nodes.add(Ui.slider("r1", 0, 10).label("L").step(2).value(6).build());

        nodes.add(Ui.form()
                .field(Ui.input("a").label("A").build())
                .field("shorthand field")
                .submit("Send", action("send"))
                .build());

        nodes.add(Ui.list()
                .item(Ui.text("one").build())
                .item("two")
                .maxHeight(240)
                .build());

        nodes.add(Ui.streamView("feed", "/ui/stream/session/s1")
                .mode("append").itemLimit(20).autoScroll(true).empty("quiet")
                .build());

        nodes.add(Ui.table()
                .column("Name", 2).column("Path")
                .row("a", Ui.text("b").build())
                .row("c")
                .build());

        nodes.add(Ui.divider().build());

        nodes.add(Ui.spacer().size(12).build());

        nodes.add(Ui.progress().kind("circular").value(0.5).build());

        nodes.add(Ui.image().src("https://example.invalid/i.png").width(32).height(32).fit("cover").build());

        nodes.add(Ui.figure().shape("rectangle").color("#112233").width(10).height(20).build());

        nodes.add(Ui.chartLine().series(List.of(orderedMap("label", "l"), orderedMap("values", List.of(1, 2)))).build());

        nodes.add(Ui.chartBar().items(List.of(orderedMap("label", "a", "value", 1))).build());

        nodes.add(Ui.chartPie().items(List.of(orderedMap("label", "a", "value", 2))).build());

        nodes.add(Ui.drawer().title("Drawer").child(Ui.text("d").build()).build());

        // T89: the five glass-capable surfaces with the level-3 glass group
        // (glass + glassTint) — the wire shapes the client's glass recipes
        // (surface-glass, alert-glass, dialog-glass, dropdown-glass) render.
        nodes.add(Ui.card()
                .id("glass-card").title("Glass card")
                .glass(true).glassTint("$color.destructive")
                .child(Ui.text("Blurred backdrop card").build())
                .build());
        nodes.add(Ui.sheet()
                .id("glass-sheet").title("Glass sheet")
                .body(Ui.text("Blurred backdrop sheet").build())
                .glass(true).glassTint("$color.destructive")
                .build());
        nodes.add(Ui.dialog()
                .id("glass-dialog").title("Glass dialog")
                .content(Ui.text("Blurred backdrop dialog").build())
                .action(Ui.button("Close").build())
                .glass(true).glassTint("$color.destructive")
                .build());
        nodes.add(Ui.menu()
                .id("glass-menu")
                .trigger(Ui.button("Open menu").build())
                .item("One").item("Two")
                .glass(true).glassTint("$color.destructive")
                .build());
        nodes.add(Ui.banner()
                .id("glass-banner")
                .content(Ui.text("Blurred backdrop banner").build())
                .glass(true).glassTint("$color.warning")
                .build());

        return nodes;
    }

    private static final List<String> NAMES = List.of(
            "screen", "nav", "card", "text", "markdown", "button", "input",
            "dropdown", "checkbox", "switch", "slider", "form", "list",
            "stream_view", "table", "divider", "spacer", "progress", "image",
            "figure", "chart_line", "chart_bar", "chart_pie", "drawer",
            "glass-card", "glass-sheet", "glass-dialog", "glass-menu",
            "glass-banner");

    @Test
    void wireShapesAreByteIdenticalToTheCapturedFixtures() throws IOException {
        List<UiNode> nodes = sampleNodes();
        assertThat(nodes).hasSize(NAMES.size());

        Path capture = captureDir();
        if (capture != null) {
            Files.createDirectories(capture);
            for (int i = 0; i < nodes.size(); i++) {
                String json = Json.write(nodes.get(i).toJson()) + "\n";
                Files.writeString(capture.resolve(String.format("%02d-%s.json", i, NAMES.get(i))), json,
                        StandardCharsets.UTF_8);
            }
            assertThat(capture).isDirectoryContaining(p -> p.getFileName().toString().endsWith(".json"));
            return;
        }

        for (int i = 0; i < nodes.size(); i++) {
            String actual = Json.write(nodes.get(i).toJson()) + "\n";
            Path fixture = FIXTURE_DIR.resolve(String.format("%02d-%s.json", i, NAMES.get(i)));
            assertThat(fixture).as("fixture %s", fixture).exists();
            String expected = Files.readString(fixture, StandardCharsets.UTF_8);
            assertThat(actual).as("fixture %s", fixture.getFileName()).isEqualTo(expected);
        }
    }

    /**
     * The capture target: the variable value, with {@code 1}/{@code true}
     * meaning the committed fixture directory. {@code null} (variable unset)
     * means compare mode.
     */
    private static Path captureDir() {
        String value = System.getenv(CAPTURE_VARIABLE);
        if (value == null || value.isBlank()) {
            return null;
        }
        if (value.equals("1") || Boolean.parseBoolean(value)) {
            return FIXTURE_DIR.toAbsolutePath().normalize();
        }
        return Path.of(value).toAbsolutePath().normalize();
    }
}
