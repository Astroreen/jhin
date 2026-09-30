package com.astroreen.jhin.kernel.http;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.sdk.http.ClientInfo;
import com.astroreen.jhin.sdk.http.FilterSpec;
import com.astroreen.jhin.sdk.http.HttpFilter;
import com.astroreen.jhin.sdk.http.HttpHandler;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;

class FilterPipelineTest {

    private static final class TestRequest implements HttpRequest {

        private final String method;
        private final String path;
        private final Map<String, Object> attributes = new LinkedHashMap<>();

        TestRequest(String method, String path) {
            this.method = method;
            this.path = path;
        }

        @Override
        public String method() {
            return method;
        }

        @Override
        public String path() {
            return path;
        }

        @Override
        public Map<String, String> pathParams() {
            return Map.of();
        }

        @Override
        public Map<String, List<String>> query() {
            return Map.of();
        }

        @Override
        public Map<String, String> headers() {
            return Map.of();
        }

        @Override
        public byte[] body() {
            return new byte[0];
        }

        @Override
        public String bodyAsString() {
            return "";
        }

        @Override
        public <T> T bodyAs(Class<T> type) {
            throw new UnsupportedOperationException();
        }

        @Override
        public String remoteAddr() {
            return "test";
        }

        @Override
        public ClientInfo client() {
            return ClientInfo.UNKNOWN;
        }

        @Override
        public Optional<Object> attribute(String key) {
            return Optional.ofNullable(attributes.get(key));
        }

        @Override
        public void setAttribute(String key, Object value) {
            attributes.put(key, value);
        }
    }

    private final List<String> invocations = new ArrayList<>();
    private final FilterPipeline pipeline = new FilterPipeline();

    private HttpHandler terminal(String responseText) {
        return req -> {
            invocations.add("handler");
            return HttpResponse.text(200, responseText);
        };
    }

    private HttpFilter recording(String name, boolean shortCircuit, String responseText) {
        return (req, chain) -> {
            invocations.add(name);
            if (shortCircuit) {
                return HttpResponse.text(200, responseText);
            }
            return chain.proceed(req);
        };
    }

    @Test
    void runsFiltersInOrderThenTerminalHandler() throws Exception {
        pipeline.add(new FilterSpec("third", "/", 3, recording("f3", false, "unused")), "demo.c");
        pipeline.add(new FilterSpec("first", "/", 1, recording("f1", false, "unused")), "demo.a");
        pipeline.add(new FilterSpec("second", "/", 2, recording("f2", false, "unused")), "demo.b");

        HttpResponse res = pipeline.execute(new TestRequest("GET", "/x"), terminal("from-handler"));

        assertThat(invocations).containsExactly("f1", "f2", "f3", "handler");
        assertThat(res.status()).isEqualTo(200);
        assertThat(new String(res.body())).isEqualTo("from-handler");
    }

    @Test
    void shortCircuitStopsChainAndHandlerNeverRuns() throws Exception {
        pipeline.add(new FilterSpec("first", "/", 1, recording("f1", false, "unused")), "demo.a");
        pipeline.add(new FilterSpec("second", "/", 2, recording("f2", true, "from-f2")), "demo.b");
        pipeline.add(new FilterSpec("third", "/", 3, recording("f3", false, "unused")), "demo.c");

        HttpResponse res = pipeline.execute(new TestRequest("GET", "/x"), terminal("from-handler"));

        assertThat(invocations).containsExactly("f1", "f2");
        assertThat(invocations).doesNotContain("f3", "handler");
        assertThat(res.status()).isEqualTo(200);
        assertThat(new String(res.body())).isEqualTo("from-f2");
    }

    @Test
    void pathPrefixSelectsMatchingFiltersOnly() throws Exception {
        pipeline.add(new FilterSpec("all", "/", 1, recording("all", false, "unused")), "demo.a");
        pipeline.add(new FilterSpec("admin", "/admin", 2, recording("admin", false, "unused")),
                "demo.b");
        pipeline.add(new FilterSpec("other", "/other", 3, recording("other", false, "unused")),
                "demo.c");

        pipeline.execute(new TestRequest("GET", "/admin/x"), terminal("from-handler"));

        assertThat(invocations).containsExactly("all", "admin", "handler");
    }

    @Test
    void orderTiesBreakByPluginId() throws Exception {
        pipeline.add(new FilterSpec("late-plugin", "/", 1, recording("late", false, "unused")),
                "demo.b");
        pipeline.add(new FilterSpec("early-plugin", "/", 1, recording("early", false, "unused")),
                "demo.a");

        pipeline.execute(new TestRequest("GET", "/x"), terminal("from-handler"));

        assertThat(invocations).containsExactly("early", "late", "handler");
    }
}
