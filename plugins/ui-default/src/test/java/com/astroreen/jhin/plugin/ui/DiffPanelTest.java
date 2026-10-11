/**
 * T107: the Diff / Files / Preview panel tabs — the decorative surfaces
 * seeded from the fixture pack (plan section 4.8).
 *
 * <p>The Diff tab is the file-list header (the changed count, the total
 * stat, the copy-path button and the unified/split toggle) over the first
 * file's {@code diff_view}; the Files tab is a {@code tree} whose file rows
 * carry the A/M/D status badge and the {@code +n −m} line stats and whose
 * tap is an inline {@code setState} selector that {@code patch}es the Diff
 * tab's {@code diff_view}; the Preview tab is a syntax-highlighted
 * {@code code_block} with the decorative {@code Open in…} button. An empty
 * fixture renders the empty-state card, never a blank tab.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.ui.screens.RightPanelBuilder;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class DiffPanelTest {

    private static final String SESSION_ID = "s-1";

    @Test
    void theDiffTabCarriesTheFileListHeaderAndTheFirstDiffView() {
        Map<String, Object> json = render();

        Map<String, Object> diff = node(json, "column", RightPanelBuilder.DIFF_ID);
        assertThat(diff).isNotNull();

        Map<String, Object> header =
                node(json, "row", RightPanelBuilder.DIFF_HEADER_ID);
        assertThat(header).isNotNull();
        // The changed count and the total stat from the fixture (5+12+0 = 17
        // additions, 2+0+8 = 10 deletions).
        assertThat(textsOf(header)).contains("3 changed files", "+17", "-10");
        // The copy-path button and the two view toggles are demo-marked.
        Map<String, Object> copy = node(json, "icon_button", RightPanelBuilder.DIFF_COPY_ID);
        assertThat(copy).containsEntry("demo", true);
        assertThat(castMap(copy.get("action"))).containsKey("client");
        assertThat(node(json, "icon_button",
                RightPanelBuilder.DIFF_VIEW_ID + "-toggle-unified")).isNotNull();
        assertThat(node(json, "icon_button",
                RightPanelBuilder.DIFF_VIEW_ID + "-toggle-split")).isNotNull();

        // The diff_view: the first fixture file, three hunks, demo-marked and
        // with no hardcoded colorScheme (the ambient T86 switch applies).
        Map<String, Object> view = node(json, "diff_view", RightPanelBuilder.DIFF_VIEW_ID);
        assertThat(view).containsEntry("file", "lib/agent/run.ts")
                .containsEntry("language", "typescript")
                .containsEntry("demo", true)
                .doesNotContainKey("colorScheme");
        assertThat(castMap(view.get("stats")))
                .containsEntry("additions", 5).containsEntry("deletions", 2);
        assertThat((List<?>) view.get("hunks")).hasSize(3);
    }

    @Test
    void theViewTogglePatchesTheDiffViewClientSide() {
        Map<String, Object> json = render();

        Map<String, Object> split = node(json, "icon_button",
                RightPanelBuilder.DIFF_VIEW_ID + "-toggle-split");
        List<Map<String, Object>> ops = clientOps(split);
        assertThat(ops).hasSize(2);
        assertThat(ops.get(0)).containsEntry("op", "setState")
                .containsEntry("id", RightPanelBuilder.STATE_DIFF_VIEW)
                .containsEntry("value", "split");
        assertThat(ops.get(1)).containsEntry("op", "patch")
                .containsEntry("id", RightPanelBuilder.DIFF_VIEW_ID);
        assertThat(ops.get(1)).doesNotContainKey("props");
        assertThat(String.valueOf(ops.get(1).get("html")))
                .contains("data-jhin-type=\"diff_view\"")
                .contains("data-jhin-view=\"split\"");
    }

    @Test
    void theFilesTabRendersTheChangedFilesTreeWithBadgesAndStats() {
        Map<String, Object> json = render();

        Map<String, Object> files = node(json, "column", RightPanelBuilder.FILES_ID);
        assertThat(files).isNotNull();
        Map<String, Object> tree = node(json, "tree", RightPanelBuilder.FILES_TREE_ID);
        assertThat(tree).isNotNull();

        List<Map<String, Object>> items = itemsOf(tree);
        assertThat(items).hasSize(1);
        assertThat(items.get(0)).containsEntry("label", "lib");

        // Walk to the file leaves.
        List<Map<String, Object>> leaves = new ArrayList<>();
        collectLeaves(items, leaves);
        assertThat(leaves).hasSize(3);
        assertThat(leaves.stream().map(leaf -> leaf.get("label")))
                .containsExactly("run.ts", "prompt.ts", "legacy.ts");
        assertThat(leaves.stream().map(leaf -> leaf.get("stat")))
                .containsExactly("+5 \u22122", "+12 \u22120", "+0 \u22128");
        // Every leaf carries an A/M/D badge node.
        for (Map<String, Object> leaf : leaves) {
            Map<String, Object> badge = castMap(leaf.get("badge"));
            assertThat(badge).containsEntry("type", "badge");
            assertThat(badge.get("label")).isIn("A", "M", "D");
        }
    }

    @Test
    void aFileRowSelectsTheFileAndPatchesTheDiffView() {
        Map<String, Object> json = render();

        Map<String, Object> tree = node(json, "tree", RightPanelBuilder.FILES_TREE_ID);
        List<Map<String, Object>> leaves = new ArrayList<>();
        collectLeaves(itemsOf(tree), leaves);
        Map<String, Object> prompt = leaves.stream()
                .filter(leaf -> "prompt.ts".equals(leaf.get("label")))
                .findFirst().orElseThrow();

        List<Map<String, Object>> ops = clientOps(prompt);
        assertThat(ops).hasSize(2);
        assertThat(ops.get(0)).containsEntry("op", "setState")
                .containsEntry("id", RightPanelBuilder.STATE_DIFF_FILE)
                .containsEntry("value", "lib/agent/prompt.ts");
        assertThat(ops.get(1)).containsEntry("op", "patch")
                .containsEntry("id", RightPanelBuilder.DIFF_VIEW_ID);
        assertThat(ops.get(1)).doesNotContainKey("props");
        String html = String.valueOf(ops.get(1).get("html"));
        assertThat(html).contains("data-jhin-type=\"diff_view\"")
                .contains("lib/agent/prompt.ts");
        assertThat(html.split("class=\"jhin-diff-hunk\"", -1)).hasSize(4);
    }

    @Test
    void thePreviewTabRendersTheSyntaxCodeBlockAndTheOpenInButton() {
        Map<String, Object> json = render();

        Map<String, Object> preview = node(json, "column", RightPanelBuilder.PREVIEW_ID);
        assertThat(preview).isNotNull();
        Map<String, Object> code = node(json, "code_block", RightPanelBuilder.PREVIEW_CODE_ID);
        assertThat(code).containsEntry("language", "typescript")
                .containsEntry("syntax", true)
                .containsEntry("copyable", true)
                .containsEntry("lineNumbers", true);
        assertThat((String) code.get("code")).contains("export async function run");

        Map<String, Object> open = node(json, "button", RightPanelBuilder.PREVIEW_OPEN_ID);
        assertThat(open).containsEntry("label", "Open in\u2026").containsEntry("demo", true);
        assertThat(castMap(open.get("action"))).containsKey("client");
    }

    @Test
    void anEmptyFixtureRendersTheEmptyStateCardNotABlankTab() {
        Map<String, Object> json = render(
                fixtureList(RightPanelBuilder.EMPTY_DIFF_FIXTURE, "files"),
                fixtureList(RightPanelBuilder.EMPTY_FILES_FIXTURE, "tree"));

        // The Diff tab is the empty-state card, not an empty column.
        Map<String, Object> diffEmpty =
                node(json, "card", RightPanelBuilder.DIFF_EMPTY_ID);
        assertThat(diffEmpty).isNotNull();
        assertThat(textsOf(diffEmpty)).contains("No changes yet.");
        assertThat(node(json, "column", RightPanelBuilder.DIFF_ID)).isNull();

        // The Files and Preview tabs likewise.
        assertThat(node(json, "card", RightPanelBuilder.FILES_EMPTY_ID)).isNotNull();
        assertThat(node(json, "card", RightPanelBuilder.PREVIEW_EMPTY_ID)).isNotNull();
        assertThat(node(json, "tree", RightPanelBuilder.FILES_TREE_ID)).isNull();
        assertThat(node(json, "code_block", RightPanelBuilder.PREVIEW_CODE_ID)).isNull();
    }

    @Test
    void theFixturePackCarriesThreeFilesWithThreeHunksEach() {
        List<Map<String, Object>> files = RightPanelBuilder.diffFiles();
        assertThat(files).hasSize(3);
        for (Map<String, Object> file : files) {
            assertThat((List<?>) file.get("hunks")).hasSize(3);
            assertThat(file.get("content")).isNotNull();
        }
        assertThat(RightPanelBuilder.filesTree()).isNotEmpty();
    }

    // --- fixture and walkers ---

    private static Map<String, Object> render() {
        return render(RightPanelBuilder.diffFiles(), RightPanelBuilder.filesTree());
    }

    private static Map<String, Object> render(List<Map<String, Object>> diffFiles,
                                              List<Map<String, Object>> filesTree) {
        Session session = new Session(SESSION_ID, "acc-1", "demo", "/tmp/work",
                "Opus 4.6", "anthropic", "active", 0L, 0L, false, null, null,
                null, null, false, null, null, false);
        return RightPanelBuilder.build(session, "idle", diffFiles, filesTree).toJson();
    }

    /** One list value of a fixture resource. */
    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> fixtureList(String resource, String key) {
        Object value = RightPanelBuilder.loadFixture(resource).get(key);
        return value instanceof List<?> list
                ? (List<Map<String, Object>>) list : List.of();
    }

    /** The client directive list of a node action. */
    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> clientOps(Map<String, Object> node) {
        Map<String, Object> action = castMap(node.get("action"));
        return (List<Map<String, Object>>) action.get("client");
    }

    /** Collects the file leaves (items without nested children). */
    private static void collectLeaves(List<Map<String, Object>> items,
                                      List<Map<String, Object>> leaves) {
        for (Map<String, Object> item : items) {
            Object children = item.get("items");
            if (children instanceof List<?> list && !list.isEmpty()) {
                collectLeaves(itemsOf(item), leaves);
            } else if (item.get("path") != null) {
                leaves.add(item);
            }
        }
    }

    /** The text values of every descendant text node. */
    private static List<String> textsOf(Object fragment) {
        List<String> texts = new ArrayList<>();
        walk(fragment, map -> {
            if ("text".equals(map.get("type")) && map.get("text") instanceof String text) {
                texts.add(text);
            }
        });
        return texts;
    }

    private static Map<String, Object> node(Map<String, Object> tree, String type, String id) {
        return descendantsOfType(tree, type).stream()
                .filter(found -> id.equals(found.get("id")))
                .findFirst()
                .orElse(null);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> itemsOf(Map<String, Object> node) {
        Object items = node.get("items");
        return items == null ? List.of() : (List<Map<String, Object>>) items;
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
