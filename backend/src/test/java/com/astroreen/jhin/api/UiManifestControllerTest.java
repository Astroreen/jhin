package com.astroreen.jhin.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.astroreen.jhin.core.accounts.AccountService;
import com.astroreen.jhin.core.accounts.DeviceService;
import com.astroreen.jhin.core.accounts.IssuedDevice;
import com.astroreen.jhin.core.tools.ToolRegistry;
import com.astroreen.jhin.core.tools.spi.ToolCall;
import com.astroreen.jhin.core.tools.spi.ToolContext;
import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import com.astroreen.jhin.core.tools.spi.ToolProvider;
import com.astroreen.jhin.core.tools.spi.ToolResult;
import com.jayway.jsonpath.JsonPath;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

@SpringBootTest
class UiManifestControllerTest {

    private static final List<String> EXPECTED_PRIMITIVES = List.of(
            "container",
            "card",
            "text",
            "button",
            "dropdown",
            "list",
            "drawer",
            "form",
            "chart_line",
            "chart_bar",
            "chart_pie",
            "figure",
            "table",
            "markdown");

    @TempDir
    static Path jhinHome;

    @DynamicPropertySource
    static void jhinHomeProperties(DynamicPropertyRegistry registry) {
        registry.add("jhin.home", jhinHome::toString);
    }

    @Autowired
    private WebApplicationContext context;

    @Autowired
    private FilterChainProxy springSecurityFilterChain;

    @Autowired
    private AccountService accounts;

    @Autowired
    private DeviceService devices;

    @Autowired
    private ToolRegistry toolRegistry;

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders.webAppContextSetup(context)
                .addFilters(springSecurityFilterChain)
                .build();
    }

    @Test
    void anonymousIsUnauthorized() throws Exception {
        mockMvc.perform(get("/ui/manifest"))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentType("application/json"))
                .andExpect(jsonPath("$.error").value("unauthorized"));
    }

    @Test
    void manifestHasExactForm() throws Exception {
        IssuedDevice device = issueDevice("alice");

        MvcResult result = mockMvc.perform(get("/ui/manifest")
                        .header("Authorization", "Bearer " + device.token()))
                .andExpect(status().isOk())
                .andExpect(content().contentType("application/json"))
                .andExpect(jsonPath("$.version").value("0.1.0"))
                .andReturn();

        String body = result.getResponse().getContentAsString();
        Map<String, Object> json = JsonPath.read(body, "$");
        assertThat(json.keySet()).containsExactlyInAnyOrder("tools", "primitives", "version");
        List<Object> primitives = JsonPath.read(body, "$.primitives");
        assertThat(primitives).containsExactlyElementsOf(EXPECTED_PRIMITIVES);

        List<Map<String, Object>> tools = JsonPath.read(body, "$.tools");
        assertThat(tools).isNotEmpty();
        assertThat(tools)
                .allSatisfy(tool -> assertThat(tool.keySet())
                        .containsExactlyInAnyOrder("name", "description"));
        assertThat(tools)
                .extracting(tool -> tool.get("name"))
                .contains("bash", "read")
                .isSorted();
    }

    @Test
    void registeredProviderToolAppearsInManifest() throws Exception {
        IssuedDevice device = issueDevice("alice");
        toolRegistry.register((ToolProvider) () -> List.of(new StubTool("t32-plugin-tool", "fake plugin tool")));

        MvcResult result = mockMvc.perform(get("/ui/manifest")
                        .header("Authorization", "Bearer " + device.token()))
                .andExpect(status().isOk())
                .andReturn();

        List<Map<String, Object>> tools =
                JsonPath.read(result.getResponse().getContentAsString(), "$.tools");
        assertThat(tools).anySatisfy(tool -> {
            assertThat(tool.get("name")).isEqualTo("t32-plugin-tool");
            assertThat(tool.get("description")).isEqualTo("fake plugin tool");
        });
    }

    @Test
    void nullDescriptionIsEmptyString() throws Exception {
        IssuedDevice device = issueDevice("alice");
        toolRegistry.register((ToolProvider) () -> List.of(new StubTool("t32-null-desc", null)));

        MvcResult result = mockMvc.perform(get("/ui/manifest")
                        .header("Authorization", "Bearer " + device.token()))
                .andExpect(status().isOk())
                .andReturn();

        List<Map<String, Object>> tools =
                JsonPath.read(result.getResponse().getContentAsString(), "$.tools");
        assertThat(tools).anySatisfy(tool -> {
            assertThat(tool.get("name")).isEqualTo("t32-null-desc");
            assertThat(tool.get("description")).isEqualTo("");
        });
    }

    private IssuedDevice issueDevice(String name) {
        String accountId = accounts.createAccount(name + "-" + System.nanoTime());
        return devices.issueDevice(accountId, name + "-laptop");
    }

    private static final class StubTool implements ToolDefinition {

        private final String name;
        private final String description;

        StubTool(String name, String description) {
            this.name = name;
            this.description = description;
        }

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
            return description;
        }

        @Override
        public Map<String, Object> parametersSchema() {
            return Map.of("type", "object", "properties", Map.of());
        }

        @Override
        public String promptSnippet() {
            return name;
        }

        @Override
        public List<String> promptGuidelines() {
            return List.of();
        }

        @Override
        public ToolResult execute(ToolCall call, ToolContext ctx) {
            return ToolResult.ok("ok");
        }
    }
}