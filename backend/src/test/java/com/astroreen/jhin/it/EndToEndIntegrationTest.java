package com.astroreen.jhin.it;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.core.accounts.AccountService;
import com.astroreen.jhin.core.accounts.DeviceService;
import com.astroreen.jhin.core.accounts.EnrollmentService;
import com.astroreen.jhin.core.accounts.IssueResult;
import com.astroreen.jhin.core.accounts.IssuedDevice;
import com.astroreen.jhin.core.events.EventLogService;
import com.astroreen.jhin.core.events.EventTypes;
import com.astroreen.jhin.core.sse.SseRegistry;
import com.astroreen.jhin.it.SseTestClient.Frame;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * T33: сквозные интеграционные тесты — реальный HTTP + SSE ({@code RANDOM_PORT}, temp
 * JHIN_HOME, mock LLM формата {@code mock}). Пять сценариев: полный run с tool call,
 * два SSE-клиента, resume fromSeq, изоляция аккаунтов, revoke устройства.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "server.ssl.enabled=false")
@Import(MockLlmTestConfiguration.class)
class EndToEndIntegrationTest {

    private static final long AWAIT_TIMEOUT_MILLIS = 10_000;
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final List<String> RUN_EVENT_TYPES = List.of(
            EventTypes.USER_MESSAGE,
            EventTypes.RUN_START,
            EventTypes.MESSAGE_START,
            EventTypes.MESSAGE_END,
            EventTypes.TOOL_USE,
            EventTypes.TOOL_RESULT,
            EventTypes.MESSAGE_START,
            EventTypes.TEXT_DELTA,
            EventTypes.MESSAGE_END,
            EventTypes.RUN_END);

    @TempDir
    static Path jhinHome;

    @TempDir
    Path workdir;

    @DynamicPropertySource
    static void jhinHomeProperties(DynamicPropertyRegistry registry) {
        registry.add("jhin.home", jhinHome::toString);
    }

    @LocalServerPort
    private int port;

    @Autowired
    private AccountService accounts;

    @Autowired
    private EnrollmentService enrollments;

    @Autowired
    private DeviceService devices;

    @Autowired
    private EventLogService eventLog;

    @Autowired
    private SseRegistry sseRegistry;

    @Autowired
    private JdbcClient jdbc;

    private HttpClient http;
    private String baseUrl;
    private final List<SseTestClient> openStreams = new ArrayList<>();

    @BeforeEach
    void setUp() {
        http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
        baseUrl = "http://127.0.0.1:" + port;
    }

    @AfterEach
    void tearDown() {
        openStreams.forEach(SseTestClient::close);
        openStreams.clear();
        sseRegistry.closeAll();
    }

    // ---------------------------------------------------------------- 1

