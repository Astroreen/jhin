package com.astroreen.jhin.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.astroreen.jhin.core.accounts.AccountService;
import com.astroreen.jhin.core.accounts.DeviceService;
import com.astroreen.jhin.core.accounts.IssuedDevice;
import com.jayway.jsonpath.JsonPath;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

@SpringBootTest
class ProviderControllerTest {

    private static final String API_KEY = "sk-test-secret-value";

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

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders.webAppContextSetup(context)
                .addFilters(springSecurityFilterChain)
                .build();
    }

    @Test
    void anonymousListIsUnauthorized() throws Exception {
        mockMvc.perform(get("/providers"))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentType("application/json"))
                .andExpect(jsonPath("$.error").value("unauthorized"));
    }

    @Test
    void createWithoutApiKeyInBodyAndListed() throws Exception {
        IssuedDevice device = issueDevice("alice");

        MvcResult created = mockMvc.perform(post("/providers")
                        .header("Authorization", "Bearer " + device.token())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"work\",\"format\":\"openai\",\"apiKey\":\"" + API_KEY
                                + "\",\"model\":\"gpt-x\",\"baseUrl\":\"https://api.example.com/v1\",\"isDefault\":true}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.name").value("work"))
                .andExpect(jsonPath("$.format").value("openai"))
                .andExpect(jsonPath("$.model").value("gpt-x"))
                .andExpect(jsonPath("$.baseUrl").value("https://api.example.com/v1"))
                .andExpect(jsonPath("$.isDefault").value(true))
                .andReturn();

        String createdBody = created.getResponse().getContentAsString();
        Map<String, Object> createdJson = JsonPath.read(createdBody, "$");
        assertThat(createdJson).doesNotContainKey("apiKey").doesNotContainKey("api_key");
        assertThat(createdBody).doesNotContain(API_KEY);
        String createdId = JsonPath.read(createdBody, "$.id");

        MvcResult list = mockMvc.perform(get("/providers")
                        .header("Authorization", "Bearer " + device.token()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].id").value(createdId))
                .andExpect(jsonPath("$[0].name").value("work"))
                .andReturn();

        String listBody = list.getResponse().getContentAsString();
        assertThat(JsonPath.<Map<String, Object>>read(listBody, "$[0]"))
                .doesNotContainKey("apiKey")
                .doesNotContainKey("api_key");
        assertThat(listBody).doesNotContain(API_KEY);
    }

    @Test
    void createWithUnknownFormatIsUnknownFormat() throws Exception {
        IssuedDevice device = issueDevice("alice");

        mockMvc.perform(post("/providers")
                        .header("Authorization", "Bearer " + device.token())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"work\",\"format\":\"bogus\",\"apiKey\":\"" + API_KEY
                                + "\",\"model\":\"m\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("unknown_format"));
    }

    @Test
    void deleteForeignProviderIsNotFoundOwnIsNoContent() throws Exception {
        IssuedDevice alice = issueDevice("alice");
        IssuedDevice bob = issueDevice("bob");

        MvcResult created = mockMvc.perform(post("/providers")
                        .header("Authorization", "Bearer " + alice.token())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"work\",\"format\":\"openai\",\"apiKey\":\"" + API_KEY
                                + "\",\"model\":\"m\"}"))
                .andExpect(status().isCreated())
                .andReturn();
        String createdId = JsonPath.read(created.getResponse().getContentAsString(), "$.id");

        mockMvc.perform(delete("/providers/" + createdId)
                        .header("Authorization", "Bearer " + bob.token()))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error").value("not_found"));

        mockMvc.perform(delete("/providers/" + createdId)
                        .header("Authorization", "Bearer " + alice.token()))
                .andExpect(status().isNoContent());

        mockMvc.perform(get("/providers/" + createdId)
                        .header("Authorization", "Bearer " + alice.token()))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error").value("not_found"));
    }

    @Test
    void blankFieldsAndMalformedJsonAreBadRequest() throws Exception {
        IssuedDevice device = issueDevice("alice");
        String auth = "Bearer " + device.token();

        mockMvc.perform(post("/providers")
                        .header("Authorization", auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"\",\"format\":\"openai\",\"apiKey\":\"" + API_KEY
                                + "\",\"model\":\"m\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("bad_request"));

        mockMvc.perform(post("/providers")
                        .header("Authorization", auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"work\",\"format\":\"openai\",\"apiKey\":\"\",\"model\":\"m\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("bad_request"));

        mockMvc.perform(post("/providers")
                        .header("Authorization", auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"work\",\"format\":\"openai\",\"apiKey\":\"" + API_KEY
                                + "\",\"model\":\" \"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("bad_request"));

        mockMvc.perform(post("/providers")
                        .header("Authorization", auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("bad_request"));
    }

    private IssuedDevice issueDevice(String name) {
        String accountId = accounts.createAccount(name + "-" + System.nanoTime());
        return devices.issueDevice(accountId, name + "-laptop");
    }
}
