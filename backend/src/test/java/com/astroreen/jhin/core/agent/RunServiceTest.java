package com.astroreen.jhin.core.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.core.agent.AgentTestEnv.ScriptedChatModel;
import com.astroreen.jhin.core.events.Event;
import com.astroreen.jhin.core.events.EventTypes;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class RunServiceTest {

    private static final long AWAIT_MILLIS = 10_000;

    @TempDir
    Path jhinHome;

    @TempDir
    Path workdir;

    private AgentTestEnv env;
    private ScriptedChatModel chatModel;

    @BeforeEach
    void setUp() throws Exception {
        env = new AgentTestEnv(jhinHome, workdir, List.of(), List.of());
        chatModel = new ScriptedChatModel();
        env.factoryModel.set(chatModel);
    }

    @AfterEach
    void tearDown() {
        env.close();
    }

    @Test
    void startRunCreatesRowCopiesModelAndAppendsUserMessage() throws Exception {
        chatModel.enqueue(AgentTestEnv.chatText("ok"));

        String runId = env.runService.startRun(AgentTestEnv.SESSION_ID, env.accountId, "hello world");

        assertThat(runId).matches("[0-9a-f-]{36}");
        Map<String, Object> run = env.runRow(runId);
        assertThat(run.get("session_id")).isEqualTo(AgentTestEnv.SESSION_ID);
        assertThat(run.get("model")).isEqualTo("mock-model");
        assertThat(run.get("provider_id")).isEqualTo(env.providerId);
        assertThat(run.get("started_at")).isNotNull();

        assertThat(env.awaitTerminal(runId, AWAIT_MILLIS)).isEqualTo("DONE");

        Event first = env.events().get(0);
        assertThat(first.type()).isEqualTo(EventTypes.USER_MESSAGE);
        assertThat(first.payloadAsMap()).hasSize(1).containsEntry("text", "hello world");
    }

    @Test
    void startRunUnknownSessionThrows() {
        assertThatThrownBy(() -> env.runService.startRun("missing", env.accountId, "hi"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void startRunForeignAccountThrows() {
        assertThatThrownBy(() -> env.runService.startRun(AgentTestEnv.SESSION_ID, "other-account", "hi"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void cancelUnknownRunIsNoop() {
        env.runService.cancel("no-such-run");
        env.runService.cancel(null);
    }

    @Test
    void findRunReturnsRecordForKnownAndEmptyForUnknown() throws Exception {
        chatModel.enqueue(AgentTestEnv.chatText("ok"));
        String runId = env.runService.startRun(AgentTestEnv.SESSION_ID, env.accountId, "hi");
        assertThat(env.awaitTerminal(runId, AWAIT_MILLIS)).isEqualTo("DONE");

        RunRecord record = env.runService.findRun(runId).orElseThrow();
        assertThat(record.id()).isEqualTo(runId);
        assertThat(record.sessionId()).isEqualTo(AgentTestEnv.SESSION_ID);
        assertThat(record.status()).isEqualTo("DONE");
        assertThat(record.model()).isEqualTo("mock-model");
        assertThat(record.providerId()).isEqualTo(env.providerId);
        assertThat(record.error()).isNull();

        assertThat(env.runService.findRun(UUID.randomUUID().toString())).isEmpty();
    }

    @Test
    void providerFailureFinalizesRunAsError() throws Exception {
        env.factoryModel.set(null);

        String runId = env.runService.startRun(AgentTestEnv.SESSION_ID, env.accountId, "hi");

        assertThat(env.awaitTerminal(runId, AWAIT_MILLIS)).isEqualTo("ERROR");
        assertThat(env.runRow(runId).get("ended_at")).isNotNull();
        assertThat(env.lastEvent(EventTypes.RUN_END).payloadAsMap()).containsEntry("status", "ERROR");
    }

    @Test
    void runRecoveryMarksRunningRunsInterrupted() {
        String runId = UUID.randomUUID().toString();
        env.jdbc
                .sql("INSERT INTO runs (id, session_id, status, model, provider_id, started_at)"
                        + " VALUES (?, ?, 'RUNNING', 'mock-model', ?, ?)")
                .param(runId)
                .param(AgentTestEnv.SESSION_ID)
                .param(env.providerId)
                .param(Instant.now().toString())
                .update();
        String doneId = UUID.randomUUID().toString();
        env.jdbc
                .sql("INSERT INTO runs (id, session_id, status, model, provider_id, started_at, ended_at)"
                        + " VALUES (?, ?, 'DONE', 'mock-model', ?, ?, ?)")
                .param(doneId)
                .param(AgentTestEnv.SESSION_ID)
                .param(env.providerId)
                .param(Instant.now().toString())
                .param(Instant.now().toString())
                .update();

        new RunRecovery(env.writeQueue, env.jdbc, new com.astroreen.jhin.core.db.MigrationRunner(env.dataSource))
                .run(null);

        Map<String, Object> interrupted = env.runRow(runId);
        assertThat(interrupted.get("status")).isEqualTo("INTERRUPTED");
        assertThat(interrupted.get("ended_at")).isNotNull();

        Map<String, Object> done = env.runRow(doneId);
        assertThat(done.get("status")).isEqualTo("DONE");
    }
}
