package com.astroreen.jhin.kernel.http;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.kernel.KernelRoutes;
import com.astroreen.jhin.sdk.http.FilterSpec;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.http.RouteSpec;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.WriteListener;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class JhinServletTest {

    @Test
    void matchedRouteRunsThroughThePipeline() throws Exception {
        HttpRegistryImpl registry = new HttpRegistryImpl();
        registry.route(new RouteSpec("GET", "/x", request -> HttpResponse.text(200, "ok")));
        registry.filter(new FilterSpec("tag", "/", 0, (request, chain) -> chain.proceed(request)
                .withHeader("x-tag", "ran")));
        Exchange exchange = new Exchange();
        new JhinServlet(registry, null).service(exchange.request("GET", "/x"), exchange.response());
        assertThat(exchange.status).isEqualTo(200);
        assertThat(exchange.text()).isEqualTo("ok");
        assertThat(exchange.headers).containsEntry("x-tag", "ran");
    }

    @Test
    void unmatchedPathAnswersNotFound() throws Exception {
        HttpRegistryImpl registry = new HttpRegistryImpl();
        KernelRoutes.install(registry);
        Exchange exchange = new Exchange();
        new JhinServlet(registry, null).service(exchange.request("GET", "/nope"), exchange.response());
        assertThat(exchange.status).isEqualTo(404);
        assertThat(exchange.text()).isEqualTo(
                "{\"error\":\"not_found\",\"message\":\"no plugin serves GET /nope\"}");
    }

    @Test
    void wrongMethodOnKnownPathAnswersMethodNotAllowed() throws Exception {
        HttpRegistryImpl registry = new HttpRegistryImpl();
        registry.route(new RouteSpec("GET", "/x", request -> HttpResponse.text(200, "ok")));
        Exchange exchange = new Exchange();
        new JhinServlet(registry, null).service(exchange.request("POST", "/x"), exchange.response());
        assertThat(exchange.status).isEqualTo(405);
        assertThat(exchange.text()).contains("\"error\":\"method_not_allowed\"");
    }

    @Test
    void uncaughtFailureAnswersInternalWithoutTheStack() throws Exception {
        HttpRegistryImpl registry = new HttpRegistryImpl();
        registry.route(new RouteSpec("GET", "/x", request -> HttpResponse.text(200, "ok")));
        registry.filter(new FilterSpec("boom", "/", 0, (request, chain) -> {
            throw new IllegalStateException("boom-detail");
        }));
        Exchange exchange = new Exchange();
        new JhinServlet(registry, null).service(exchange.request("GET", "/x"), exchange.response());
        assertThat(exchange.status).isEqualTo(500);
        assertThat(exchange.text()).isEqualTo(
                "{\"error\":\"internal\",\"message\":\"java.lang.IllegalStateException\"}");
    }

    @Test
    void optionsIsAnsweredBeforeAnyFilter() throws Exception {
        HttpRegistryImpl registry = new HttpRegistryImpl();
        registry.route(new RouteSpec("GET", "/x", request -> HttpResponse.text(200, "ok")));
        registry.filter(new FilterSpec("blocker", "/", 0, (request, chain) ->
                HttpResponse.error(401, "blocked", "blocked")));
        Exchange exchange = new Exchange();
        new JhinServlet(registry, null).service(exchange.request("OPTIONS", "/x"), exchange.response());
        assertThat(exchange.status).isEqualTo(204);
        assertThat(exchange.text()).isEmpty();
        assertThat(exchange.headers)
                .containsEntry("access-control-allow-origin", "*")
                .containsEntry("access-control-allow-headers", "*")
                .containsEntry("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
    }

    @Test
    void streamedAnswerWithoutStreamLayerAnswersInternal() throws Exception {
        HttpRegistryImpl registry = new HttpRegistryImpl();
        registry.route(new RouteSpec("GET", "/x", request -> new HttpResponse(200, Map.of(),
                new byte[0], "marker")));
        Exchange exchange = new Exchange();
        new JhinServlet(registry, null).service(exchange.request("GET", "/x"), exchange.response());
        assertThat(exchange.status).isEqualTo(500);
        assertThat(exchange.text()).contains("\"error\":\"internal\"");
    }

    /** One in-memory request and response pair with its recorded outcome. */
    private static final class Exchange {

        private int status;
        private final Map<String, String> headers = new LinkedHashMap<>();
        private final ByteArrayOutputStream body = new ByteArrayOutputStream();

        HttpServletRequest request(String method, String uri) {
            return (HttpServletRequest) Proxy.newProxyInstance(
                    getClass().getClassLoader(), new Class<?>[] {HttpServletRequest.class},
                    (proxy, invoked, args) -> switch (invoked.getName()) {
                        case "getMethod" -> method;
                        case "getRequestURI" -> uri;
                        case "getContextPath" -> "";
                        case "getHeaderNames" -> Collections.enumeration(List.of());
                        case "getInputStream" -> emptyStream();
                        case "getRemoteAddr" -> "127.0.0.1";
                        default -> defaultValue(invoked.getReturnType());
                    });
        }

        HttpServletResponse response() {
            return (HttpServletResponse) Proxy.newProxyInstance(
                    getClass().getClassLoader(), new Class<?>[] {HttpServletResponse.class},
                    (proxy, invoked, args) -> switch (invoked.getName()) {
                        case "setStatus" -> {
                            status = (Integer) args[0];
                            yield null;
                        }
                        case "setHeader" -> {
                            headers.put((String) args[0], (String) args[1]);
                            yield null;
                        }
                        case "getOutputStream" -> sink();
                        default -> defaultValue(invoked.getReturnType());
                    });
        }

        String text() {
            return body.toString(StandardCharsets.UTF_8);
        }

        private ServletInputStream emptyStream() {
            return new ServletInputStream() {

                @Override
                public boolean isFinished() {
                    return true;
                }

                @Override
                public boolean isReady() {
                    return true;
                }

                @Override
                public void setReadListener(ReadListener readListener) {
                }

                @Override
                public int read() {
                    return -1;
                }
            };
        }

        private jakarta.servlet.ServletOutputStream sink() {
            return new jakarta.servlet.ServletOutputStream() {

                @Override
                public boolean isReady() {
                    return true;
                }

                @Override
                public void setWriteListener(WriteListener writeListener) {
                }

                @Override
                public void write(int b) {
                    body.write(b);
                }
            };
        }

        private static Object defaultValue(Class<?> type) {
            if (!type.isPrimitive()) {
                return null;
            }
            if (type == boolean.class) {
                return false;
            }
            if (type == void.class) {
                return null;
            }
            return 0;
        }
    }
}
