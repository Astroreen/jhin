package com.astroreen.jhin.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.astroreen.jhin.core.accounts.AccountService;
import com.astroreen.jhin.core.accounts.DeviceService;
import com.astroreen.jhin.core.accounts.IssuedDevice;
import com.astroreen.jhin.core.db.WriteQueue;
import com.astroreen.jhin.core.reload.ExitHandler;
import com.astroreen.jhin.core.reload.ReloadService;
import java.nio.file.Path;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

/**
 * POST /admin/reload в dev-режиме: {@code jhin.dev-mode} не задан — авто-детект по URL кода
 * (exploded classes, не jar) даёт dev-mode. Рестарт не планируется, runs не трогаются,
 * ответ 503. Плюс проверка, что workers('local') зарегистрировалась при старте контекста.
 */
@SpringBootTest
class AdminControllerDevModeTest {

    @TempDir
    static Path jhinHome;

    @DynamicPropertySource
    static void reloadProperties(DynamicPropertyRegistry registry) {
        registry.add("jhin.home", jhinHome::toString);
    }

    @TestConfiguration
    static class FakeExitConfiguration {

        @Bean
        @Primary
        RecordingExitHandler recordingExitHandler() {
            return new RecordingExitHandler();
        }
    }

    /** Фейковый exit: пишет коды в очередь, JVM не завершает. */
    static final class RecordingExitHandler implements ExitHandler {

        final BlockingQueue<Integer> codes = new LinkedBlockingQueue<>();

        @Override
        public void exit(int code) {
            codes.add(code);
        }
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
    private WriteQueue writeQueue;

    @Autowired
    private JdbcClient jdbcClient;

    @Autowired
    private ReloadService reloadService;

    @Autowired
    private RecordingExitHandler exitHandler;

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders.webAppContextSetup(context)
                .addFilters(springSecurityFilterChain)
                .build();
    }

    @Test
    void reloadWithDeviceTokenIsServiceUnavailableAndKeepsRuns() throws Exception {
        assertThat(reloadService.isDevMode()).isTrue();
        IssuedDevice device = issueDevice("alice");
        String runId = insertRunningRun();

        mockMvc.perform(post("/admin/reload").header("Authorization", "Bearer " + device.token()))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.error").value("restart manually"));

        assertThat(exitHandler.codes).isEmpty();
        String status = jdbcClient
                .sql("SELECT status FROM runs WHERE id = ?")
                .param(runId)
                .query(String.class)
                .single();
        assertThat(status).isEqualTo("RUNNING");
    }

    @Test
    void workerLocalRowIsRegisteredAtStartup() {
        String status = jdbcClient
                .sql("SELECT status FROM workers WHERE id = 'local' AND name = 'local'")
                .query(String.class)
                .single();
        assertThat(status).isEqualTo("ONLINE");
    }

    private IssuedDevice issueDevice(String name) {
        String accountId = accounts.createAccount(name);
        return devices.issueDevice(accountId, name + "-laptop");
    }

    private String insertRunningRun() {
        String accountId = accounts.createAccount("runs-" + UUID.randomUUID());
        jdbcClient
                .sql("INSERT INTO sessions (id, account_id, title, workdir, model, provider_id, created_at, updated_at)"
                        + " VALUES (?, ?, 'test', '/tmp/work', NULL, NULL, '1', '1')")
                .param("session-" + accountId)
                .param(accountId)
                .update();
        String runId = UUID.randomUUID().toString();
        writeQueue.submit(() -> jdbcClient
                        .sql("INSERT INTO runs (id, session_id, status, model, provider_id, started_at)"
                                + " VALUES (?, ?, 'RUNNING', 'mock-model', NULL, ?)")
                        .param(runId)
                        .param("session-" + accountId)
                        .param(Instant.now().toString())
                        .update())
                .join();
        return runId;
    }
}