    @Test
    void enrollAuthenticatesAndRunWithToolCallProducesFullEventSequence() throws Exception {
        String accountId = accounts.createAccount("alice-e2e-" + System.nanoTime());
        IssueResult code = enrollments.issueEnrollment(accountId);

        HttpResponse<String> enroll =
                post("/enroll", null, json(Map.of("code", code.code(), "deviceName", "e2e-phone")));
        assertThat(enroll.statusCode()).isEqualTo(200);
        JsonNode enrolled = parse(enroll.body());
        assertThat(enrolled.get("deviceToken").asText()).isNotBlank();
        assertThat(enrolled.get("accountId").asText()).isEqualTo(accountId);
        assertThat(enrolled.get("accountName").asText()).startsWith("alice-e2e-");
        String token = enrolled.get("deviceToken").asText();
        assertThat(devices.lookup(token)).isPresent();

        HttpResponse<String> sessionResp =
                post("/sessions", token, json(Map.of("title", "e2e", "workdir", workdir.toString())));
        assertThat(sessionResp.statusCode()).isEqualTo(201);
        String sessionId = parse(sessionResp.body()).get("id").asText();

        HttpResponse<String> providerResp = post(
                "/providers",
                token,
                json(Map.of(
                        "name", "mock", "format", "mock", "apiKey", "x", "model", "mock-1", "isDefault", true)));
        assertThat(providerResp.statusCode()).isEqualTo(201);

        SseTestClient sse = openStream(token, sessionId, 0);
        String runId = sendMessage(token, sessionId, "hi");
        List<Frame> frames = collectUntilRunEnd(sse, runId);

        assertThat(frames).extracting(Frame::type).containsExactlyElementsOf(RUN_EVENT_TYPES);
        assertContiguous(frames, 1);

        JsonNode userMessage = data(frames.get(0));
        assertKeys(userMessage, "text");
        assertThat(userMessage.get("text").asText()).isEqualTo("hi");

        JsonNode runStart = data(frames.get(1));
        assertKeys(runStart, "runId", "sessionId", "model", "providerId");
        assertThat(runStart.get("runId").asText()).isEqualTo(runId);
        assertThat(runStart.get("sessionId").asText()).isEqualTo(sessionId);

        JsonNode messageStart0 = data(frames.get(2));
        assertKeys(messageStart0, "runId", "messageId");
        assertThat(messageStart0.get("messageId").asText()).isEqualTo(runId + "-0");

        JsonNode messageEnd0 = data(frames.get(3));
        assertKeys(messageEnd0, "runId", "messageId", "text");
        assertThat(messageEnd0.get("messageId").asText()).isEqualTo(runId + "-0");
        assertThat(messageEnd0.get("text").asText()).isEmpty();

        JsonNode toolUse = data(frames.get(4));
        assertKeys(toolUse, "runId", "callId", "toolName", "arguments");
        assertThat(toolUse.get("toolName").asText()).isEqualTo(MockLlmTestConfiguration.TOOL_NAME);
        assertThat(toolUse.get("callId").asText()).isEqualTo(MockLlmTestConfiguration.CALL_ID);
        assertThat(toolUse.get("arguments").get("text").asText())
                .isEqualTo(MockLlmTestConfiguration.ECHO_TEXT);

        JsonNode toolResult = data(frames.get(5));
        assertKeys(
                toolResult,
                "runId",
                "callId",
                "toolName",
                "content",
                "error",
                "truncated",
                "structured",
                "meta",
                "streaming");
        assertThat(toolResult.get("callId").asText()).isEqualTo(MockLlmTestConfiguration.CALL_ID);
        assertThat(toolResult.get("toolName").asText()).isEqualTo(MockLlmTestConfiguration.TOOL_NAME);
        assertThat(toolResult.get("content").asText()).isEqualTo(MockLlmTestConfiguration.ECHO_TEXT);
        assertThat(toolResult.get("error").asBoolean()).isFalse();
        assertThat(toolResult.get("truncated").asBoolean()).isFalse();
        assertThat(toolResult.get("streaming").asBoolean()).isFalse();
        assertThat(toolResult.get("structured").isNull()).isTrue();
        assertThat(toolResult.get("meta").isObject()).isTrue();

        JsonNode messageStart1 = data(frames.get(6));
        assertKeys(messageStart1, "runId", "messageId");
        assertThat(messageStart1.get("messageId").asText()).isEqualTo(runId + "-1");

        JsonNode textDelta = data(frames.get(7));
        assertKeys(textDelta, "runId", "text");
        assertThat(textDelta.get("text").asText()).isEqualTo(MockLlmTestConfiguration.FINAL_TEXT);

        JsonNode messageEnd1 = data(frames.get(8));
        assertKeys(messageEnd1, "runId", "messageId", "text");
        assertThat(messageEnd1.get("messageId").asText()).isEqualTo(runId + "-1");
        assertThat(messageEnd1.get("text").asText()).isEqualTo(MockLlmTestConfiguration.FINAL_TEXT);

        JsonNode runEnd = data(frames.get(9));
        assertKeys(runEnd, "runId", "status");
        assertThat(runEnd.get("runId").asText()).isEqualTo(runId);
        assertThat(runEnd.get("status").asText()).isEqualTo("DONE");

        awaitUntil(() -> "DONE".equals(runRow(runId).get("status")));
        Map<String, Object> run = runRow(runId);
        assertThat(run.get("status")).isEqualTo("DONE");
        assertThat(run.get("error")).isNull();
        String usageJson = (String) run.get("usage_json");
        assertThat(usageJson).isNotBlank();
        JsonNode usage = parse(usageJson);
        assertThat(usage.isObject()).isTrue();
        assertThat(usage.has("inputTokens")).isTrue();
        assertThat(usage.has("outputTokens")).isTrue();
        assertThat(usage.has("totalTokens")).isTrue();
    }

