/**
 * Action dispatch: the {@code {"client":[…]}} contract of a known action, the
 * capability filter over its directive list, the merged payload handed to the
 * handler and the {@code unknown_action} / {@code invalid_request} failure
 * codes.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.sdk.http.ClientInfo;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

class ActionRouteTest {

    private static final ClientInfo NO_CAPS = new ClientInfo(1, "0.2.0", Set.of());

    private static final ClientInfo FULL_CAPS =
            new ClientInfo(1, "0.2.0", Set.of("open_url", "secure_storage", "multi_profile"));

    @Test
    void dispatchesTheNamedActionAndReturnsClientDirectives() {
        ActionRoute route = route(Map.of("go", (req, payload) -> List.of(
                Directives.navigate("sessions"),
                Directives.toast("done"))));

        HttpResponse response = route.handle(request("go", "{}", NO_CAPS));

        assertThat(response.status()).isEqualTo(200);
        Map<String, Object> body = Json.readMap(new String(response.body()));
        List<Object> client = castList(body.get("client"));
        assertThat(client).hasSize(2);
        assertThat(castMap(client.get(0))).containsEntry("op", "navigate");
        assertThat(castMap(client.get(1))).containsEntry("op", "toast");
    }

    @Test
    void passesTheBodyPayloadToTheHandler() {
        List<Map<String, Object>> seen = new ArrayList<>();
        ActionRoute route = route(Map.of("go", (req, payload) -> {
            seen.add(payload);
            return List.of();
        }));

        route.handle(request("go", "{\"action\":\"go\",\"payload\":{\"sessionId\":\"s1\",\"n\":2}}", NO_CAPS));

        assertThat(seen).hasSize(1);
        assertThat(seen.get(0)).containsEntry("sessionId", "s1").containsEntry("n", 2);
    }

    @Test
    void dropsGatedDirectivesTheClientCannotHonour() {
        ActionRoute route = route(Map.of("enroll", (req, payload) -> List.of(
                Directives.setToken("t"),
                Directives.clearToken(),
                Directives.openUrl("https://example.invalid"),
                Directives.setServerUrl("https://example.invalid"),
                Directives.navigate("sessions"))));

        HttpResponse filtered = route.handle(request("enroll", "{}", NO_CAPS));
        List<Object> client = castList(Json.readMap(new String(filtered.body())).get("client"));
        assertThat(client).hasSize(1);
        assertThat(castMap(client.get(0))).containsEntry("op", "navigate");

        HttpResponse full = route.handle(request("enroll", "{}", FULL_CAPS));
        List<Object> kept = castList(Json.readMap(new String(full.body())).get("client"));
        assertThat(kept).hasSize(5);
    }

    @Test
    void unknownActionIs404NamedUnknownAction() {
        ActionRoute route = route(Map.of());

        HttpResponse response = route.handle(request("nope", "{}", NO_CAPS));

        assertThat(response.status()).isEqualTo(404);
        assertThat(new String(response.body())).contains("unknown_action");
    }

    @Test
    void malformedBodyIs400NamingTheBody() {
        ActionRoute route = route(Map.of("go", (req, payload) -> List.of()));

        HttpResponse response = route.handle(request("go", "not json", NO_CAPS));

        assertThat(response.status()).isEqualTo(400);
        assertThat(new String(response.body())).contains("body");
    }

    private static ActionRoute route(Map<String, ActionRoute.ActionHandler> handlers) {
        return new ActionRoute(handlers);
    }

    private static FakeHttpRequest request(String name, String body, ClientInfo client) {
        return new FakeHttpRequest("POST", "/ui/action/" + name, Map.of("name", name), Map.of(),
                body, client, Map.of());
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
