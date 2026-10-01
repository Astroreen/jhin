/**
 * Unit tests for {@link ReloadPlugin}: the 202 acknowledgement contract and
 * the delayed exit path over an injected exit stub (the JVM is never exited).
 */
package com.astroreen.jhin.plugin.reload;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.http.RouteSpec;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

final class ReloadPluginTest {

    @Test
    void registersPostAdminReload() {
        FakePluginContext ctx = new FakePluginContext();
        new ReloadPlugin(() -> { }).start(ctx);

        assertThat(ctx.routes()).hasSize(1);
        RouteSpec route = ctx.routes().get(0);
        assertThat(route.method()).isEqualTo("POST");
        assertThat(route.path()).isEqualTo("/admin/reload");
    }

    @Test
    void answers202WithRestartingBody() {
        FakePluginContext ctx = new FakePluginContext();
        ReloadPlugin plugin = new ReloadPlugin(() -> { });
        plugin.start(ctx);

        HttpResponse response = plugin.handleReload(new FakeHttpRequest("POST", "/admin/reload"));

        assertThat(response.status()).isEqualTo(202);
        assertThat(new String(response.body(), StandardCharsets.UTF_8))
                .isEqualTo("{\"status\":\"restarting\"}");
    }

    @Test
    void defersExitUntilStartupCompleted() throws Exception {
        AtomicInteger exits = new AtomicInteger();
        CountDownLatch exited = new CountDownLatch(1);
        FakePluginContext ctx = new FakePluginContext();
        ReloadPlugin plugin = new ReloadPlugin(() -> {
            exits.incrementAndGet();
            exited.countDown();
        });
        plugin.start(ctx);

        plugin.handleReload(new FakeHttpRequest("POST", "/admin/reload"));

        // Exit must not fire before the on-started guard opens.
        Thread.sleep(ReloadPlugin.EXIT_DELAY_MILLIS + 100);
        assertThat(exits.get()).isZero();

        long armedAt = System.nanoTime();
        ctx.fireStarted();
        assertThat(exited.await(2, TimeUnit.SECONDS))
                .as("delayed exit runs once startup completed")
                .isTrue();
        long elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - armedAt);
        assertThat(elapsedMillis)
                .as("exit fires only after the acknowledgement delay")
                .isGreaterThanOrEqualTo(ReloadPlugin.EXIT_DELAY_MILLIS - 50);
        assertThat(exits.get()).isEqualTo(1);
    }

    @Test
    void schedulesExitOnceWhenAlreadyStarted() throws Exception {
        AtomicInteger exits = new AtomicInteger();
        CountDownLatch exited = new CountDownLatch(1);
        FakePluginContext ctx = new FakePluginContext();
        ReloadPlugin plugin = new ReloadPlugin(() -> {
            exits.incrementAndGet();
            exited.countDown();
        });
        plugin.start(ctx);
        ctx.fireStarted();

        plugin.handleReload(new FakeHttpRequest("POST", "/admin/reload"));
        plugin.handleReload(new FakeHttpRequest("POST", "/admin/reload"));

        assertThat(exited.await(2, TimeUnit.SECONDS))
                .as("delayed exit runs after the request")
                .isTrue();
        Thread.sleep(ReloadPlugin.EXIT_DELAY_MILLIS + 100);
        assertThat(exits.get())
                .as("the exit path is armed exactly once")
                .isEqualTo(1);
    }
}
