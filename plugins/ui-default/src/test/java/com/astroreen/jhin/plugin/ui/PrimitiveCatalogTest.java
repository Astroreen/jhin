/**
 * T78: every screen tree the default plugin emits uses only primitives of
 * the documented catalog (docs/sdui.md section 2.5). The catalog is parsed
 * out of the contract document itself, so a new primitive must be documented
 * before any screen can emit it.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.llm.api.ProviderRecord;
import com.astroreen.jhin.plugin.llm.api.ProviderConfig;
import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.ui.screens.ChatScreen;
import com.astroreen.jhin.plugin.ui.screens.EnrollScreen;
import com.astroreen.jhin.plugin.ui.screens.PluginsScreen;
import com.astroreen.jhin.plugin.ui.screens.ProvidersScreen;
import com.astroreen.jhin.plugin.ui.screens.QaProbeScreen;
import com.astroreen.jhin.plugin.ui.screens.SessionsScreen;
import com.astroreen.jhin.plugin.ui.screens.SettingsScreen;
import com.astroreen.jhin.sdk.ApiVersion;
import com.astroreen.jhin.sdk.KernelInfo;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class PrimitiveCatalogTest {

    /** The normative contract document, relative to this module. */
    private static final Path DOC = Path.of("..", "..", "docs", "sdui.md");

    private static final Pattern BACKTICK = Pattern.compile("`([^`]+)`");

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private SessionStore store;
    private EventLog events;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        RecordingStreamRegistry streams = new RecordingStreamRegistry();
        FakePluginContext.FakeServices services = new FakePluginContext.FakeServices();
        new com.astroreen.jhin.plugin.sessions.SessionsPlugin()
                .start(new FakePluginContext(tmp, "jhin.sessions", db, streams, services));
        store = services.find(SessionStore.class).orElseThrow();
        events = services.find(EventLog.class).orElseThrow();
    }

    @Test
    void everyScreenTreeUsesOnlyDocumentedPrimitives() throws IOException {
        Set<String> catalog = documentedCatalog();
        assertThat(catalog).as("the section 2.5 catalog parsed from docs/sdui.md")
                .contains("screen", "card", "list_row", "segmented", "slider", "switch");

        Session session = store.create("demo", "/tmp/work");
        events.append(session.id(), EventType.USER_MESSAGE, "{\"text\":\"hi\"}");

        FakeProviderRegistry providers = new FakeProviderRegistry(List.of("mock"));
        providers.create("mock", new ProviderConfig(null, "echo", null));

        List<Map<String, Object>> trees = List.of(
                SettingsScreen.render(Optional.of("acc-1"), true, true,
                        DefaultKeymap.entries(), Map.of(), UiSettings.Snapshot.defaults()).toJson(),
                SessionsScreen.render(store, Optional.empty(), true, false).toJson(),
                ChatScreen.render(session, events.list(session.id(), 0)).toJson(),
                EnrollScreen.render().toJson(),
                PluginsScreen.render(List.of(
                        new KernelInfo.Loaded("jhin.ui", "0.2.0", "UI", List.of()))).toJson(),
                ProvidersScreen.render(providers, Optional.empty()).toJson(),
                QaProbeScreen.render().toJson());

        Set<String> used = new TreeSet<>();
        for (Map<String, Object> tree : trees) {
            collectTypes(tree, used, new LinkedHashSet<>());
        }
        assertThat(used).isNotEmpty();
        Set<String> undocumented = new TreeSet<>(used);
        undocumented.removeAll(catalog);
        assertThat(undocumented)
                .as("primitive types missing from the docs/sdui.md section 2.5 catalog")
                .isEmpty();
    }

    /**
     * T88: the contract level-3 catalog — docs/sdui.md section 2.5 lists
     * exactly 68 primitives (the 58 of level 2 plus the six level-3
     * primitives and the four level-3 universal names), and the six new
     * primitives are documented before any screen may emit them.
     */
    @Test
    void theCatalogListsExactly68PrimitivesIncludingTheLevel3Set() throws IOException {
        Set<String> catalog = documentedCatalog();

        assertThat(catalog).hasSize(68);
        assertThat(catalog).contains(
                "split", "hover_card", "toast_stack", "kbd", "scroll_fade", "diff_view",
                "glass", "demo", "statusPulse", "safeArea");
    }

    /**
     * The primitive names of the docs/sdui.md section 2.5 catalog: every
     * backtick span of the bullet list (including its wrapped continuation
     * lines) between the section headings.
     */
    private static Set<String> documentedCatalog() throws IOException {
        assertThat(DOC).as("docs/sdui.md exists relative to the module").exists();
        Set<String> names = new TreeSet<>();
        boolean inSection = false;
        for (String line : Files.readAllLines(DOC, StandardCharsets.UTF_8)) {
            if (line.startsWith("### 2.5 ")) {
                inSection = true;
                continue;
            }
            if (inSection && line.startsWith("### ")) {
                break;
            }
            if (!inSection) {
                continue;
            }
            String stripped = line.strip();
            boolean bullet = stripped.startsWith("- ");
            boolean continuation = line.startsWith("  ") && !stripped.isEmpty();
            if (!bullet && !continuation) {
                continue;
            }
            Matcher span = BACKTICK.matcher(line);
            while (span.find()) {
                names.add(span.group(1));
            }
        }
        return names;
    }

    /** Every {@code type} discriminator appearing anywhere in a fragment. */
    private static void collectTypes(Object fragment, Set<String> out, Set<Object> seen) {
        if (fragment instanceof Map<?, ?> map) {
            if (!seen.add(map)) {
                return;
            }
            Object type = map.get("type");
            if (type != null) {
                out.add(String.valueOf(type));
            }
            for (Object nested : map.values()) {
                collectTypes(nested, out, seen);
            }
        } else if (fragment instanceof List<?> list) {
            for (Object nested : list) {
                collectTypes(nested, out, seen);
            }
        }
    }
}