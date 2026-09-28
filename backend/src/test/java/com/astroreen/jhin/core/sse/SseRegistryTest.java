package com.astroreen.jhin.core.sse;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.core.accounts.AccountService;
import com.astroreen.jhin.core.accounts.DeviceService;
import com.astroreen.jhin.core.accounts.IssuedDevice;
import com.astroreen.jhin.core.db.DatabaseConfig;
import com.astroreen.jhin.core.db.MigrationRunner;
import com.astroreen.jhin.core.db.WriteQueue;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.core.simple.JdbcClient;

class SseRegistryTest {

    private final SseRegistry registry = new SseRegistry();

    @Test
    void registerAndUnregisterBookkeeping() {
        FakeSink a = new FakeSink();
        FakeSink b = new FakeSink();
        FakeSink c = new FakeSink();
        registry.register("d1", a);
        registry.register("d1", b);
        registry.register("d2", c);

        assertThat(registry.activeCount()).isEqualTo(3);
        assertThat(registry.activeCount("d1")).isEqualTo(2);
        assertThat(registry.activeCount("d2")).isEqualTo(1);

        registry.unregister("d1", a);
        assertThat(registry.activeCount()).isEqualTo(2);
        assertThat(registry.activeCount("d1")).isEqualTo(1);

        registry.unregister("d1", b);
        assertThat(registry.activeCount("d1")).isZero();
        assertThat(registry.activeCount()).isEqualTo(1);
    }

    @Test
    void closeDeviceCompletesAllDeviceSinksOnly() {
        FakeSink s1 = new FakeSink();
        FakeSink s2 = new FakeSink();
        FakeSink other = new FakeSink();
        registry.register("d1", s1);
        registry.register("d1", s2);
        registry.register("d2", other);

        registry.closeDevice("d1");

        assertThat(s1.completions).hasValue(1);
        assertThat(s2.completions).hasValue(1);
        assertThat(s1.isOpen()).isFalse();
        assertThat(s2.isOpen()).isFalse();
        assertThat(other.completions).hasValue(0);
        assertThat(other.isOpen()).isTrue();
        assertThat(registry.activeCount("d1")).isZero();
        assertThat(registry.activeCount("d2")).isEqualTo(1);

        registry.closeDevice("d1");

        assertThat(s1.completions).hasValue(1);
        assertThat(s2.completions).hasValue(1);
    }

    @Test
    void closeAllCompletesEverySink() {
        FakeSink a = new FakeSink();
        FakeSink b = new FakeSink();
        registry.register("d1", a);
        registry.register("d2", b);

        registry.closeAll();

        assertThat(a.completions).hasValue(1);
        assertThat(b.completions).hasValue(1);
        assertThat(registry.activeCount()).isZero();
    }

    @Test
    void revokeEventClosesDeviceSinks() {
        FakeSink a = new FakeSink();
        FakeSink b = new FakeSink();
        registry.register("d1", a);
        registry.register("d2", b);

        registry.onDeviceRevoked(new DeviceRevokedEvent("d1"));

        assertThat(a.completions).hasValue(1);
        assertThat(a.isOpen()).isFalse();
        assertThat(b.completions).hasValue(0);
        assertThat(registry.activeCount("d1")).isZero();
        assertThat(registry.activeCount("d2")).isEqualTo(1);
    }

    @Test
    void deviceServiceRevokePublishesEventAndClosesSinks(@TempDir Path jhinHome) throws Exception {
        DataSource dataSource = DatabaseConfig.createDataSource(jhinHome);
        new MigrationRunner(dataSource).migrate();
        WriteQueue writeQueue = new WriteQueue();
        try {
            JdbcClient jdbcClient = JdbcClient.create(dataSource);
            AccountService accounts = new AccountService(jdbcClient, writeQueue);
            List<Object> captured = new CopyOnWriteArrayList<>();
            ApplicationEventPublisher publisher = event -> {
                captured.add(event);
                registry.onDeviceRevoked((DeviceRevokedEvent) event);
            };
            DeviceService devices = new DeviceService(jdbcClient, writeQueue, publisher);

            String accountId = accounts.createAccount("alice");
            IssuedDevice issued = devices.issueDevice(accountId, "laptop");

            FakeSink sink = new FakeSink();
            registry.register(issued.id(), sink);

            assertThat(devices.revokeDevice(issued.id())).isTrue();

            assertThat(captured).containsExactly(new DeviceRevokedEvent(issued.id()));
            assertThat(sink.completions).hasValue(1);
            assertThat(sink.isOpen()).isFalse();
            assertThat(registry.activeCount(issued.id())).isZero();
        } finally {
            writeQueue.close();
        }
    }
}