package com.astroreen.jhin.core.tools;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.core.tools.spi.ToolCall;
import com.astroreen.jhin.core.tools.spi.ToolCallDecision;
import com.astroreen.jhin.core.tools.spi.ToolCallGuard;
import com.astroreen.jhin.core.tools.spi.ToolContext;
import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import com.astroreen.jhin.core.tools.spi.ToolException;
import com.astroreen.jhin.core.tools.spi.ToolProvider;
import com.astroreen.jhin.core.tools.spi.ToolResult;
import com.astroreen.jhin.core.tools.spi.ToolResultTransformer;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ToolRegistryTest {

    @TempDir
    Path workdir;

    private final StubTool alpha = new StubTool("alpha");
    private final StubTool beta = new StubTool("beta");
    private final List<String> guardOrder = new ArrayList<>();

    @Test
    void allAndFindBookkeeping() {
        ToolRegistry registry = registry(List.of(), List.of());

        assertThat(registry.all()).extracting(ToolDefinition::name).containsExactly("alpha", "beta");
        assertThat(registry.find("alpha")).containsSame(alpha);
        assertThat(registry.find("beta")).containsSame(beta);
        assertThat(registry.find("missing")).isEmpty();
    }

    @Test
    void unknownToolReturnsError() {
        ToolRegistry registry = registry(List.of(), List.of());

        ToolResult result = registry.execute("nope", Map.of(), ctx());

        assertThat(result.error()).isTrue();
        assertThat(result.content()).isEqualTo("Unknown tool: nope");
        assertThat(alpha.calls).isEmpty();
    }

    @Test
    void firstBlockShortCircuitsWithoutExecution() {
        ToolCallGuard blocking =
                call -> {
                    guardOrder.add("blocking");
                    return ToolCallDecision.block("denied by policy");
                };
        ToolCallGuard neverCalled =
                call -> {
                    guardOrder.add("never");
                    return ToolCallDecision.allow();
                };
        ToolRegistry registry = registry(List.of(blocking, neverCalled), List.of());

        ToolResult result = registry.execute("alpha", Map.of("x", 1), ctx());

        assertThat(result.error()).isTrue();
        assertThat(result.content()).isEqualTo("Blocked: denied by policy");
        assertThat(alpha.calls).isEmpty();
        assertThat(guardOrder).containsExactly("blocking");
    }

    @Test
    void allGuardsConsultedInOrderWhenAllowing() {
        ToolCallGuard first =
                call -> {
                    guardOrder.add("first");
                    return ToolCallDecision.allow();
                };
        ToolCallGuard second =
                call -> {
                    guardOrder.add("second");
                    return ToolCallDecision.allow();
                };
        ToolRegistry registry = registry(List.of(first, second), List.of());

        ToolResult result = registry.execute("alpha", Map.of(), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content()).isEqualTo("result-of-alpha");
        assertThat(guardOrder).containsExactly("first", "second");
        assertThat(alpha.calls).hasSize(1);
    }

    @Test
    void guardExceptionYieldsErrorWithoutExecution() {
        ToolCallGuard broken =
                call -> {
                    throw new IllegalStateException("guard boom");
                };
        ToolRegistry registry = registry(List.of(broken), List.of());

        ToolResult result = registry.execute("alpha", Map.of(), ctx());

        assertThat(result.error()).isTrue();
        assertThat(result.content()).contains("guard boom");
        assertThat(alpha.calls).isEmpty();
    }

    @Test
    void toolExceptionBecomesErrorResult() {
        alpha.failure = new ToolException("tool broke");
        ToolRegistry registry = registry(List.of(), List.of());

        ToolResult result = registry.execute("alpha", Map.of(), ctx());

        assertThat(result.error()).isTrue();
        assertThat(result.content()).isEqualTo("tool broke");
    }

    @Test
    void transformersAppliedInOrder() {
        ToolResultTransformer t1 = r -> append(r, "1");
        ToolResultTransformer t2 = r -> append(r, "2");
        ToolRegistry registry = registry(List.of(), List.of(t1, t2));

        ToolResult result = registry.execute("alpha", Map.of(), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content()).isEqualTo("result-of-alpha12");
    }

    @Test
    void throwingTransformerIsSkippedOthersStillApplied() {
        ToolResultTransformer t1 = r -> append(r, "1");
        ToolResultTransformer t2 =
                r -> {
                    throw new IllegalStateException("transformer boom");
                };
        ToolResultTransformer t3 = r -> append(r, "3");
        ToolRegistry registry = registry(List.of(), List.of(t1, t2, t3));

        ToolResult result = registry.execute("alpha", Map.of(), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content()).isEqualTo("result-of-alpha13");
    }

    @Test
    void registerSeamWorksAndFirstToolNameWins() {
        ToolRegistry registry = new ToolRegistry(List.of(), List.of(), List.of());
        assertThat(registry.find("gamma")).isEmpty();

        StubTool first = new StubTool("gamma");
        registry.register(provider(first));
        assertThat(registry.find("gamma")).containsSame(first);

        StubTool second = new StubTool("gamma");
        registry.register(provider(second));
        assertThat(registry.find("gamma")).containsSame(first);
        assertThat(registry.all()).extracting(ToolDefinition::name).containsExactly("gamma");
    }

    private ToolRegistry registry(List<ToolCallGuard> guards, List<ToolResultTransformer> transformers) {
        return new ToolRegistry(List.of(provider(alpha, beta)), guards, transformers);
    }

    private ToolContext ctx() {
        return new ToolContext(workdir, "session-1", "run-1", null);
    }

    private static ToolProvider provider(ToolDefinition... defs) {
        return () -> List.of(defs);
    }

    private static ToolResult append(ToolResult r, String suffix) {
        return new ToolResult(r.content() + suffix, r.error(), r.truncated(), r.structured(), r.meta());
    }

    private static final class StubTool implements ToolDefinition {

        private final String name;
        final List<ToolCall> calls = new ArrayList<>();
        RuntimeException failure;

        StubTool(String name) {
            this.name = name;
        }

        @Override
        public String name() {
            return name;
        }

        @Override
        public String label() {
            return "stub " + name;
        }

        @Override
        public String description() {
            return "stub tool " + name;
        }

        @Override
        public Map<String, Object> parametersSchema() {
            return Map.of("type", "object", "properties", Map.of());
        }

        @Override
        public String promptSnippet() {
            return "use " + name;
        }

        @Override
        public List<String> promptGuidelines() {
            return List.of("guideline for " + name);
        }

        @Override
        public ToolResult execute(ToolCall call, ToolContext ctx) {
            calls.add(call);
            if (failure != null) {
                throw failure;
            }
            return ToolResult.ok("result-of-" + name);
        }
    }
}
