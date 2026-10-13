package com.astroreen.jhin.plugin.toolsbuiltin;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.agent.api.ToolDefinition;
import com.astroreen.jhin.plugin.toolsbuiltin.api.QuestionBridge;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Registration-condition tests of the {@code powershell} tool: present only
 * when {@code os.name} starts with {@code Windows}, absent on this machine's
 * real os name (Linux CI), with the predicate asserted directly.
 */
class ToolsRegistrationTest {

    private final QuestionBridge bridge = new QuestionBridgeImpl();

    @Test
    void linuxOsNameRegistersNineToolsWithoutPowershell() {
        List<ToolDefinition> tools = ToolsPlugin.buildTools("Linux 6.8.0", bridge);

        assertThat(ToolsPlugin.toolNames(tools))
                .containsExactly("ls", "write", "read", "edit", "edit-diff", "find", "grep", "bash", "ask_user")
                .doesNotContain("powershell");
    }

    @Test
    void windowsOsNameRegistersTenToolsWithPowershell() {
        List<ToolDefinition> tools = ToolsPlugin.buildTools("Windows 11", bridge);

        assertThat(ToolsPlugin.toolNames(tools))
                .containsExactly(
                        "ls", "write", "read", "edit", "edit-diff", "find", "grep", "bash", "ask_user", "powershell");
    }

    @Test
    void isWindowsPredicate() {
        assertThat(ToolsPlugin.isWindows("Windows 11")).isTrue();
        assertThat(ToolsPlugin.isWindows("Windows Server 2022")).isTrue();
        assertThat(ToolsPlugin.isWindows("Linux")).isFalse();
        assertThat(ToolsPlugin.isWindows("Mac OS X")).isFalse();
        assertThat(ToolsPlugin.isWindows("")).isFalse();
    }

    @Test
    void currentHostRegistrationMatchesOsName() {
        String osName = System.getProperty("os.name", "");
        List<ToolDefinition> tools = ToolsPlugin.buildTools(osName, bridge);

        if (ToolsPlugin.isWindows(osName)) {
            assertThat(ToolsPlugin.toolNames(tools)).hasSize(10).endsWith("powershell");
        } else {
            assertThat(ToolsPlugin.toolNames(tools)).hasSize(9).doesNotContain("powershell");
        }
    }
}
