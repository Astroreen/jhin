/**
 * T117: the decorative-surface contract is mechanically enforced. Every
 * interactive node on a decorative screen must carry the universal
 * {@code demo} marker (docs/sdui.md section 2.1 level 3), and no real action
 * on a real screen may carry it (plan section 14.10: no silent decoration).
 *
 * <p>The screen inventory is the plan section 4.2 table: the fully decorative
 * screens, the partly-real screens (only their decorative parts are checked)
 * and the real screens (only their real actions are checked). The sweep walks
 * the JSON wire shape of every screen the default registry renders and
 * classifies each interactive node by its action shape:
 *
 * <ul>
 *   <li><b>real</b> — a server action ({@code action.name}) or a real client
 *       navigation ({@code navigate}/{@code replace}/{@code refresh}/
 *       {@code reloadBootstrap}/{@code back}/{@code openProfiles}/
 *       {@code openUrl}/{@code setToken}/{@code clearToken}/
 *       {@code setServerUrl});</li>
 *   <li><b>decorative</b> — an inline directive composite ({@code action.client})
 *       or a decorative directive ({@code dialog}/{@code dismissDialog}/
 *       {@code setState}/{@code patch}/{@code setScreen}/{@code toast});</li>
 *   <li><b>form field</b> — no action at all (a real setting bound to a form
 *       submit); exempt from the forward check.</li>
 * </ul>
 *
 * <p>The forward check fails when a decorative interactive node lacks
 * {@code demo: true}; the inverted check fails when a real action carries it.
 * A hidden seed node ({@code visible: false}) is decorative by construction
 * (the T110 fold seeds) and must be marked too.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.llm.api.ProviderRegistry;
import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.ApiVersion;
import com.astroreen.jhin.sdk.KernelInfo;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Supplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class DemoMarkerSweepTest {

    /** The interactive primitive types the sweep inspects (plan section T117). */
    private static final Set<String> INTERACTIVE = Set.of(
            "button", "icon_button", "switch", "dropdown", "input", "textarea", "tabs");

    /** The action ops that are real client navigation (never decorative). */
    private static final Set<String> REAL_OPS = Set.of(
            "navigate", "replace", "refresh", "reloadBootstrap", "back",
            "openProfiles", "openUrl", "setToken", "clearToken", "setServerUrl");

    /**
     * The server action names that are unambiguously real (they write to the
     * store or drive the run lifecycle). The decorative server action
     * ({@code preview-reload}) and the per-command
     * {@code keybind-edit} (real for the dispatched commands, decorative for
     * the inert upstream additions) are deliberately absent.
     */
    private static final Set<String> REAL_ACTION_NAMES = Set.of(
            "enroll", "create-session", "send", "cancel", "create-provider",
            "delete-provider", "reload", "undo", "keybind-save", "keybind-reset",
            "keybind-restore", "save-appearance", "save-thread-behavior",
            "pin", "unpin", "settle", "unsettle", "snooze", "wake", "archive",
            "restore", "regenerate-title", "reorder", "auto-settle",
            "delete-session", "arrange-toggle");

    /** The action ops that are decorative inline directives (section 4.4). */
    private static final Set<String> DECORATIVE_OPS = Set.of(
            "dialog", "dismissDialog", "setState", "patch", "setScreen", "toast");

    /** The fully decorative screens (plan section 4.2): every interactive node. */
    private static final List<String> DECORATIVE_SCREENS = List.of(
            "pull-requests", "connect", "project:jhin", "usage", "welcome",
            "settings:connections", "settings:integrations", "settings:projects",
            "settings:scheduled-tasks", "settings:source-control", "settings:snap-shot");

    /** The partly-real screens: only their decorative parts are checked. */
    private static final List<String> PARTLY_REAL_SCREENS = List.of(
            "settings:general", "settings:diagnostics", "settings:storage");

    /** The real screens: only their real actions are checked (inverted). */
    private static final List<String> REAL_SCREENS = List.of(
            "sessions", "settings", "settings:appearance", "settings:keybindings",
            "settings:providers", "settings:archived", "settings:licenses", "pair");

    private static final Features EVERYTHING = new Features(true, true, true, true);

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private SessionStore store;
    private EventLog events;
    private Screens screens;
    private Session session;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        RecordingStreamRegistry streams = new RecordingStreamRegistry();
        FakePluginContext.FakeServices services = new FakePluginContext.FakeServices();
        new com.astroreen.jhin.plugin.sessions.SessionsPlugin()
                .start(new FakePluginContext(tmp, "jhin.sessions", db, streams, services));
        store = services.find(SessionStore.class).orElseThrow();
        events = services.find(EventLog.class).orElseThrow();
        services.publish(ProviderRegistry.class,
                new FakeProviderRegistry(List.of("mock", "anthropic")));
        screens = new Screens(store, events, services, kernel(), EVERYTHING,
                UiSettings.open(tmp));
        session = store.create("demo", "/tmp/work");
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void everyDecorativeScreenMarksItsInteractiveNodes() {
        List<String> violations = new ArrayList<>();
        for (String id : DECORATIVE_SCREENS) {
            Map<String, Object> tree = tree(id);
            for (Map<String, Object> node : interactive(tree)) {
                if (isRealAction(node)) {
                    continue;
                }
                if (!Boolean.TRUE.equals(node.get("demo"))) {
                    violations.add(id + ": " + describe(node));
                }
            }
        }
        assertThat(violations)
                .as("decorative screens must demo-mark every interactive node")
                .isEmpty();
    }

    @Test
    void partlyRealScreensMarkTheirDecorativeParts() {
        List<String> violations = new ArrayList<>();
        for (String id : PARTLY_REAL_SCREENS) {
            Map<String, Object> tree = tree(id);
            for (Map<String, Object> node : interactive(tree)) {
                if (isRealAction(node)) {
                    continue;
                }
                boolean hiddenSeed = Boolean.FALSE.equals(node.get("visible"));
                if (!hiddenSeed && !isDecorativeAction(node)) {
                    // A visible form field with no action is a real setting.
                    continue;
                }
                if (!Boolean.TRUE.equals(node.get("demo"))) {
                    violations.add(id + ": " + describe(node));
                }
            }
        }
        assertThat(violations)
                .as("the decorative parts of the partly-real screens must be demo-marked")
                .isEmpty();
    }

    @Test
    void realScreensNeverMarkARealAction() {
        List<String> violations = new ArrayList<>();
        List<String> ids = new ArrayList<>(REAL_SCREENS);
        ids.add("chat:" + session.id());
        for (String id : ids) {
            Map<String, Object> tree = tree(id);
            for (Map<String, Object> node : interactive(tree)) {
                if (isRealAction(node) && Boolean.TRUE.equals(node.get("demo"))) {
                    violations.add(id + ": " + describe(node));
                }
            }
        }
        assertThat(violations)
                .as("real actions must never carry the demo marker")
                .isEmpty();
    }

    @Test
    void theSweepFailsOnAnInjectedUnmarkedButton() {
        // A decorative button with no demo marker, injected into a synthetic
        // tree the way the QA --fail path injects one into a live route.
        Map<String, Object> injected = new LinkedHashMap<>();
        injected.put("type", "button");
        injected.put("label", "Injected");
        injected.put("action", Map.of("client", List.of()));
        Map<String, Object> tree = synthetic(injected);

        List<String> violations = new ArrayList<>();
        for (Map<String, Object> node : interactive(tree)) {
            if (isRealAction(node)) {
                continue;
            }
            if (!Boolean.TRUE.equals(node.get("demo"))) {
                violations.add("usage: " + describe(node));
            }
        }
        assertThat(violations)
                .as("the sweep must catch the injected unmarked button")
                .anyMatch(v -> v.contains("Injected"));
    }

    @Test
    void theSweepFailsOnAnInjectedDemoMarkedRealAction() {
        Map<String, Object> injected = new LinkedHashMap<>();
        injected.put("type", "button");
        injected.put("label", "Injected real");
        injected.put("demo", true);
        injected.put("action", Map.of("name", "create-session"));
        Map<String, Object> tree = synthetic(injected);

        List<String> violations = new ArrayList<>();
        for (Map<String, Object> node : interactive(tree)) {
            if (isRealAction(node) && Boolean.TRUE.equals(node.get("demo"))) {
                violations.add("sessions: " + describe(node));
            }
        }
        assertThat(violations)
                .as("the inverted sweep must catch a demo-marked real action")
                .anyMatch(v -> v.contains("Injected real"));
    }

    private static Map<String, Object> synthetic(Map<String, Object> child) {
        Map<String, Object> tree = new LinkedHashMap<>();
        tree.put("type", "screen");
        tree.put("children", new ArrayList<>(List.of(child)));
        return tree;
    }

    // --- helpers ---

    private Map<String, Object> tree(String id) {
        Optional<Supplier<UiNode>> screen = screens.screen(id, Optional.empty(), Map.of());
        assertThat(screen).as("screen %s", id).isPresent();
        return screen.orElseThrow().get().toJson();
    }

    private static List<Map<String, Object>> interactive(Map<String, Object> tree) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(tree, node -> {
            if (INTERACTIVE.contains(String.valueOf(node.get("type")))) {
                found.add(node);
            }
        });
        return found;
    }

    private static boolean isRealAction(Map<String, Object> node) {
        Object action = node.get("action");
        if (!(action instanceof Map<?, ?> map)) {
            return false;
        }
        Object name = map.get("name");
        if (name != null && REAL_ACTION_NAMES.contains(String.valueOf(name))) {
            return true;
        }
        Object op = map.get("op");
        return op != null && REAL_OPS.contains(String.valueOf(op));
    }

    private static boolean isDecorativeAction(Map<String, Object> node) {
        Object action = node.get("action");
        if (!(action instanceof Map<?, ?> map)) {
            return false;
        }
        if (map.get("client") != null) {
            return true;
        }
        Object op = map.get("op");
        return op != null && DECORATIVE_OPS.contains(String.valueOf(op));
    }

    private static String describe(Map<String, Object> node) {
        return node.get("type") + " id=" + node.get("id") + " label=" + node.get("label");
    }

    private static KernelInfo kernel() {
        return new KernelInfo() {
            @Override
            public String version() {
                return "0.2.0";
            }

            @Override
            public int apiVersion() {
                return ApiVersion.CURRENT;
            }

            @Override
            public Path home() {
                return Path.of("/tmp");
            }

            @Override
            public List<Loaded> plugins() {
                return List.of(new Loaded("jhin.ui", "0.2.0", "UI", List.of()));
            }
        };
    }

    private static void walk(Object fragment,
                             java.util.function.Consumer<Map<String, Object>> seen) {
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
}