/**
 * T56/T88: the level-2 bootstrap payload (contract/theme/tokens/density/keymap),
 * its api/schema negotiation, the level-3 -> level-2 primitive downgrade
 * table and the level-2 -> level-1 table — docs/sdui.md sections 1 and 6.
 *
 * <p>Uses a no-op {@link EventLog} since none of these cases touch a
 * {@code stream_view}; that degrade path (independent of the contract level)
 * is already covered by {@link BootstrapRouteTest}.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.plugin.uikit.UiTokens;
import com.astroreen.jhin.sdk.http.ClientInfo;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class BootstrapContractTest {

    private static final EventLog NO_EVENTS = new EventLog() {
        @Override
        public EventRecord append(String sessionId, EventType type, String payload) {
            throw new UnsupportedOperationException("not used by this suite");
        }

        @Override
        public List<EventRecord> list(String sessionId, long afterSeq) {
            return List.of();
        }
    };

    private final CapabilityTailor tailor = new CapabilityTailor(NO_EVENTS);

    @TempDir
    Path tmp;

    // ---- top-level payload shape (docs/sdui.md section 1) ----

    @Test
    void api3PayloadCarriesTheFullLevel2Shape() {
        Map<String, Object> payload = bootstrap(new ClientInfo(3, "0.3.0", 4, Set.of()));

        assertThat(payload).containsEntry("api", 3);
        Map<String, Object> contract = castMap(payload.get("contract"));
        assertThat(contract).containsEntry("api", 3).containsEntry("minApi", 2)
                .containsEntry("schema", 4).containsEntry("minSchema", 3);
        Map<String, Object> tokens = castMap(payload.get("tokens"));
        assertThat(castMap(tokens.get("motion"))).containsEntry("panel", 0);
        assertThat(payload).containsEntry("density", "comfortable");
        List<Object> keymap = castList(payload.get("keymap"));
        assertThat(keymap.size()).isGreaterThanOrEqualTo(8);
        Map<String, Object> theme = castMap(payload.get("theme"));
        assertThat(theme).containsKeys("id", "appearance", "canvas", "accent", "colors", "mode");
        // T85: the default theme is t3-chat and the default seeds are its
        // light pair (the catalogue derives them; the literals pin the wire).
        assertThat(theme.get("id")).isEqualTo("t3-chat");
        assertThat(theme.get("accent")).isEqualTo("#db2777");
        assertThat(theme.get("canvas")).isEqualTo("#fdf7fd");
        assertThat(theme.get("mode")).isEqualTo(theme.get("appearance"));
    }

    /** T83: the tokens block carries every family of the token surface. */
    @Test
    void tokensCarryTheFullTokenSurface() {
        Map<String, Object> payload = bootstrap(new ClientInfo(2, "0.3.0", 3, Set.of()));
        Map<String, Object> tokens = castMap(payload.get("tokens"));

        assertThat(tokens.keySet()).containsExactlyInAnyOrder(
                "color", "radius", "text", "font", "space", "layout",
                "glass", "motion", "shadow", "scroll", "z");

        Map<String, Object> color = castMap(tokens.get("color"));
        assertThat(color).containsEntry("sidebar-row-hover", "var(--sidebar-row-hover)");
        assertThat(castMap(color.get("contrast"))).containsEntry("foreground",
                UiTokens.CONTRAST_VALUES.get("foreground"));
        assertThat(color.keySet()).containsAll(UiTokens.COLOR_KEYS);

        assertThat(castMap(tokens.get("radius")))
                .containsEntry("base", "0.625rem")
                .containsEntry("sm", "calc(0.625rem - 4px)")
                .containsEntry("xl3", "calc(0.625rem + 12px)");
        assertThat(castMap(tokens.get("layout")))
                .containsEntry("topbarHeight", 52)
                .containsEntry("chatContentMaxWidth", "46rem")
                .containsEntry("threadDetailsPanelWidth", "17.5rem")
                .containsEntry("sidebarWidth", 256)
                .containsEntry("sidebarMinWidth", 208)
                .containsEntry("mainMinWidth", 640);
        assertThat(castMap(tokens.get("motion")))
                .containsEntry("panel", 0)
                .containsEntry("easeDrawer", "cubic-bezier(0.32, 0.72, 0, 1)")
                .containsEntry("skeleton", "2.4s")
                .containsEntry("statusPulse", "2s")
                .containsEntry("statusPing", "2s")
                .containsEntry("reduced", false);
        assertThat(castMap(tokens.get("z"))).containsEntry("sheet", 46);
        assertThat(castMap(tokens.get("glass")))
                .containsEntry("opacity", "80%");
        assertThat(castMap(tokens.get("text")).keySet())
                .containsExactlyInAnyOrderElementsOf(UiTokens.TEXT_KEYS);
        assertThat(castMap(tokens.get("font")))
                .containsEntry("sizeInterface", 16)
                .containsEntry("sizePrompt", 14)
                .containsEntry("sizeCode", 13);
        assertThat(castMap(tokens.get("space")).keySet())
                .containsExactlyInAnyOrderElementsOf(UiTokens.SPACE_KEYS);
        assertThat(castMap(tokens.get("shadow")).keySet())
                .containsExactlyInAnyOrderElementsOf(UiTokens.SHADOW_KEYS);
        assertThat(castMap(tokens.get("scroll")).keySet())
                .containsExactlyInAnyOrderElementsOf(UiTokens.SCROLL_KEYS);
    }

    /** T83: the saved panel duration lands in tokens.motion.panel. */
    @Test
    void tokensMotionPanelFollowsTheSavedDuration() {
        UiSettings settings = UiSettings.open(tmp);
        settings.saveAppearance("system", "jhin", "#16161e", "#7E57C2", "comfortable", 200);
        Map<String, Object> payload = bootstrap(settings, new ClientInfo(2, "0.3.0", 3, Set.of()));

        assertThat(castMap(castMap(payload.get("tokens")).get("motion")))
                .containsEntry("panel", 200);
    }

    @Test
    void api1PayloadHasNoLevel2Fields() {
        Map<String, Object> payload = bootstrap(new ClientInfo(1, "0.3.0", 1, Set.of()));

        assertThat(payload).containsEntry("api", 1);
        assertThat(payload).doesNotContainKeys("contract", "tokens", "density", "keymap");
        assertThat(castMap(payload.get("theme"))).containsOnlyKeys("seedColor", "mode");
    }

    @Test
    void absentHeaderBehavesAsApi1() {
        Map<String, Object> payload = bootstrap(ClientInfo.UNKNOWN);

        assertThat(payload).containsEntry("api", 1);
        assertThat(payload).doesNotContainKeys("contract", "tokens", "density", "keymap");
        assertThat(castMap(payload.get("theme"))).containsOnlyKeys("seedColor", "mode");
    }

    @Test
    void garbageHeaderDegradesToLevel1WithoutThrowing() {
        ClientInfo garbage = ClientInfo.parse("api=0;schema=99");

        Map<String, Object> payload = bootstrap(garbage);

        assertThat(payload).containsEntry("api", 1);
        assertThat(payload).doesNotContainKeys("contract", "tokens", "density", "keymap");
    }

    @Test
    void apiAboveThreeNegotiatesDownToThree() {
        Map<String, Object> payload = bootstrap(new ClientInfo(5, "9.9.9", 4, Set.of()));

        assertThat(payload).containsEntry("api", 3);
        assertThat(castMap(payload.get("contract"))).containsEntry("api", 3);
    }

    // ---- entry / version gate (docs/sdui.md section 6, docs/updates.md rule 6) ----

    @Test
    void schemaBelowMinSchemaSetsTheVersionGateEntryForALevel2Client() {
        Map<String, Object> payload = bootstrap(new ClientInfo(2, "0.3.0", 1, Set.of()));

        assertThat(payload.get("entry")).isEqualTo("version_gate");
    }

    /** T88: schema 2 is below minSchema 3 — gated with HTTP 200, never a crash. */
    @Test
    void schema2ClientBelowMinSchema3GetsTheVersionGateEntry() {
        Map<String, Object> payload = bootstrap(new ClientInfo(3, "0.3.0", 2, Set.of()));

        assertThat(payload.get("entry")).isEqualTo("version_gate");
        assertThat(castMap(payload.get("contract"))).containsEntry("minSchema", 3);
    }

    /** T88: schema 3 equals minSchema 3 — accepted, product screens follow. */
    @Test
    void schema3ClientAtMinSchemaKeepsTheProductEntry() {
        Map<String, Object> payload = bootstrap(new ClientInfo(3, "0.3.0", 3, Set.of()));

        assertThat(payload.get("entry")).isEqualTo("sessions");
    }

    @Test
    void schemaBelowMinSchemaIsIgnoredForALevel1Client() {
        // An api=1 client predates the schema header and the version-gate
        // screen; it must keep receiving its ordinary entry.
        Map<String, Object> payload = bootstrap(new ClientInfo(1, "0.1.0", 1, Set.of()));

        assertThat(payload.get("entry")).isEqualTo("sessions");
    }

    // ---- downgrade table (docs/sdui.md section 6) ----

    @Test
    void shellDowngradesToAColumnContainer() {
        UiNode shell = new UiNode("shell", Map.of(
                "header", textNode("Header"),
                "sidebar", textNode("Sidebar"),
                "body", textNode("Body")), List.of());

        UiNode degraded = tailor.tailor(shell, level1());

        assertThat(degraded.type()).isEqualTo("container");
        assertThat(degraded.props()).containsEntry("direction", "column");
        assertThat(degraded.children()).hasSize(3);
    }

    @Test
    void rowDowngradesToARowContainer() {
        UiNode row = new UiNode("row", Map.of("children", List.of(textNode("a"))), List.of());

        UiNode degraded = tailor.tailor(row, level1());

        assertThat(degraded.type()).isEqualTo("container");
        assertThat(degraded.props()).containsEntry("direction", "row");
    }

    @Test
    void listRowDowngradesToACard() {
        UiNode listRow = new UiNode("list_row",
                Map.of("title", "Session A", "subtitle", "idle"), List.of());

        UiNode degraded = tailor.tailor(listRow, level1());

        assertThat(degraded.type()).isEqualTo("card");
        assertThat(degraded.props()).containsEntry("title", "Session A");
        assertThat(degraded.children()).hasSize(1);
    }

    @Test
    void chipDowngradesToText() {
        UiNode chip = new UiNode("chip", Map.of("label", "Beta"), List.of());

        UiNode degraded = tailor.tailor(chip, level1());

        assertThat(degraded.type()).isEqualTo("text");
        assertThat(degraded.props()).containsEntry("text", "Beta");
    }

    @Test
    void badgeDowngradesToText() {
        UiNode badge = new UiNode("badge", Map.of("count", 3), List.of());

        UiNode degraded = tailor.tailor(badge, level1());

        assertThat(degraded.type()).isEqualTo("text");
        assertThat(degraded.props()).containsEntry("text", "3");
    }

    @Test
    void sheetDowngradesToACard() {
        UiNode sheet = new UiNode("sheet",
                Map.of("title", "Snooze", "body", textNode("until when?")), List.of());

        UiNode degraded = tailor.tailor(sheet, level1());

        assertThat(degraded.type()).isEqualTo("card");
        assertThat(degraded.props()).containsEntry("title", "Snooze");
        assertThat(degraded.children()).hasSize(1);
    }

    @Test
    void dialogDowngradesToACard() {
        UiNode dialog = new UiNode("dialog",
                Map.of("title", "Confirm", "content", textNode("Are you sure?")), List.of());

        UiNode degraded = tailor.tailor(dialog, level1());

        assertThat(degraded.type()).isEqualTo("card");
        assertThat(degraded.props()).containsEntry("title", "Confirm");
        assertThat(degraded.children()).hasSize(1);
    }

    @Test
    void codeBlockDowngradesToMonoText() {
        UiNode codeBlock = new UiNode("code_block", Map.of("code", "a+b", "language", "java"), List.of());

        UiNode degraded = tailor.tailor(codeBlock, level1());

        assertThat(degraded.type()).isEqualTo("text");
        assertThat(degraded.props()).containsEntry("text", "a+b").containsEntry("style", "mono");
    }

    @Test
    void tabsDowngradeToANavWithTabsKind() {
        UiNode tabs = new UiNode("tabs", Map.of("items", List.of(Map.of("label", "One"))), List.of());

        UiNode degraded = tailor.tailor(tabs, level1());

        assertThat(degraded.type()).isEqualTo("nav");
        assertThat(degraded.props()).containsEntry("kind", "tabs");
    }

    @Test
    void skeletonDowngradesToAnIndeterminateProgress() {
        UiNode skeleton = new UiNode("skeleton", Map.of("variant", "circle"), List.of());

        UiNode degraded = tailor.tailor(skeleton, level1());

        assertThat(degraded.type()).isEqualTo("progress");
        assertThat(degraded.props()).containsEntry("kind", "circular");
        assertThat(degraded.props()).doesNotContainKey("value");
    }

    @Test
    void avatarDowngradesToACircleFigure() {
        UiNode avatar = new UiNode("avatar", Map.of("initials", "AB", "size", 48), List.of());

        UiNode degraded = tailor.tailor(avatar, level1());

        assertThat(degraded.type()).isEqualTo("figure");
        assertThat(degraded.props()).containsEntry("shape", "circle").containsEntry("width", 48)
                .containsEntry("height", 48);
    }

    @Test
    void menuDowngradesToAList() {
        UiNode menu = new UiNode("menu", Map.of("items", List.of(Map.of("label", "Pin"))), List.of());

        UiNode degraded = tailor.tailor(menu, level1());

        assertThat(degraded.type()).isEqualTo("list");
        assertThat(castList(degraded.props().get("items"))).contains("Pin");
    }

    @Test
    void treeDowngradesToAList() {
        UiNode tree = new UiNode("tree", Map.of("items", List.of(Map.of("label", "src"))), List.of());

        UiNode degraded = tailor.tailor(tree, level1());

        assertThat(degraded.type()).isEqualTo("list");
        assertThat(castList(degraded.props().get("items"))).contains("src");
    }

    @Test
    void richTextDowngradesToPlainText() {
        UiNode richText = new UiNode("rich_text",
                Map.of("spans", List.of(Map.of("text", "Hello "), Map.of("text", "world"))), List.of());

        UiNode degraded = tailor.tailor(richText, level1());

        assertThat(degraded.type()).isEqualTo("text");
        assertThat(degraded.props()).containsEntry("text", "Hello world");
    }

    // ---- level-3 downgrade table (docs/sdui.md section 6, T88) ----

    @Test
    void splitDowngradesToAColumnStackingThePanes() {
        UiNode split = new UiNode("split", Map.of(
                "first", textNode("First pane"),
                "second", textNode("Second pane"),
                "axis", "horizontal",
                "initial", 256,
                "min", 208,
                "minSecond", 640,
                "persistKey", "qa_probe_split",
                "handleStyle", "rail"), List.of());

        UiNode degraded = tailor.tailor(split, level2());

        assertThat(degraded.type()).isEqualTo("column");
        assertThat(degraded.props()).doesNotContainKeys(
                "first", "second", "axis", "initial", "min", "minSecond", "persistKey",
                "handleStyle");
        assertThat(degraded.children()).hasSize(2);
    }

    @Test
    void hoverCardDegradesToItsTriggerKeepingTheTooltip() {
        UiNode hoverCard = new UiNode("hover_card", Map.of(
                "id", "probe-hover-card",
                "tooltip", "kept tooltip",
                "trigger", textNode("Hover trigger"),
                "content", textNode("Hover content"),
                "delay", 500,
                "placement", "top"), List.of());

        UiNode degraded = tailor.tailor(hoverCard, level2());

        assertThat(degraded.type()).isEqualTo("text");
        assertThat(degraded.props()).containsEntry("text", "Hover trigger")
                .containsEntry("tooltip", "kept tooltip")
                .containsEntry("id", "probe-hover-card")
                .doesNotContainKeys("content", "delay", "placement");
    }

    @Test
    void hoverCardWithoutATriggerDegradesToAnEmptyColumn() {
        UiNode hoverCard = new UiNode("hover_card",
                Map.of("content", textNode("Hover content")), List.of());

        UiNode degraded = tailor.tailor(hoverCard, level2());

        assertThat(degraded.type()).isEqualTo("column");
        assertThat(degraded.children()).isEmpty();
    }

    @Test
    void toastStackDegradesToAColumnOfTexts() {
        UiNode toastStack = new UiNode("toast_stack", Map.of(
                "id", "probe-toast-stack",
                "direction", "bottom",
                "items", List.of(
                        Map.of("text", "Saved", "style", "success", "duration", 5000),
                        Map.of("text", "Deleted"))), List.of());

        UiNode degraded = tailor.tailor(toastStack, level2());

        assertThat(degraded.type()).isEqualTo("column");
        assertThat(degraded.props()).containsEntry("id", "probe-toast-stack")
                .doesNotContainKeys("items", "direction");
        assertThat(degraded.children()).hasSize(2);
        assertThat(((UiNode) degraded.children().get(0)).props()).containsEntry("text", "Saved");
        assertThat(((UiNode) degraded.children().get(1)).props()).containsEntry("text", "Deleted");
    }

    @Test
    void kbdDegradesToMonoText() {
        UiNode kbd = new UiNode("kbd", Map.of("id", "probe-kbd", "chord", "mod+shift+m"), List.of());

        UiNode degraded = tailor.tailor(kbd, level2());

        assertThat(degraded.type()).isEqualTo("text");
        assertThat(degraded.props()).containsEntry("text", "mod+shift+m")
                .containsEntry("style", "mono")
                .doesNotContainKey("chord");
    }

    @Test
    void scrollFadeDegradesToAScrollAroundTheSameChild() {
        UiNode scrollFade = new UiNode("scroll_fade", Map.of(
                "edge", "top",
                "height", 24,
                "mode", "topbar",
                "child", textNode("Scrollable body")), List.of());

        UiNode degraded = tailor.tailor(scrollFade, level2());

        assertThat(degraded.type()).isEqualTo("scroll");
        assertThat(degraded.props()).doesNotContainKeys("edge", "height", "mode", "child");
        assertThat(degraded.children()).hasSize(1);
    }

    @Test
    void diffViewDegradesToACodeBlockWithFileAndHeaders() {
        UiNode diffView = new UiNode("diff_view", Map.ofEntries(
                Map.entry("id", "probe-diff-view"),
                Map.entry("file", "docs/sdui.md"),
                Map.entry("language", "markdown"),
                Map.entry("view", "unified"),
                Map.entry("colorScheme", "default"),
                Map.entry("stats", Map.of("additions", 2, "deletions", 1)),
                Map.entry("demo", true),
                Map.entry("hunks", List.of(
                        Map.of("header", "@@ -1,3 +1,4 @@", "lines", List.of()),
                        Map.of("header", "@@ -9,2 +10,3 @@", "lines", List.of())))),
                List.of());

        UiNode degraded = tailor.tailor(diffView, level2());

        assertThat(degraded.type()).isEqualTo("code_block");
        assertThat(degraded.props()).containsEntry("code", "docs/sdui.md\n@@ -1,3 +1,4 @@\n@@ -9,2 +10,3 @@")
                .containsEntry("language", "markdown")
                .containsEntry("demo", true)
                .doesNotContainKeys("hunks", "view", "colorScheme", "stats");
    }

    @Test
    void glassAndStatusPulseAreStrippedAndDemoSurvivesBelowLevel3() {
        UiNode card = new UiNode("card", Map.of(
                "id", "probe-glass",
                "glass", true), List.of());
        UiNode progress = new UiNode("progress", Map.of(
                "id", "probe-pulse",
                "kind", "linear",
                "statusPulse", "pulse"), List.of());
        UiNode button = new UiNode("button", Map.of(
                "id", "probe-demo",
                "label", "Decorative",
                "demo", true), List.of());

        assertThat(tailor.tailor(card, level2()).props()).doesNotContainKey("glass");
        assertThat(tailor.tailor(progress, level2()).props()).doesNotContainKey("statusPulse")
                .containsEntry("kind", "linear");
        assertThat(tailor.tailor(button, level2()).props()).containsEntry("demo", true);
    }

    @Test
    void level3NodesPassThroughAtLevel3() {
        UiNode split = new UiNode("split", Map.of(
                "first", textNode("First pane"),
                "second", textNode("Second pane")), List.of());
        UiNode card = new UiNode("card", Map.of("glass", true), List.of());

        assertThat(tailor.tailor(split, level3()).type()).isEqualTo("split");
        assertThat(tailor.tailor(card, level3()).props()).containsEntry("glass", true);
    }

    /** The level-3 downgrade chains into the level-2 one for an api=1 client. */
    @Test
    void level3AndLevel2DowngradesChainForALevel1Client() {
        UiNode split = new UiNode("split", Map.of(
                "first", textNode("First pane"),
                "second", textNode("Second pane")), List.of());
        UiNode kbd = new UiNode("kbd", Map.of("chord", "mod+shift+m"), List.of());

        // split rewrites to a column in the level-3 step; the level-2 table
        // (which maps `row`, not `column`) leaves it as the column it is.
        UiNode degradedSplit = tailor.tailor(split, level1());
        assertThat(degradedSplit.type()).isEqualTo("column");
        assertThat(degradedSplit.children()).hasSize(2);

        UiNode degradedKbd = tailor.tailor(kbd, level1());
        assertThat(degradedKbd.type()).isEqualTo("text");
        assertThat(degradedKbd.props()).containsEntry("text", "mod+shift+m")
                .containsEntry("style", "mono");
    }

    @Test
    void downgradeDoesNotApplyAtLevel2() {
        UiNode chip = new UiNode("chip", Map.of("label", "Beta"), List.of());

        UiNode same = tailor.tailor(chip, new ClientInfo(2, "0.3.0", 3, Set.of()));

        assertThat(same.type()).isEqualTo("chip");
    }

    @Test
    void nestedNodesInsideDescriptorMapsAreTailored() {
        UiNode row = new UiNode("list_row", Map.of(
                "id", "nested-row",
                "title", new UiNode("hover_card", Map.of(
                        "trigger", textNode("Row title"),
                        "content", textNode("Card content")), List.of())), List.of());
        UiNode list = new UiNode("list", Map.of(
                "sections", List.of(Map.of(
                        "id", "section-1",
                        "items", List.of(Map.of("id", "item-1", "title", row))))), List.of());

        UiNode degraded = tailor.tailor(list, level2());

        Object section = ((List<?>) degraded.props().get("sections")).get(0);
        Object item = ((List<?>) castMap(section).get("items")).get(0);
        UiNode title = (UiNode) castMap(item).get("title");
        assertThat(title.type()).isEqualTo("list_row");
        UiNode hover = (UiNode) title.props().get("title");
        assertThat(hover.type()).isEqualTo("text");
        assertThat(hover.props()).containsEntry("text", "Row title")
                .doesNotContainKey("content");
    }

    @Test
    void directiveEmbeddedNodesAreTailored() {
        UiNode dialog = new UiNode("column", Map.of("id", "model-dialog"),
                List.of(new UiNode("kbd", Map.of("chord", "mod+shift+m"), List.of())));
        UiNode button = new UiNode("button", Map.of(
                "id", "picker",
                "label", "Opus",
                "action", Map.of("op", "dialog", "node", dialog.toJson())), List.of());

        UiNode degraded = tailor.tailor(button, level2());

        Map<String, Object> action = castMap(degraded.props().get("action"));
        Map<String, Object> node = castMap(action.get("node"));
        Map<String, Object> kbd = castMap(((List<?>) node.get("children")).get(0));
        assertThat(kbd).containsEntry("type", "text")
                .containsEntry("text", "mod+shift+m")
                .doesNotContainKey("chord");
    }

    // ---- helpers ----

    private static ClientInfo level1() {
        return new ClientInfo(1, "0.3.0", 1, Set.of());
    }

    private static ClientInfo level2() {
        return new ClientInfo(2, "0.3.0", 3, Set.of());
    }

    private static ClientInfo level3() {
        return new ClientInfo(3, "0.3.0", 4, Set.of());
    }

    private static UiNode textNode(String text) {
        return new UiNode("text", Map.of("text", text), List.of());
    }

    private Map<String, Object> bootstrap(ClientInfo client) {
        return bootstrap(UiSettings.open(tmp), client);
    }

    private Map<String, Object> bootstrap(UiSettings settings, ClientInfo client) {
        BootstrapRoute route = new BootstrapRoute(screens(), false, tailor, settings);
        HttpResponse response = route.handle(request(client));
        assertThat(response.status()).isEqualTo(200);
        return Json.readMap(new String(response.body()));
    }

    private static FakeHttpRequest request(ClientInfo client) {
        return new FakeHttpRequest("GET", "/_jhin/bootstrap", Map.of(), Map.of(), "", client, Map.of());
    }

    private ScreenRegistry screens() {
        UiNode screen = Ui.screen().title("Fixture")
                .body(Ui.text("hello").build())
                .build();
        Map<String, Supplier<UiNode>> registry = new LinkedHashMap<>();
        registry.put("sessions", () -> screen);
        return (account, overrides) -> registry;
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