    // ---------------------------------------------------------------- 2

    @Test
    void twoSseClientsOnOneSessionReceiveIdenticalEventSequences() {
        String accountId = accounts.createAccount("pair-e2e-" + System.nanoTime());
        IssuedDevice laptop = devices.issueDevice(accountId, "laptop");
        IssuedDevice phone = devices.issueDevice(accountId, "phone");
        createProvider(laptop.token());
        String sessionId = createSession(laptop.token(), "pair");

        SseTestClient first = openStream(laptop.token(), sessionId, 0);
        SseTestClient second = openStream(phone.token(), sessionId, 0);

        String runId = sendMessage(laptop.token(), sessionId, "hi");
        List<Frame> framesA = collectUntilRunEnd(first, runId);
        List<Frame> framesB = collectUntilRunEnd(second, runId);

        assertThat(framesB).isEqualTo(framesA);
        assertContiguous(framesA, 1);
        assertThat(framesA).extracting(Frame::seq).doesNotHaveDuplicates();
        assertThat(framesA).extracting(Frame::type).containsExactlyElementsOf(RUN_EVENT_TYPES);
    }

    // ---------------------------------------------------------------- 3

    @Test
    void resumeFromSeqAfterDisconnectReturnsOnlyNewEvents() {
        String accountId = accounts.createAccount("resume-e2e-" + System.nanoTime());
        IssuedDevice device = devices.issueDevice(accountId, "laptop");
        createProvider(device.token());
        String sessionId = createSession(device.token(), "resume");

        SseTestClient first = openStream(device.token(), sessionId, 0);
        String runId1 = sendMessage(device.token(), sessionId, "hi");
        List<Frame> firstBatch = collectUntilRunEnd(first, runId1);
        long lastSeenSeq = firstBatch.get(firstBatch.size() - 1).seq();

        first.close();

        String runId2 = sendMessage(device.token(), sessionId, "again");
        awaitUntil(() -> runEnded(sessionId, runId2));

        SseTestClient second = openStream(device.token(), sessionId, lastSeenSeq + 1);
        List<Frame> secondBatch = collectUntilRunEnd(second, runId2);

        assertThat(secondBatch).isNotEmpty();
        assertThat(secondBatch.get(0).seq()).isEqualTo(lastSeenSeq + 1);
        assertThat(secondBatch).allSatisfy(frame -> assertThat(frame.seq()).isGreaterThan(lastSeenSeq));
        assertContiguous(secondBatch, lastSeenSeq + 1);
        assertThat(secondBatch).extracting(Frame::type).containsExactlyElementsOf(RUN_EVENT_TYPES);
    }

    // ---------------------------------------------------------------- 4

