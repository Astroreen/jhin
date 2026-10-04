/**
 * T56: the level-2 bootstrap payload (contract/theme/tokens/density/keymap),
 * its api/schema negotiation and the level-2 -> level-1 primitive downgrade
 * table — docs/sdui.md sections 1 and 6.
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
import com.astroreen.jhin.sdk.http.ClientInfo;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;

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

    // ---- top-level payload shape (docs/sdui.md section 1) ----

    @Test
    void api2PayloadCarriesTheFullLevel2Shape() {
        Map<String, Object> payload = bootstrap(new ClientInfo(2, "0.3.0", 3, Set.of()));

        assertThat(payload).containsEntry("api", 2);
        Map<String, Object> contract = castMap(payload.get("contract"));
        assertThat(contract).containsEntry("api", 2).containsEntry("minApi", 2)
                .containsEntry("schema", 3).containsEntry("minSchema", 3);
        Map<String, Object> tokens = castMap(payload.get("tokens"));
        assertThat(castMap(tokens.get("spacing"))).containsEntry("md", 12);
        assertThat(payload).containsEntry("density", "comfortable");
        List<Object> keymap = castList(payload.get("keymap"));
        assertThat(keymap.size()).isGreaterThanOrEqualTo(8);
        Map<String, Object> theme = castMap(payload.get("theme"));
        assertThat(theme).containsKeys("appearance", "canvas", "accent", "colors", "mode");
        assertThat(theme.get("accent")).isEqualTo("#7E57C2");
        assertThat(theme.get("mode")).isEqualTo(theme.get("appearance"));
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
    void apiAboveTwoNegotiatesDownToTwo() {
        Map<String, Object> payload = bootstrap(new ClientInfo(5, "9.9.9", 3, Set.of()));

        assertThat(payload).containsEntry("api", 2);
        assertThat(castMap(payload.get("contract"))).containsEntry("api", 2);
    }

    // ---- entry / version gate (docs/sdui.md section 6, docs/updates.md rule 6) ----

    @Test
    void schemaBelowMinSchemaSetsTheVersionGateEntryForALevel2Client() {
        Map<String, Object> payload = bootstrap(new ClientInfo(2, "0.3.0", 1, Set.of()));

        assertThat(payload.get("entry")).isEqualTo("version_gate");
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

    @Test
    void downgradeDoesNotApplyAtLevel2() {
        UiNode chip = new UiNode("chip", Map.of("label", "Beta"), List.of());

        UiNode same = tailor.tailor(chip, new ClientInfo(2, "0.3.0", 3, Set.of()));

        assertThat(same.type()).isEqualTo("chip");
    }

    // ---- helpers ----

    private static ClientInfo level1() {
        return new ClientInfo(1, "0.3.0", 1, Set.of());
    }

    private static UiNode textNode(String text) {
        return new UiNode("text", Map.of("text", text), List.of());
    }

    private Map<String, Object> bootstrap(ClientInfo client) {
        BootstrapRoute route = new BootstrapRoute(screens(), false, tailor);
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
