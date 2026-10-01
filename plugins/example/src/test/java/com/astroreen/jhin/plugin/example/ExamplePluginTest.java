/**
 * Unit tests for {@link ExamplePlugin}: every surface registers with the right
 * contract and the status route reports the observable counts. The agent SPI
 * is on the test class path, so the tool path is the registered one; the
 * zero-tool path is covered by the QA script without jhin.agent.
 */
package com.astroreen.jhin.plugin.example;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.groups.Tuple.tuple;

import com.astroreen.jhin.plugin.agent.api.ToolProvider;
import com.astroreen.jhin.sdk.cli.CliCommandSpec;
import com.astroreen.jhin.sdk.db.MigrationSpec;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.http.RouteSpec;
import com.astroreen.jhin.sdk.stream.StreamEvent;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;

final class ExamplePluginTest {

    /** Invokes the registered status route handler. */
    private static HttpResponse callStatus(FakePluginContext ctx) throws Exception {
        return ctx.routes().get(0).handler().handle(new FakeHttpRequest("GET", "/example/status"));
    }

    @Test
    void registersRouteCliAndMigration() throws Exception {
        FakePluginContext ctx = new FakePluginContext();
        new ExamplePlugin().start(ctx);

        assertThat(ctx.routes())
                .extracting(RouteSpec::method, RouteSpec::path)
                .containsExactly(
                        tuple("GET", "/example/status"),
                        tuple("GET", "/example/stream"));
        assertThat(ctx.commands())
                .extracting(CliCommandSpec::name)
                .containsExactly("example-hello");

        assertThat(ctx.migrations()).hasSize(1);
        MigrationSpec migration = ctx.migrations().get(0);
        assertThat(migration.version()).isEqualTo(1);
        assertThat(migration.sql()).startsWith("CREATE TABLE IF NOT EXISTS jhin_example_");
        assertThat(migration.sql()).contains("jhin_example_notes");
    }

    @Test
    void publishesReadyAtStartAndStatusPerCall() throws Exception {
        FakePluginContext ctx = new FakePluginContext();
        new ExamplePlugin().start(ctx);

        ctx.fireStarted();
        List<StreamEvent> ready = ctx.streams().published(ExamplePlugin.TOPIC);
        assertThat(ready).hasSize(1);
        assertThat(ready.get(0).type()).isEqualTo("example_ready");

        HttpResponse response = callStatus(ctx);
        assertThat(response.status()).isEqualTo(200);
        String body = new String(response.body(), StandardCharsets.UTF_8);
        assertThat(body).contains("\"events\":2");
        assertThat(body).contains("\"topic\":\"" + ExamplePlugin.TOPIC + "\"");

        assertThat(ctx.streams().published(ExamplePlugin.TOPIC))
                .extracting(StreamEvent::type)
                .containsExactly("example_ready", "example_status");
    }

    @Test
    void registersOneToolWhenAgentApiResolves() throws Exception {
        FakePluginContext ctx = new FakePluginContext();
        new ExamplePlugin().start(ctx);

        ToolProvider provider = ctx.published(ToolProvider.class);
        assertThat(provider).as("tool provider published to the service registry").isNotNull();
        assertThat(provider.tools()).hasSize(1);
        assertThat(provider.tools().get(0).name()).isEqualTo("example_echo");

        String body = new String(callStatus(ctx).body(), StandardCharsets.UTF_8);
        assertThat(body).contains("\"tools\":1");
    }

    @Test
    void cliHelloGreetsAndReturnsZero() throws Exception {
        FakePluginContext ctx = new FakePluginContext();
        new ExamplePlugin().start(ctx);

        CliCommandSpec command = ctx.commands().get(0);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int exitCode = command.handler().run(
                List.of("qa"), new PrintStream(out), new PrintStream(new ByteArrayOutputStream()));

        assertThat(exitCode).isZero();
        assertThat(out.toString(StandardCharsets.UTF_8))
                .isEqualTo("hello, qa" + System.lineSeparator());
    }

    @Test
    void streamEndpointServesTheTopicOverSse() throws Exception {
        FakePluginContext ctx = new FakePluginContext();
        new ExamplePlugin().start(ctx);

        RouteSpec stream = ctx.routes().get(1);
        HttpResponse response = stream.handler().handle(
                new FakeHttpRequest("GET", "/example/stream"));
        assertThat(response.status()).isEqualTo(200);
        assertThat(ctx.streams().sseRequests())
                .extracting(RecordingStreamRegistry.SseRequest::topic)
                .containsExactly(ExamplePlugin.TOPIC);
    }

    @Test
    void statusPayloadCarriesPluginIdentity() throws Exception {
        FakePluginContext ctx = new FakePluginContext();
        new ExamplePlugin().start(ctx);

        assertThat(new String(callStatus(ctx).body(), StandardCharsets.UTF_8))
                .contains("\"plugin\":\"jhin.example\"");
    }
}
