/**
 * T56 QA evidence: dumps representative bootstrap payload bytes into the
 * module build directory for {@code scripts/qa/t56.sh} to copy and
 * jq-assert — api=2, api=1, absent header, garbage header and
 * caps-without-sse. Not an assertion suite itself ({@link BootstrapRouteTest}
 * and {@link BootstrapContractTest} already assert the shapes); this only
 * captures the wire bytes a live server would answer with, reusing the same
 * sessions-plugin fixture as {@link BootstrapRouteTest} so the
 * caps-without-sse fixture actually exercises the {@code stream_view} degrade.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.http.ClientInfo;
import com.astroreen.jhin.sdk.http.HttpResponse;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class BootstrapEvidenceTest {

    /** Relative to the module's test-task working directory (the module dir). */
    private static final Path EVIDENCE_DIR = Path.of("build", "evidence-t56");

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private EventLog eventLog;
    private String sessionId;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        RecordingStreamRegistry streams = new RecordingStreamRegistry();
        FakePluginContext.FakeServices services = new FakePluginContext.FakeServices();
        new com.astroreen.jhin.plugin.sessions.SessionsPlugin()
                .start(new FakePluginContext(tmp, "jhin.sessions", db, streams, services));
        eventLog = services.find(EventLog.class).orElseThrow();
        SessionStore store = services.find(SessionStore.class).orElseThrow();
        sessionId = store.create("demo", "/tmp/work").id();
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void writesTheQaFixtures() throws IOException {
        Files.createDirectories(EVIDENCE_DIR);
        CapabilityTailor tailor = new CapabilityTailor(eventLog);
        BootstrapRoute route = new BootstrapRoute(screens(), false, tailor,
                UiSettings.open(tmp));

        dump(route, "bootstrap-api2.json", new ClientInfo(2, "0.3.0", 3, Set.of("sse")));
        dump(route, "bootstrap-api1.json", new ClientInfo(1, "0.3.0", 1, Set.of("sse")));
        dump(route, "absent-header.json", ClientInfo.UNKNOWN);
        dump(route, "garbage-client.json", ClientInfo.parse("api=0;schema=99"));
        dump(route, "caps-no-sse.json", new ClientInfo(2, "0.3.0", 3, Set.of()));
    }

    private void dump(BootstrapRoute route, String fileName, ClientInfo client) throws IOException {
        HttpResponse response = route.handle(request(client));
        Files.write(EVIDENCE_DIR.resolve(fileName), response.body());
    }

    private static FakeHttpRequest request(ClientInfo client) {
        return new FakeHttpRequest("GET", "/_jhin/bootstrap", Map.of(), Map.of(), "", client, Map.of());
    }

    /** A fixture registry whose single screen carries a stream view, so the
     * caps-without-sse fixture exercises the stream_view -> list degrade. */
    private ScreenRegistry screens() {
        UiNode screen = Ui.screen()
                .title("Fixture")
                .body(Ui.container()
                        .direction("column")
                        .child(Ui.streamView("activity", "/ui/stream/session/" + sessionId)
                                .mode("append").itemLimit(20).empty("No activity yet.")
                                .build())
                        .build())
                .build();
        Map<String, Supplier<UiNode>> registry = new LinkedHashMap<>();
        registry.put("sessions", () -> screen);
        return (account, overrides) -> registry;
    }
}
