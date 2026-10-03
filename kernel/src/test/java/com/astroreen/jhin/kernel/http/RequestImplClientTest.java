package com.astroreen.jhin.kernel.http;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.servlet.http.HttpServletRequest;
import java.io.InputStream;
import java.lang.reflect.Proxy;
import java.util.Collections;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The client-info passthrough: the kernel parses the raw {@code X-Jhin-Client}
 * header through the SDK parser and hands the result to plugins unchanged —
 * including the {@code schema} field, which the kernel never interprets (no
 * version logic lives here; that is plugin and client business).
 */
class RequestImplClientTest {

    // the full level-2 header: every field reaches the plugin contract
    @Test
    void schemaFlowsThroughToThePluginContractUnchanged() {
        RequestImpl request = new RequestImpl(requestWith(Map.of(
                "X-Jhin-Client", "api=2; version=0.3.0; schema=3; caps=sse")));
        assertThat(request.client().api()).isEqualTo(2);
        assertThat(request.client().schema()).isEqualTo(3);
        assertThat(request.client().version()).isEqualTo("0.3.0");
        assertThat(request.client().supports("sse")).isTrue();
    }

    // an absent header behaves as the neutral api-1 / schema-1 client
    @Test
    void absentHeaderBehavesAsTheNeutralClient() {
        RequestImpl request = new RequestImpl(requestWith(Map.of()));
        assertThat(request.client().api()).isEqualTo(1);
        assertThat(request.client().schema()).isEqualTo(1);
        assertThat(request.client().version()).isEmpty();
    }

    // garbage values fall back to the neutral ones, never an exception
    @Test
    void garbageSchemaFallsBackToTheNeutralValue() {
        RequestImpl request = new RequestImpl(requestWith(Map.of(
                "X-Jhin-Client", "schema=x; api=zzz; version=")));
        assertThat(request.client().schema()).isEqualTo(1);
        assertThat(request.client().api()).isEqualTo(1);
    }

    // the memoized parse returns the same instance on every access
    @Test
    void clientIsMemoizedPerRequest() {
        RequestImpl request = new RequestImpl(requestWith(Map.of(
                "X-Jhin-Client", "schema=7")));
        assertThat(request.client()).isSameAs(request.client());
        assertThat(request.client().schema()).isEqualTo(7);
    }

    /**
     * One in-memory servlet exchange carrying the given headers, built with
     * the same proxy trick the servlet test uses.
     */
    private static HttpServletRequest requestWith(Map<String, String> headers) {
        return (HttpServletRequest) Proxy.newProxyInstance(
                RequestImplClientTest.class.getClassLoader(),
                new Class<?>[] {HttpServletRequest.class},
                (proxy, invoked, args) -> switch (invoked.getName()) {
                    case "getMethod" -> "GET";
                    case "getRequestURI" -> "/probe";
                    case "getContextPath" -> "";
                    case "getQueryString" -> null;
                    case "getHeaderNames" -> Collections.enumeration(
                            headers.keySet().stream().toList());
                    case "getHeader" -> headers.get(args[0]);
                    case "getInputStream" -> emptyStream();
                    case "getRemoteAddr" -> "127.0.0.1";
                    default -> defaultValue(invoked.getReturnType());
                });
    }

    private static InputStream emptyStream() {
        return InputStream.nullInputStream();
    }

    private static Object defaultValue(Class<?> type) {
        if (type == boolean.class) {
            return false;
        }
        if (type == int.class) {
            return 0;
        }
        if (type == long.class) {
            return 0L;
        }
        return null;
    }
}