    @Test
    void accountIsolationReturnsNotFoundForForeignSession() {
        String accountIdA = accounts.createAccount("iso-a-" + System.nanoTime());
        IssuedDevice deviceA = devices.issueDevice(accountIdA, "a-laptop");
        String sessionIdA = createSession(deviceA.token(), "private");

        String accountIdB = accounts.createAccount("iso-b-" + System.nanoTime());
        IssuedDevice deviceB = devices.issueDevice(accountIdB, "b-laptop");

        HttpResponse<String> get = get("/sessions/" + sessionIdA, deviceB.token());
        assertThat(get.statusCode()).isEqualTo(404);
        assertThat(parse(get.body()).get("error").asText()).isEqualTo("not_found");

        HttpResponse<String> patch =
                patch("/sessions/" + sessionIdA, deviceB.token(), json(Map.of("title", "hacked")));
        assertThat(patch.statusCode()).isEqualTo(404);
        assertThat(parse(patch.body()).get("error").asText()).isEqualTo("not_found");

        HttpResponse<String> delete = delete("/sessions/" + sessionIdA, deviceB.token());
        assertThat(delete.statusCode()).isEqualTo(404);
        assertThat(parse(delete.body()).get("error").asText()).isEqualTo("not_found");

        HttpResponse<String> message =
                post("/sessions/" + sessionIdA + "/messages", deviceB.token(), json(Map.of("text", "hi")));
        assertThat(message.statusCode()).isEqualTo(404);
        assertThat(parse(message.body()).get("error").asText()).isEqualTo("not_found");

        HttpResponse<String> list = get("/sessions", deviceB.token());
        assertThat(list.statusCode()).isEqualTo(200);
        JsonNode sessionsB = parse(list.body());
        assertThat(sessionsB.isArray()).isTrue();
        for (JsonNode item : sessionsB) {
            assertThat(item.get("id").asText()).isNotEqualTo(sessionIdA);
        }

        assertThat(get("/sessions/" + sessionIdA, deviceA.token()).statusCode()).isEqualTo(200);
    }

    // ---------------------------------------------------------------- 5

    @Test
    void deviceRevokeClosesSseStreamAndYieldsUnauthorized() {
        String accountId = accounts.createAccount("revoke-e2e-" + System.nanoTime());
        IssuedDevice phone = devices.issueDevice(accountId, "phone");
        String sessionId = createSession(phone.token(), "revoke");

        SseTestClient sse = openStream(phone.token(), sessionId, 0);
        eventLog.append(sessionId, EventTypes.UI, Map.of("action", "ping")).join();
        Frame liveness = sse.pollFrame(AWAIT_TIMEOUT_MILLIS);
        assertThat(liveness).isNotNull();
        assertThat(liveness.type()).isEqualTo(EventTypes.UI);

        assertThat(devices.revokeDevice(phone.id())).isTrue();

        assertThat(sse.awaitEof(AWAIT_TIMEOUT_MILLIS))
                .as("SSE stream must complete after device revoke")
                .isTrue();

        HttpResponse<String> after = get("/sessions", phone.token());
        assertThat(after.statusCode()).isEqualTo(401);
        assertThat(parse(after.body()).get("error").asText()).isEqualTo("unauthorized");
    }

    // ---------------------------------------------------------------- helpers

    private SseTestClient openStream(String token, String sessionId, long fromSeq) {
        SseTestClient client = SseTestClient.open(baseUrl, token, sessionId, fromSeq);
        openStreams.add(client);
        return client;
    }

    private String createProvider(String token) {
        HttpResponse<String> response = post(
                "/providers",
                token,
                json(Map.of(
                        "name", "mock", "format", "mock", "apiKey", "x", "model", "mock-1", "isDefault", true)));
        assertThat(response.statusCode()).isEqualTo(201);
        return parse(response.body()).get("id").asText();
    }

    private String createSession(String token, String title) {
        HttpResponse<String> response =
                post("/sessions", token, json(Map.of("title", title, "workdir", workdir.toString())));
        assertThat(response.statusCode()).isEqualTo(201);
        return parse(response.body()).get("id").asText();
    }

    private String sendMessage(String token, String sessionId, String text) {
        HttpResponse<String> response =
                post("/sessions/" + sessionId + "/messages", token, json(Map.of("text", text)));
        assertThat(response.statusCode()).isEqualTo(200);
        String runId = parse(response.body()).get("runId").asText();
        assertThat(runId).isNotBlank();
        return runId;
    }

