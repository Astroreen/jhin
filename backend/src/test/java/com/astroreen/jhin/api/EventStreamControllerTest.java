package com.astroreen.jhin.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.astroreen.jhin.core.accounts.AccountService;
import com.astroreen.jhin.core.accounts.DeviceService;
import com.astroreen.jhin.core.accounts.IssuedDevice;
import com.astroreen.jhin.core.events.EventLogService;
import com.astroreen.jhin.core.events.EventTypes;
import com.astroreen.jhin.core.sessions.SessionService;
import com.astroreen.jhin.core.sse.SseRegistry;
import com.astroreen.jhin.core.sse.SseStreamService;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.mock.web.MockAsyncContext;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

@SpringBootTest
class EventStreamControllerTest {

    private static final long AWAIT_TIMEOUT_MILLIS = 5_000;

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
    private SessionService sessions;

    @Autowired
    private EventLogService eventLog;

    @Autowired
    private SseRegistry sseRegistry;

    @Autowired
    private SseStreamService sseStreamService;

    private MockMvc mockMvc;
    private String aliceAccountId;
    private String bobAccountId;
    private String aliceAuth;
    private String bobAuth;

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders.webAppContextSetup(context)
                .addFilters(springSecurityFilterChain)
                .build();
        aliceAccountId = accounts.createAccount("alice-" + System.nanoTime());
        bobAccountId = accounts.createAccount("bob-" + System.nanoTime());
        aliceAuth = "Bearer " + devices.issueDevice(aliceAccountId, "alice-laptop").token();
        bobAuth = "Bearer " + devices.issueDevice(bobAccountId, "bob-laptop").token();
    }

    @AfterEach
    void tearDown() {
        sseRegistry.closeAll();
        awaitUntil(() -> eventLog.subscriptionCount() == 0 && sseStreamService.activeStreamCount() == 0);
    }

    @Test
    void replayDeliversHistoryWithExactFraming() throws Exception {
        String sessionId = createSession("replay");
        append(sessionId, EventTypes.USER_MESSAGE, "one", 1);
        append(sessionId, EventTypes.TEXT_DELTA, "two", 2);
        append(sessionId, EventTypes.MESSAGE_END, "three", 3);

        MvcResult result = openStream(aliceAuth, sessionId, null);

        assertThat(result.getRequest().isAsyncStarted()).isTrue();
        assertThat(result.getResponse().getContentType()).contains("text/event-stream");
        awaitUntil(() -> frames(body(result)).size() >= 3);

        String body = body(result);
        assertThat(body).contains("id: 1\nevent: user_message\ndata: {\"text\":\"one\"}\n\n");
        assertThat(body).contains("id: 2\nevent: text_delta\ndata: {\"text\":\"two\"}\n\n");
        assertThat(body).contains("id: 3\nevent: message_end\ndata: {\"text\":\"three\"}\n\n");
        assertThat(frames(body)).extracting(Frame::seq).containsExactly(1L, 2L, 3L);
        assertThat(frames(body))
                .extracting(Frame::type)
                .containsExactly(EventTypes.USER_MESSAGE, EventTypes.TEXT_DELTA, EventTypes.MESSAGE_END);
    }

    @Test
    void replayHonoursFromSeqInclusive() throws Exception {
        String sessionId = createSession("from-seq");
        append(sessionId, EventTypes.TEXT_DELTA, "one", 1);
        append(sessionId, EventTypes.TEXT_DELTA, "two", 2);
        append(sessionId, EventTypes.TEXT_DELTA, "three", 3);

        MvcResult result = openStream(aliceAuth, sessionId, "2");

        awaitUntil(() -> frames(body(result)).size() >= 2);
        assertThat(frames(body(result))).extracting(Frame::seq).containsExactly(2L, 3L);
    }

    @Test
    void liveDeliversAppendedEventsPreservingOrder() throws Exception {
        String sessionId = createSession("live");
        MvcResult result = openStream(aliceAuth, sessionId, "0");
        assertThat(eventLog.subscriptionCount()).isEqualTo(1);

        append(sessionId, EventTypes.TEXT_DELTA, "one", 1);
        append(sessionId, EventTypes.TEXT_DELTA, "two", 2);
        append(sessionId, EventTypes.MESSAGE_END, "three", 3);

        awaitUntil(() -> frames(body(result)).size() >= 3);
        assertThat(frames(body(result))).extracting(Frame::seq).containsExactly(1L, 2L, 3L);
        assertThat(frames(body(result)))
                .extracting(Frame::data)
                .containsExactly("{\"text\":\"one\"}", "{\"text\":\"two\"}", "{\"text\":\"three\"}");
    }

    @Test
    void resumeAfterDisconnectDeliversOnlyNewEventsWithoutGapsOrDuplicates() throws Exception {
        String sessionId = createSession("resume");
        append(sessionId, EventTypes.TEXT_DELTA, "one", 1);
        append(sessionId, EventTypes.TEXT_DELTA, "two", 2);
        append(sessionId, EventTypes.TEXT_DELTA, "three", 3);

        MvcResult first = openStream(aliceAuth, sessionId, null);
        awaitUntil(() -> frames(body(first)).size() >= 3);

        disconnect(first);
        awaitUntil(() -> eventLog.subscriptionCount() == 0);

        append(sessionId, EventTypes.TEXT_DELTA, "four", 4);
        append(sessionId, EventTypes.MESSAGE_END, "five", 5);

        MvcResult second = openStream(aliceAuth, sessionId, "4");
        awaitUntil(() -> frames(body(second)).size() >= 2);

        assertThat(frames(body(second))).extracting(Frame::seq).containsExactly(4L, 5L);
    }

    @Test
    void twoClientsOnOneSessionReceiveIdenticalEventSets() throws Exception {
        String sessionId = createSession("two-clients");
        IssuedDevice secondDevice = devices.issueDevice(aliceAccountId, "alice-phone");
        String secondAuth = "Bearer " + secondDevice.token();
        append(sessionId, EventTypes.TEXT_DELTA, "one", 1);
        append(sessionId, EventTypes.TEXT_DELTA, "two", 2);

        MvcResult first = openStream(aliceAuth, sessionId, null);
        MvcResult second = openStream(secondAuth, sessionId, null);

        awaitUntil(() -> frames(body(first)).size() >= 2 && frames(body(second)).size() >= 2);
        append(sessionId, EventTypes.MESSAGE_END, "three", 3);
        awaitUntil(() -> frames(body(first)).size() >= 3 && frames(body(second)).size() >= 3);

        assertThat(frames(body(first))).extracting(Frame::seq).containsExactly(1L, 2L, 3L);
        assertThat(frames(body(second))).extracting(Frame::seq).containsExactly(1L, 2L, 3L);
        assertThat(frames(body(second))).isEqualTo(frames(body(first)));
    }

    @Test
    void foreignAndMissingSessionsAreNotFoundWithoutStream() throws Exception {
        String sessionId = createSession("isolation");

        MvcResult foreign = mockMvc.perform(get("/sessions/" + sessionId + "/events").header("Authorization", bobAuth))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error").value("not_found"))
                .andReturn();
        assertThat(foreign.getRequest().isAsyncStarted()).isFalse();

        mockMvc.perform(get("/sessions/" + "no-such-session" + "/events").header("Authorization", aliceAuth))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error").value("not_found"));

        assertThat(eventLog.subscriptionCount()).isZero();
        assertThat(sseStreamService.activeStreamCount()).isZero();
    }

    @Test
    void revokeCompletesStreamAndCancelsTimers() throws Exception {
        String sessionId = createSession("revoke");
        IssuedDevice phone = devices.issueDevice(aliceAccountId, "alice-phone");
        String phoneAuth = "Bearer " + phone.token();
        append(sessionId, EventTypes.TEXT_DELTA, "one", 1);

        MvcResult result = openStream(phoneAuth, sessionId, null);
        awaitUntil(() -> frames(body(result)).size() >= 1);
        assertThat(sseStreamService.activeStreamCount()).isEqualTo(1);

        devices.revokeDevice(phone.id());

        result.getAsyncResult(AWAIT_TIMEOUT_MILLIS);
        awaitUntil(() -> eventLog.subscriptionCount() == 0 && sseStreamService.activeStreamCount() == 0);
        assertThat(sseRegistry.activeCount()).isZero();
    }

    @Test
    void closingStreamsClearsSubscriptionsAndTimers() throws Exception {
        String sessionId = createSession("leaks");
        for (int i = 0; i < 3; i++) {
            openStream(aliceAuth, sessionId, null);
        }
        awaitUntil(() -> eventLog.subscriptionCount() == 3 && sseStreamService.activeStreamCount() == 3);

        sseRegistry.closeAll();

        awaitUntil(() -> eventLog.subscriptionCount() == 0 && sseStreamService.activeStreamCount() == 0);
        assertThat(sseRegistry.activeCount()).isZero();
    }

    @Test
    void invalidFromSeqIsBadRequestAndBlankDefaultsToZero() throws Exception {
        String sessionId = createSession("bad-from-seq");

        mockMvc.perform(get("/sessions/" + sessionId + "/events?fromSeq=abc").header("Authorization", aliceAuth))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("bad_request"));
        mockMvc.perform(get("/sessions/" + sessionId + "/events?fromSeq=-1").header("Authorization", aliceAuth))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("bad_request"));
        assertThat(eventLog.subscriptionCount()).isZero();

        mockMvc.perform(get("/sessions/" + sessionId + "/events?fromSeq=").header("Authorization", aliceAuth))
                .andExpect(status().isOk());
        assertThat(eventLog.subscriptionCount()).isEqualTo(1);
    }

    @Test
    void anonymousIsUnauthorized() throws Exception {
        String sessionId = createSession("anon");

        mockMvc.perform(get("/sessions/" + sessionId + "/events"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error").value("unauthorized"));
    }

    private MvcResult openStream(String auth, String sessionId, String fromSeq) throws Exception {
        StringBuilder url = new StringBuilder("/sessions/").append(sessionId).append("/events");
        if (fromSeq != null) {
            url.append("?fromSeq=").append(fromSeq);
        }
        MvcResult result = mockMvc.perform(get(url.toString()).header("Authorization", auth))
                .andExpect(status().isOk())
                .andReturn();
        assertThat(result.getRequest().isAsyncStarted()).isTrue();
        return result;
    }

    /** Симуляция обрыва клиента: конец async-цикла запускает completion-колбэки эмиттера. */
    private static void disconnect(MvcResult result) {
        MockAsyncContext asyncContext = (MockAsyncContext) result.getRequest().getAsyncContext();
        asyncContext.complete();
    }

    private String createSession(String title) {
        return sessions.create(aliceAccountId, title, "/w", null, null).id();
    }

    private void append(String sessionId, String type, String text, long expectedSeq) {
        assertThat(eventLog.append(sessionId, type, Map.of("text", text)).join().seq()).isEqualTo(expectedSeq);
    }

    private static String body(MvcResult result) {
        return new String(result.getResponse().getContentAsByteArray(), StandardCharsets.UTF_8);
    }

    private record Frame(long seq, String type, String data) {}

    private static List<Frame> frames(String body) {
        List<Frame> frames = new ArrayList<>();
        for (String block : body.split("\n\n")) {
            Long id = null;
            String type = null;
            String data = null;
            for (String line : block.split("\n")) {
                if (line.startsWith("id: ")) {
                    id = Long.parseLong(line.substring(4));
                } else if (line.startsWith("event: ")) {
                    type = line.substring(7);
                } else if (line.startsWith("data: ")) {
                    data = line.substring(6);
                }
            }
            if (id != null && type != null && data != null) {
                frames.add(new Frame(id, type, data));
            }
        }
        return frames;
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
