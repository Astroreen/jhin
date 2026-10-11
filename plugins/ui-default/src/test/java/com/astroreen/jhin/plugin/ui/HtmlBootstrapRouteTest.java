/**
 * The level-4 bootstrap wire (docs/sdui.md section 1): the inline
 * {@code screens} are {@code {id, html}} entries rendered through
 * {@code HtmlRenderer}, the {@code fallbacks} are HTML strings, and
 * hostile screen content ships escaped — a screen whose text carries
 * {@code <script>alert(1)</script>} appears as {@code &lt;script} in the
 * payload and never as a raw {@code <script} (escaping-through-tailor).
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
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class HtmlBootstrapRouteTest {

    /** The id of the fixture screen carrying the hostile text. */
    private static final String XSS_SCREEN = "xss";

    private static final ClientInfo API4 = new ClientInfo(4, "0.4.0", 5, Set.of("sse"));

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

    @Test
    void screensAreInlineHtmlFragments() {
        Map<String, Object> payload = bootstrap();

        List<Object> screens = castList(payload.get("screens"));
        assertThat(screens).hasSizeGreaterThanOrEqualTo(8);
        for (Object entry : screens) {
            Map<String, Object> screen = castMap(entry);
            assertThat(screen).containsOnlyKeys("id", "html");
            String html = String.valueOf(screen.get("html"));
            assertThat(html).as(String.valueOf(screen.get("id")))
                    .startsWith("<").contains("data-jhin-type=");
        }
    }

    @Test
    void fallbacksAreHtmlStrings() {
        Map<String, Object> payload = bootstrap();

        Map<String, Object> fallbacks = castMap(payload.get("fallbacks"));
        assertThat(String.valueOf(fallbacks.get("offline")))
                .startsWith("<").contains("data-jhin-type=");
        assertThat(String.valueOf(fallbacks.get("error")))
                .startsWith("<").contains("data-jhin-type=");
    }

    @Test
    void hostileScreenContentShipsEscaped() {
        Map<String, Object> payload = bootstrap();

        String wire = Json.write(payload);
        assertThat(wire).contains("&lt;script");
        assertThat(wire).doesNotContain("<script");
    }

    // --- fixtures ---

    private Map<String, Object> bootstrap() {
        BootstrapRoute route = new BootstrapRoute(screens(), false, tailor, UiSettings.open(tmp));
        HttpResponse response = route.handle(new FakeHttpRequest("GET", "/_jhin/bootstrap",
                Map.of(), Map.of(), "", API4, Map.of()));
        assertThat(response.status()).isEqualTo(200);
        return Json.readMap(new String(response.body()));
    }

    /**
     * The fixture registry: eight plain screens plus one carrying the
     * hostile text — nine inline entries in registration order.
     */
    private ScreenRegistry screens() {
        Map<String, Supplier<UiNode>> registry = new LinkedHashMap<>();
        for (int i = 1; i <= 8; i++) {
            String id = "fixture-" + i;
            registry.put(id, () -> Ui.screen()
                    .title(id)
                    .body(Ui.text("hello " + id).build())
                    .build());
        }
        registry.put(XSS_SCREEN, () -> Ui.screen()
                .title("hostile")
                .body(Ui.text("<script>alert(1)</script>").build())
                .build());
        return (account, overrides) -> registry;
    }

    // --- helpers ---

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> castList(Object value) {
        return (List<Object>) value;
    }
}
