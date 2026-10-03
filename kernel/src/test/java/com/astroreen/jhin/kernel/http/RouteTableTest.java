package com.astroreen.jhin.kernel.http;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.http.HttpHandler;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.http.RouteSpec;
import java.util.Map;
import org.junit.jupiter.api.Test;

class RouteTableTest {

    private static HttpHandler handler(String name) {
        return req -> HttpResponse.text(200, name);
    }

    private final RouteTable table = new RouteTable();
    private final RouteMatcher matcher = new RouteMatcher(table);

    @Test
    void matchesExactLiteralPath() {
        RouteSpec route = new RouteSpec("GET", "/health", handler("health"));
        table.register(route, "demo.one");

        RouteMatcher.Resolution res = matcher.resolve("GET", "/health");
        assertThat(res.status()).isEqualTo(RouteMatcher.Status.MATCHED);
        assertThat(res.route()).isSameAs(route);
        assertThat(res.pathParams()).isEmpty();
    }

    @Test
    void matchesRootPath() {
        RouteSpec route = new RouteSpec("GET", "/", handler("root"));
        table.register(route, "demo.one");

        RouteMatcher.Resolution res = matcher.resolve("GET", "/");
        assertThat(res.status()).isEqualTo(RouteMatcher.Status.MATCHED);
        assertThat(res.route()).isSameAs(route);
    }

    @Test
    void capturesSinglePathParam() {
        RouteSpec route = new RouteSpec("GET", "/items/{id}", handler("one"));
        table.register(route, "demo.one");

        RouteMatcher.Resolution res = matcher.resolve("GET", "/items/42");
        assertThat(res.status()).isEqualTo(RouteMatcher.Status.MATCHED);
        assertThat(res.route()).isSameAs(route);
        assertThat(res.pathParams()).containsExactlyInAnyOrderEntriesOf(Map.of("id", "42"));
    }

    @Test
    void percentDecodesCapturedPathParam() {
        RouteSpec route = new RouteSpec("GET", "/ui/screen/{id}", handler("screen"));
        table.register(route, "demo.one");

        RouteMatcher.Resolution res = matcher.resolve("GET", "/ui/screen/chat%3Aabc");
        assertThat(res.status()).isEqualTo(RouteMatcher.Status.MATCHED);
        assertThat(res.route()).isSameAs(route);
        assertThat(res.pathParams()).containsExactlyInAnyOrderEntriesOf(Map.of("id", "chat:abc"));
    }

    @Test
    void keepsLiteralPlusInCapturedPathParam() {
        RouteSpec route = new RouteSpec("GET", "/items/{id}", handler("one"));
        table.register(route, "demo.one");

        RouteMatcher.Resolution res = matcher.resolve("GET", "/items/a+b");
        assertThat(res.pathParams()).containsExactlyInAnyOrderEntriesOf(Map.of("id", "a+b"));
    }

    @Test
    void capturesMultiplePathParams() {
        RouteSpec route = new RouteSpec("GET", "/items/{id}/events/{seq}", handler("multi"));
        table.register(route, "demo.one");

        RouteMatcher.Resolution res = matcher.resolve("GET", "/items/7/events/3");
        assertThat(res.status()).isEqualTo(RouteMatcher.Status.MATCHED);
        assertThat(res.pathParams())
                .containsExactlyInAnyOrderEntriesOf(Map.of("id", "7", "seq", "3"));
    }

    @Test
    void literalSegmentBeatsParamSegment() {
        RouteSpec param = new RouteSpec("GET", "/sessions/{id}", handler("param"));
        RouteSpec literal = new RouteSpec("GET", "/sessions/new", handler("literal"));
        table.register(param, "demo.one");
        table.register(literal, "demo.one");

        RouteMatcher.Resolution literalWin = matcher.resolve("GET", "/sessions/new");
        assertThat(literalWin.status()).isEqualTo(RouteMatcher.Status.MATCHED);
        assertThat(literalWin.route()).isSameAs(literal);

        RouteMatcher.Resolution paramWin = matcher.resolve("GET", "/sessions/42");
        assertThat(paramWin.status()).isEqualTo(RouteMatcher.Status.MATCHED);
        assertThat(paramWin.route()).isSameAs(param);
        assertThat(paramWin.pathParams()).containsExactlyInAnyOrderEntriesOf(Map.of("id", "42"));
    }