    /** Собирает фреймы до run_end указанного run'а (включительно). */
    private static List<Frame> collectUntilRunEnd(SseTestClient client, String runId) {
        List<Frame> collected = new ArrayList<>();
        long deadline = System.currentTimeMillis() + AWAIT_TIMEOUT_MILLIS;
        while (System.currentTimeMillis() < deadline) {
            Frame frame = client.pollFrame(Math.max(1, deadline - System.currentTimeMillis()));
            if (frame == null) {
                break;
            }
            collected.add(frame);
            if (EventTypes.RUN_END.equals(frame.type())
                    && runId.equals(data(frame).path("runId").asText())) {
                return collected;
            }
        }
        throw new AssertionError("no run_end for " + runId + " in " + collected.stream()
                .map(Frame::type)
                .toList());
    }

    private static void assertContiguous(List<Frame> frames, long firstSeq) {
        long expected = firstSeq;
        for (Frame frame : frames) {
            assertThat(frame.seq()).isEqualTo(expected++);
        }
    }

    private static void assertKeys(JsonNode payload, String... expected) {
        List<String> keys = new ArrayList<>();
        payload.fieldNames().forEachRemaining(keys::add);
        assertThat(keys).containsExactly(expected);
    }

    private boolean runEnded(String sessionId, String runId) {
        return eventLog.readRange(sessionId, 1).stream()
                .anyMatch(event -> EventTypes.RUN_END.equals(event.type())
                        && runId.equals(event.payloadAsMap().get("runId")));
    }

    private Map<String, Object> runRow(String runId) {
        return jdbc.sql("SELECT status, usage_json, error FROM runs WHERE id = ?")
                .param(runId)
                .query((rs, rowNum) -> {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("status", rs.getString("status"));
                    row.put("usage_json", rs.getString("usage_json"));
                    row.put("error", rs.getString("error"));
                    return row;
                })
                .single();
    }

    private static JsonNode data(Frame frame) {
        return parse(frame.data());
    }

    private static JsonNode parse(String body) {
        try {
            return MAPPER.readTree(body);
        } catch (JsonProcessingException e) {
            throw new AssertionError("invalid JSON body: " + body, e);
        }
    }

    private static String json(Map<String, ?> fields) {
        try {
            return MAPPER.writeValueAsString(fields);
        } catch (JsonProcessingException e) {
            throw new AssertionError("cannot serialize request body", e);
        }
    }

    private HttpResponse<String> get(String path, String token) {
        return send(HttpRequest.newBuilder(URI.create(baseUrl + path))
                .header("Authorization", "Bearer " + token)
                .timeout(Duration.ofSeconds(30))
                .GET()
                .build());
    }

    private HttpResponse<String> post(String path, String token, String body) {
        return send(jsonRequest(path, token).POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                .build());
    }

    private HttpResponse<String> patch(String path, String token, String body) {
        return send(jsonRequest(path, token)
                .method("PATCH", HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                .build());
    }

    private HttpResponse<String> delete(String path, String token) {
        return send(jsonRequest(path, token).DELETE().build());
    }

    private HttpRequest.Builder jsonRequest(String path, String token) {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(baseUrl + path))
                .header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(30));
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        return builder;
    }

    private HttpResponse<String> send(HttpRequest request) {
        try {
            return http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new AssertionError("HTTP call failed: " + request.uri(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError("HTTP call interrupted: " + request.uri(), e);
        }
    }

    private static void awaitUntil(BooleanSupplier condition) {
        long deadline = System.currentTimeMillis() + AWAIT_TIMEOUT_MILLIS;
        while (System.currentTimeMillis() < deadline) {
            if (condition.getAsBoolean()) {
                return;
            }
            try {
                Thread.sleep(5);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        assertThat(condition.getAsBoolean())
                .as("condition not met within " + AWAIT_TIMEOUT_MILLIS + "ms")
                .isTrue();
    }
}
