package com.astroreen.jhin.core.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.core.agent.spi.PluginVetoException;
import com.astroreen.jhin.core.agent.spi.PromptContext;
import com.astroreen.jhin.core.agent.spi.PromptInterceptor;
import com.astroreen.jhin.core.tools.spi.ToolCall;
import com.astroreen.jhin.core.tools.spi.ToolContext;
import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import com.astroreen.jhin.core.tools.spi.ToolResult;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SystemPromptBuilderTest {

    private static final String BASE_MARKER = "You are Jhin, a coding agent";

    @TempDir
    Path workdir;

    private final ToolDefinition alphaStub =
            stub("alpha-stub", "alpha snippet line", List.of("alpha rule one", "alpha rule two"));
    private final ToolDefinition bashStub = stub("bash-stub", "bash snippet line", List.of("bash rule"));

    @Test
    void basePromptContentIsIncluded() throws Exception {
        PromptContext ctx = builder().build(workdir.toString(), "s1", "r1", List.of());

        assertThat(ctx.systemPrompt()).contains(BASE_MARKER);
        assertThat(ctx.workdir()).isEqualTo(workdir.toString());
        assertThat(ctx.sessionId()).isEqualTo("s1");
        assertThat(ctx.runId()).isEqualTo("r1");
    }

    @Test
    void toolSectionsIncludeSnippetAndGuidelinesSortedByName() throws Exception {
        PromptContext ctx = builder().build(workdir.toString(), "s1", "r1", List.of(bashStub, alphaStub));

        String text = ctx.systemPrompt();
        assertThat(text)
                .contains("## alpha-stub\nalpha snippet line\nGuidelines:\n- alpha rule one\n- alpha rule two")
                .contains("## bash-stub\nbash snippet line\nGuidelines:\n- bash rule");
        assertThat(text.indexOf("## alpha-stub")).isLessThan(text.indexOf("## bash-stub"));
    }

    @Test
    void guidelinesBlockSkippedWhenEmpty() throws Exception {
        PromptContext ctx =
                builder()
                        .build(
                                workdir.toString(),
                                "s1",
                                "r1",
                                List.of(stub("bare-stub", "bare snippet", List.of())));

        assertThat(ctx.systemPrompt()).contains("## bare-stub\nbare snippet");
        assertThat(ctx.systemPrompt()).doesNotContain("Guidelines:");
    }

    @Test
    void projectInstructionsIncludedWhenAgentsMdPresent() throws Exception {
        Files.writeString(workdir.resolve("AGENTS.md"), "# project\nAlways do X.\n");

        PromptContext ctx = builder().build(workdir.toString(), "s1", "r1", List.of());

        assertThat(ctx.systemPrompt())
                .contains("## Project Instructions (AGENTS.md)")
                .contains("Always do X.");
    }

    @Test
    void projectInstructionsSkippedWhenAbsent() throws Exception {
        PromptContext ctx = builder().build(workdir.toString(), "s1", "r1", List.of());

        assertThat(ctx.systemPrompt()).doesNotContain("Project Instructions");
    }

    @Test
    void oversizedAgentsMdTruncatedAtLineBoundary() throws IOException, PluginVetoException {
        StringBuilder big = new StringBuilder();
        for (int i = 0; i < 3000; i++) {
            big.append("line ").append(i).append(' ').append("y".repeat(50)).append('\n');
        }
        Files.writeString(workdir.resolve("AGENTS.md"), big.toString());

        PromptContext ctx = builder().build(workdir.toString(), "s1", "r1", List.of());

        assertThat(ctx.systemPrompt())
                .contains("\n... [truncated]")
                .endsWith("\n... [truncated]")
                .doesNotContain("line 2999");
    }

    @Test
    void interceptorCanRewriteSystemPrompt() throws Exception {
        PromptInterceptor rewriter = ctx -> ctx.withSystemPrompt(ctx.systemPrompt() + "\n[REWRITTEN]");

        PromptContext ctx =
                new SystemPromptBuilder(List.of(rewriter)).build(workdir.toString(), "s1", "r1", List.of());

        assertThat(ctx.systemPrompt()).contains("[REWRITTEN]").endsWith("[REWRITTEN]");
    }

    @Test
    void interceptorVetoPropagatesWithReason() {
        PromptInterceptor vetoing =
                ctx -> {
                    throw new PluginVetoException("nope");
                };

        assertThatThrownBy(
                        () ->
                                new SystemPromptBuilder(List.of(vetoing))
                                        .build(workdir.toString(), "s1", "r1", List.of()))
                .isInstanceOfSatisfying(
                        PluginVetoException.class, ex -> assertThat(ex.getReason()).isEqualTo("nope"));
    }

    @Test
    void interceptorsAppliedInListOrder() throws Exception {
        PromptInterceptor first = ctx -> ctx.withSystemPrompt(ctx.systemPrompt() + "[A]");
        PromptInterceptor second = ctx -> ctx.withSystemPrompt(ctx.systemPrompt() + "[B]");

        PromptContext ctx =
                new SystemPromptBuilder(List.of(first, second))
                        .build(workdir.toString(), "s1", "r1", List.of());

        assertThat(ctx.systemPrompt()).contains("[A][B]").endsWith("[B]");
    }

    @Test
    void nullReturningInterceptorIsVeto() {
        PromptInterceptor broken = ctx -> null;

        assertThatThrownBy(
                        () ->
                                new SystemPromptBuilder(List.of(broken))
                                        .build(workdir.toString(), "s1", "r1", List.of()))
                .isInstanceOf(PluginVetoException.class)
                .hasMessage("interceptor returned null");
    }

    private SystemPromptBuilder builder() {
        return new SystemPromptBuilder(List.of());
    }

    private static ToolDefinition stub(String name, String snippet, List<String> guidelines) {
        return new ToolDefinition() {
            @Override
            public String name() {
                return name;
            }

            @Override
            public String label() {
                return name;
            }

            @Override
            public String description() {
                return "";
            }

            @Override
            public Map<String, Object> parametersSchema() {
                return Map.of();
            }

            @Override
            public String promptSnippet() {
                return snippet;
            }

            @Override
            public List<String> promptGuidelines() {
                return guidelines;
            }

            @Override
            public ToolResult execute(ToolCall call, ToolContext ctx) {
                throw new UnsupportedOperationException("stub tool");
            }
        };
    }
}