    @Test
    void literalPreferenceIsLeftToRightAtFirstDifferingSegment() {
        RouteSpec paramFirst = new RouteSpec("GET", "/a/{x}/c", handler("param-first"));
        RouteSpec literalSecond = new RouteSpec("GET", "/a/b/{y}", handler("literal-second"));
        table.register(paramFirst, "demo.one");
        table.register(literalSecond, "demo.one");

        RouteMatcher.Resolution res = matcher.resolve("GET", "/a/b/c");
        assertThat(res.status()).isEqualTo(RouteMatcher.Status.MATCHED);
        assertThat(res.route()).isSameAs(literalSecond);
        assertThat(res.pathParams()).containsExactlyInAnyOrderEntriesOf(Map.of("y", "c"));
    }

    @Test
    void paramBranchBacktracksWhenLiteralBranchDeadEnds() {
        RouteSpec deepLiteral = new RouteSpec("GET", "/a/{x}/d", handler("deep-literal"));
        RouteSpec earlyLiteral = new RouteSpec("GET", "/a/b/{y}", handler("early-literal"));
        table.register(deepLiteral, "demo.one");
        table.register(earlyLiteral, "demo.one");

        RouteMatcher.Resolution res = matcher.resolve("GET", "/a/q/d");
        assertThat(res.status()).isEqualTo(RouteMatcher.Status.MATCHED);
        assertThat(res.route()).isSameAs(deepLiteral);
        assertThat(res.pathParams()).containsExactlyInAnyOrderEntriesOf(Map.of("x", "q"));
    }

    @Test
    void samePathUnderDifferentMethodsMatchesEachMethod() {
        RouteSpec get = new RouteSpec("GET", "/x", handler("get"));
        RouteSpec post = new RouteSpec("POST", "/x", handler("post"));
        table.register(get, "demo.one");
        table.register(post, "demo.two");

        RouteMatcher.Resolution getRes = matcher.resolve("GET", "/x");
        assertThat(getRes.status()).isEqualTo(RouteMatcher.Status.MATCHED);
        assertThat(getRes.route()).isSameAs(get);

        RouteMatcher.Resolution postRes = matcher.resolve("POST", "/x");
        assertThat(postRes.status()).isEqualTo(RouteMatcher.Status.MATCHED);
        assertThat(postRes.route()).isSameAs(post);
    }

    @Test
    void unknownPathResolvesToNotFound() {
        table.register(new RouteSpec("GET", "/x", handler("x")), "demo.one");

        RouteMatcher.Resolution res = matcher.resolve("GET", "/nope");
        assertThat(res.status()).isEqualTo(RouteMatcher.Status.NOT_FOUND);
        assertThat(res.route()).isNull();
    }

    @Test
    void knownPathWithOtherMethodResolvesToMethodNotAllowed() {
        table.register(new RouteSpec("GET", "/x", handler("get")), "demo.one");

        RouteMatcher.Resolution res = matcher.resolve("POST", "/x");
        assertThat(res.status()).isEqualTo(RouteMatcher.Status.METHOD_NOT_ALLOWED);
        assertThat(res.route()).isNull();
    }

    @Test
    void paramTemplateUnderOtherMethodResolvesToMethodNotAllowed() {
        table.register(new RouteSpec("GET", "/items/{id}", handler("get")), "demo.one");

        RouteMatcher.Resolution res = matcher.resolve("DELETE", "/items/7");
        assertThat(res.status()).isEqualTo(RouteMatcher.Status.METHOD_NOT_ALLOWED);
    }

    @Test
    void pluginRouteSilentlyReplacesFallbackRoute() {
        RouteSpec fallback = new RouteSpec("GET", "/_jhin/bootstrap", handler("fallback"));
        RouteSpec plugin = new RouteSpec("GET", "/_jhin/bootstrap", handler("plugin"));
        table.registerFallback(fallback, "kernel");

        Throwable replacement = catchThrowable(() -> table.register(plugin, "demo.one"));
        assertThat(replacement).isNull();

        RouteMatcher.Resolution res = matcher.resolve("GET", "/_jhin/bootstrap");
        assertThat(res.status()).isEqualTo(RouteMatcher.Status.MATCHED);
        assertThat(res.route()).isSameAs(plugin);
    }

    @Test
    void duplicateNonFallbackRegistrationThrowsWithExactConflictText() {
        table.register(new RouteSpec("GET", "/x", handler("one")), "demo.one");

        Throwable thrown = catchThrowable(
                () -> table.register(new RouteSpec("GET", "/x", handler("two")), "demo.two"));

        assertThat(thrown).isInstanceOf(PluginException.class)
                .hasMessage("route conflict: GET /x already owned by demo.one");
        System.out.println("conflict-error: " + thrown);
    }
}
