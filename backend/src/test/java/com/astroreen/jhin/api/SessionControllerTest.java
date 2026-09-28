package com.astroreen.jhin.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.astroreen.jhin.core.accounts.AccountService;
import com.astroreen.jhin.core.accounts.DeviceService;
import com.astroreen.jhin.core.accounts.IssuedDevice;
import com.astroreen.jhin.core.db.WriteQueue;
import com.astroreen.jhin.core.events.Event;
import com.astroreen.jhin.core.events.EventLogService;
import com.astroreen.jhin.core.events.EventTypes;
import com.astroreen.jhin.core.llm.ProviderRegistry;
import com.jayway.jsonpath.JsonPath;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

@SpringBootTest
class SessionControllerTest {

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
    private ProviderRegistry providers;

    @Autowired
    private EventLogService eventLog;

    @Autowired
    private WriteQueue writeQueue;

    @Autowired
    private JdbcClient jdbc;

    private MockMvc mockMvc;
    private IssuedDevice alice;
    private IssuedDevice bob;
    private String aliceAuth;
    private String bobAuth;

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders.webAppContextSetup(context)
                .addFilters(springSecurityFilterChain)
                .build();
        alice = issueDevice("alice");
        bob = issueDevice("bob");
        aliceAuth = "Bearer " + alice.token();
        bobAuth = "Bearer " + bob.token();
    }

    @Test
    void listContainsOnlyOwnSessions() throws Exception {
        String mine = createSession(aliceAuth, "mine", "/w/a");
        String theirs = createSession(bobAuth, "theirs", "/w/b");

        MvcResult result = mockMvc.perform(get("/sessions").header("Authorization", aliceAuth))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].id").value(mine))
                .andExpect(jsonPath("$[0].title").value("mine"))
                .andExpect(jsonPath("$[0].workdir").value("/w/a"))
                .andExpect(jsonPath("$[0].createdAt").isString())
                .andExpect(jsonPath("$[0].updatedAt").isString())
                .andReturn();

        List<String> ids = JsonPath.read(result.getResponse().getContentAsString(), "$[*].id");
        assertThat(ids).contains(mine).doesNotContain(theirs);
    }

    @Test
    void foreignSessionIsNotFoundForGetPatchDelete() throws Exception {
        String id = createSession(aliceAuth, "private", "/w/a");

        mockMvc.perform(get("/sessions/" + id).header("Authorization", bobAuth))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error").value("not_found"));

        mockMvc.perform(patch("/sessions/" + id)
                        .header("Authorization", bobAuth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"steal\"}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error").value("not_found"));

        mockMvc.perform(delete("/sessions/" + id).header("Authorization", bobAuth))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error").value("not_found"));

        mockMvc.perform(get("/sessions/" + id).header("Authorization", aliceAuth))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("private"));
    }

    @Test
    void patchUpdatesOnlyExplicitFields() throws Exception {
        String id = createSession(aliceAuth, "old-title", "/w/a");

        mockMvc.perform(patch("/sessions/" + id)
                        .header("Authorization", aliceAuth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"new-title\",\"model\":\"m1\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(id))
                .andExpect(jsonPath("$.title").value("new-title"))
                .andExpect(jsonPath("$.model").value("m1"))
                .andExpect(jsonPath("$.workdir").value("/w/a"));

        mockMvc.perform(patch("/sessions/" + id)
                        .header("Authorization", aliceAuth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"model\":\"m2\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("new-title"))
                .andExpect(jsonPath("$.model").value("m2"));

        mockMvc.perform(patch("/sessions/" + id)
                        .header("Authorization", aliceAuth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("bad_request"));

        String foreignProviderId = providers
                .create(bob.accountId(), "bob-prov", "openai", "sk-bob", "m", null, false)
                .join()
                .id();
        mockMvc.perform(patch("/sessions/" + id)
                        .header("Authorization", aliceAuth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"providerId\":\"" + foreignProviderId + "\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("bad_request"));
    }

    @Test
    void sendMessageReturnsRunIdOnOwnSession() throws Exception {
        String id = createSession(aliceAuth, "chat", "/w/a");

        MvcResult result = mockMvc.perform(post("/sessions/" + id + "/messages")
                        .header("Authorization", aliceAuth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"text\":\"hello\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.runId").isString())
                .andReturn();

        String runId = JsonPath.read(result.getResponse().getContentAsString(), "$.runId");
        assertThat(runId).matches("[0-9a-f-]{36}");
    }

    @Test
    void sendMessageToForeignSessionIsNotFoundAndBlankTextIsBadRequest() throws Exception {
        String id = createSession(aliceAuth, "chat", "/w/a");

        mockMvc.perform(post("/sessions/" + id + "/messages")
                        .header("Authorization", bobAuth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"text\":\"hello\"}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error").value("not_found"));

        mockMvc.perform(post("/sessions/" + id + "/messages")
                        .header("Authorization", aliceAuth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"text\":\"  \"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("bad_request"));
    }

    @Test
    void cancelReturnsActiveRunIdThenNullWhenNoActiveRun() throws Exception {
        String id = createSession(aliceAuth, "chat", "/w/a");
        String runId = insertRunningRun(id);

        mockMvc.perform(post("/sessions/" + id + "/cancel").header("Authorization", aliceAuth))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.runId").value(runId));

        writeQueue.submit(() -> jdbc
                        .sql("UPDATE runs SET status = 'DONE' WHERE id = ?")
                        .param(runId)
                        .update())
                .join();

        MvcResult result = mockMvc.perform(post("/sessions/" + id + "/cancel").header("Authorization", aliceAuth))
                .andExpect(status().isOk())
                .andReturn();
        Object runIdAfterDone = JsonPath.read(result.getResponse().getContentAsString(), "$.runId");
        assertThat(runIdAfterDone).isNull();
    }

    @Test
    void cancelForeignSessionIsNotFound() throws Exception {
        String id = createSession(aliceAuth, "chat", "/w/a");

        mockMvc.perform(post("/sessions/" + id + "/cancel").header("Authorization", bobAuth))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error").value("not_found"));
    }

    @Test
    void uiActionAppendsUiEvent() throws Exception {
        String id = createSession(aliceAuth, "ui", "/w/a");

        MvcResult result = mockMvc.perform(post("/sessions/" + id + "/ui-action")
                        .header("Authorization", aliceAuth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"action\":\"refresh\",\"payload\":{\"tab\":2}}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.seq").isNumber())
                .andReturn();

        long seq = ((Number) JsonPath.read(result.getResponse().getContentAsString(), "$.seq")).longValue();
        List<Event> events = eventLog.readRange(id, 1);
        Event ui = events.stream()
                .filter(event -> EventTypes.UI.equals(event.type()))
                .findFirst()
                .orElseThrow();
        assertThat(ui.seq()).isEqualTo(seq);
        assertThat(ui.payloadAsMap()).containsEntry("action", "refresh");
        assertThat(ui.payloadAsMap().get("payload")).isEqualTo(Map.of("tab", 2));
    }

    @Test
    void uiActionOnForeignSessionIsNotFoundAndBlankActionIsBadRequest() throws Exception {
        String id = createSession(aliceAuth, "ui", "/w/a");

        mockMvc.perform(post("/sessions/" + id + "/ui-action")
                        .header("Authorization", bobAuth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"action\":\"refresh\"}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error").value("not_found"));

        mockMvc.perform(post("/sessions/" + id + "/ui-action")
                        .header("Authorization", aliceAuth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"action\":\"\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("bad_request"));
    }

    @Test
    void createValidatesProviderIdAndRequiredFields() throws Exception {
        String foreignProviderId = providers
                .create(bob.accountId(), "bob-prov", "openai", "sk-bob", "m", null, false)
                .join()
                .id();
        String ownProviderId = providers
                .create(alice.accountId(), "alice-prov", "openai", "sk-alice", "m", null, false)
                .join()
                .id();

        mockMvc.perform(post("/sessions")
                        .header("Authorization", aliceAuth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"t\",\"workdir\":\"/w\",\"providerId\":\"" + foreignProviderId + "\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("bad_request"));

        mockMvc.perform(post("/sessions")
                        .header("Authorization", aliceAuth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"\",\"workdir\":\"/w\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("bad_request"));

        mockMvc.perform(post("/sessions")
                        .header("Authorization", aliceAuth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"t\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("bad_request"));

        mockMvc.perform(post("/sessions")
                        .header("Authorization", aliceAuth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"t\",\"workdir\":\"/w\",\"providerId\":\"" + ownProviderId + "\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.providerId").value(ownProviderId));
    }

    @Test
    void deleteCascadesEventsAndRuns() throws Exception {
        String id = createSession(aliceAuth, "doomed", "/w/a");
        eventLog.append(id, EventTypes.USER_MESSAGE, Map.of("text", "hi")).join();
        String runId = insertRunningRun(id);

        mockMvc.perform(delete("/sessions/" + id).header("Authorization", aliceAuth))
                .andExpect(status().isNoContent());

        assertThat(count("SELECT COUNT(*) FROM events WHERE session_id = ?", id)).isZero();
        assertThat(count("SELECT COUNT(*) FROM runs WHERE session_id = ?", id)).isZero();
        assertThat(count("SELECT COUNT(*) FROM sessions WHERE id = ?", id)).isZero();
        assertThat(runId).isNotBlank();

        mockMvc.perform(delete("/sessions/" + id).header("Authorization", aliceAuth))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error").value("not_found"));
    }

    @Test
    void anonymousIsUnauthorizedOnAllRoutes() throws Exception {
        String id = UUID.randomUUID().toString();

        mockMvc.perform(get("/sessions")).andExpect(status().isUnauthorized());
        mockMvc.perform(post("/sessions")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"t\",\"workdir\":\"/w\"}"))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(get("/sessions/" + id)).andExpect(status().isUnauthorized());
        mockMvc.perform(patch("/sessions/" + id)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"t\"}"))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(delete("/sessions/" + id)).andExpect(status().isUnauthorized());
        mockMvc.perform(post("/sessions/" + id + "/messages")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"text\":\"hi\"}"))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(post("/sessions/" + id + "/cancel")).andExpect(status().isUnauthorized());
        mockMvc.perform(post("/sessions/" + id + "/ui-action")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"action\":\"a\"}"))
                .andExpect(status().isUnauthorized());
    }

    private String createSession(String auth, String title, String workdir) throws Exception {
        MvcResult result = mockMvc.perform(post("/sessions")
                        .header("Authorization", auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"" + title + "\",\"workdir\":\"" + workdir + "\"}"))
                .andExpect(status().isCreated())
                .andReturn();
        return JsonPath.read(result.getResponse().getContentAsString(), "$.id");
    }

    private String insertRunningRun(String sessionId) {
        String runId = UUID.randomUUID().toString();
        writeQueue.submit(() -> jdbc
                        .sql("INSERT INTO runs (id, session_id, status, model, provider_id, usage_json, error,"
                                + " started_at, ended_at) VALUES (?, ?, 'RUNNING', NULL, NULL, NULL, NULL, ?, NULL)")
                        .param(runId)
                        .param(sessionId)
                        .param(Instant.now().toString())
                        .update())
                .join();
        return runId;
    }

    private int count(String sql, String sessionId) {
        return jdbc.sql(sql).param(sessionId).query((rs, rowNum) -> rs.getInt(1)).single();
    }

    private IssuedDevice issueDevice(String name) {
        String accountId = accounts.createAccount(name + "-" + System.nanoTime());
        return devices.issueDevice(accountId, name + "-laptop");
    }
}
