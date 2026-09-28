package com.astroreen.jhin.core.tools.impl;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.core.tools.ToolRegistry;
import com.astroreen.jhin.core.tools.spi.ToolCall;
import com.astroreen.jhin.core.tools.spi.ToolContext;
import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import com.astroreen.jhin.core.tools.spi.ToolResult;
import com.astroreen.jhin.core.tools.spi.ToolUpdate;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;

class PowerShellToolTest {

    @TempDir
    Path workdir;

    private final PowerShellTool tool = new PowerShellTool();
    private final List<ToolUpdate> updates = Collections.synchronizedList(new ArrayList<>());

    @Test
    @DisabledOnOs(OS.WINDOWS)
    void conditionDoesNotMatchOnNonWindows() {
        assertThat(OnWindowsCondition.isWindows()).isFalse();
        assertThat(new OnWindowsCondition().matches(null, null)).isFalse();
    }

    @Test
    @DisabledOnOs(OS.WINDOWS)
    void toolAbsentFromDefaultWiringOnNonWindows() {
        try (AnnotationConfigApplicationContext spring =
                new AnnotationConfigApplicationContext(PowerShellToolConfig.class)) {
            List<ToolDefinition> beans = List.copyOf(spring.getBeansOfType(ToolDefinition.class).values());
            ToolRegistry registry =
                    new ToolRegistry(List.of(new BuiltinToolsProvider(beans)), List.of(), List.of());
            assertThat(registry.find("powershell")).isEmpty();
        }
    }

    @Test
    @EnabledOnOs(OS.WINDOWS)
    void registersOnWindowsAndRunsEcho() {
        try (AnnotationConfigApplicationContext spring =
                new AnnotationConfigApplicationContext(PowerShellToolConfig.class)) {
            List<ToolDefinition> beans = List.copyOf(spring.getBeansOfType(ToolDefinition.class).values());
            ToolRegistry registry =
                    new ToolRegistry(List.of(new BuiltinToolsProvider(beans)), List.of(), List.of());
            assertThat(registry.find("powershell")).isPresent();
        }

        ToolResult result = tool.execute(call("command", "echo hi"), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content()).contains("hi");
        assertThat(result.meta()).containsEntry("exitCode", 0);
        assertThat(result.meta()).containsEntry("timedOut", false);
        assertThat(updates)
                .anyMatch(
                        u ->
                                "powershell".equals(u.toolName())
                                        && u.streaming()
                                        && u.chunk().contains("hi"));
    }

    @SuppressWarnings("unchecked")
    @Test
    void schemaAndMetadata() {
        assertThat(tool.name()).isEqualTo("powershell");
        assertThat(tool.label()).isEqualTo("PowerShell");
        Map<String, Object> schema = tool.parametersSchema();
        assertThat(schema).containsEntry("required", List.of("command"));
        Map<String, Object> properties = (Map<String, Object>) schema.get("properties");
        assertThat(properties).containsKeys("command", "timeout");
    }

    @Test
    void argumentValidationWithoutSpawn() {
        assertThat(tool.execute(call("command", ""), ctx()).error()).isTrue();
        assertThat(tool.execute(call("command", "   "), ctx()).error()).isTrue();
        assertThat(tool.execute(call(), ctx()).error()).isTrue();
        assertThat(tool.execute(call("command", "echo hi", "timeout", 0), ctx()).error()).isTrue();
        assertThat(tool.execute(call("command", "echo hi", "timeout", "x"), ctx()).error()).isTrue();
    }

    private ToolContext ctx() {
        ToolContext ctx = new ToolContext(workdir, "s1", "r1", "a1");
        ctx.setOnUpdate(updates::add);
        return ctx;
    }

    private static ToolCall call(Object... kv) {
        Map<String, Object> args = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            args.put((String) kv[i], kv[i + 1]);
        }
        return new ToolCall("powershell", args, "c1");
    }
}
