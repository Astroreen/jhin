package com.astroreen.jhin.kernel.http;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.http.HttpHandler;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.http.RouteSpec;
import com.astroreen.jhin.sdk.http.TlsProvider;
import java.security.KeyStore;
import org.junit.jupiter.api.Test;

class HttpRegistryImplTest {

    private static HttpHandler handler(String name) {
        return req -> HttpResponse.text(200, name);
    }

    private static TlsProvider tlsMaterial(String marker) {
        return new TlsProvider() {
            @Override
            public KeyStore keyStore() {
                throw new UnsupportedOperationException(marker);
            }

            @Override
            public char[] keyStorePassword() {
                throw new UnsupportedOperationException(marker);
            }
        };
    }

    private final HttpRegistryImpl registry = new HttpRegistryImpl();

    @Test
    void tlsIsFirstWinsAndRecordsTheOwningPlugin() {
        TlsProvider first = tlsMaterial("first");
        TlsProvider second = tlsMaterial("second");

        registry.attributedTo("demo.one", () -> registry.tls(first));
        registry.attributedTo("demo.two", () -> registry.tls(second));

        assertThat(registry.acceptedTls()).isPresent();
        assertThat(registry.acceptedTls().orElseThrow().source()).isSameAs(first);
        assertThat(registry.acceptedTls().orElseThrow().owner()).isEqualTo("demo.one");
    }

    @Test
    void registrationsInsideAttributionAreOwnedByTheCallingPlugin() {
        registry.attributedTo("demo.one",
                () -> registry.route(new RouteSpec("GET", "/x", handler("one"))));

        Throwable thrown = catchThrowable(() -> registry.attributedTo("demo.two",
                () -> registry.route(new RouteSpec("GET", "/x", handler("two")))));

        assertThat(thrown).isInstanceOf(PluginException.class)
                .hasMessage("route conflict: GET /x already owned by demo.one");
    }

    @Test
    void registrationsOutsideAttributionAreOwnedByTheKernel() {
        registry.route(new RouteSpec("GET", "/x", handler("host")));

        Throwable thrown = catchThrowable(
                () -> registry.route(new RouteSpec("GET", "/x", handler("other"))));

        assertThat(thrown).isInstanceOf(PluginException.class)
                .hasMessage("route conflict: GET /x already owned by "
                        + HttpRegistryImpl.HOST_OWNER);
    }

    @Test
    void fallbackRegistrationIsReplacedSilentlyByAPluginRoute() {
        RouteSpec fallback = new RouteSpec("GET", "/_jhin/bootstrap", handler("fallback"));
        RouteSpec plugin = new RouteSpec("GET", "/_jhin/bootstrap", handler("plugin"));
        registry.registerFallback(fallback);

        Throwable replacement = catchThrowable(
                () -> registry.attributedTo("demo.one", () -> registry.route(plugin)));
        assertThat(replacement).isNull();

        RouteMatcher matcher = new RouteMatcher(registry.routeTable());
        assertThat(matcher.resolve("GET", "/_jhin/bootstrap").route()).isSameAs(plugin);
    }
}