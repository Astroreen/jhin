package com.astroreen.jhin.kernel.cli;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.kernel.loader.PluginLifecycle;
import com.astroreen.jhin.sdk.cli.CliCommandSpec;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class CliDispatcherTest {

    private final ByteArrayOutputStream outBytes = new ByteArrayOutputStream();
    private final ByteArrayOutputStream errBytes = new ByteArrayOutputStream();
    private final PrintStream out = new PrintStream(outBytes, true, StandardCharsets.UTF_8);
    private final PrintStream err = new PrintStream(errBytes, true, StandardCharsets.UTF_8);

    @Test
    void emptyBookPrintsNoCommandsAndExitsTwo() {
        int code = CliDispatcher.dispatch(List.of(), List.of(), out, err);

        assertThat(code).isEqualTo(2);
        assertThat(stdout()).isEqualTo("no commands registered" + System.lineSeparator());
        assertThat(stderr()).isEmpty();
    }

    @Test
    void bareVerbListsEveryCommand() {
        int code = CliDispatcher.dispatch(List.of(entry("jhin.a", "alpha", "usage-a", "desc-a"),
                entry("jhin.b", "beta", "usage-b", "desc-b")), List.of(), out, err);

        assertThat(code).isEqualTo(0);
        assertThat(stdout()).isEqualTo(
                "alpha  usage-a  desc-a" + System.lineSeparator()
                        + "beta  usage-b  desc-b" + System.lineSeparator());
        assertThat(stderr()).isEmpty();
    }

    @Test
    void knownCommandRunsAndExitsWithItsCode() {
        List<String> received = new ArrayList<>();
        PluginLifecycle.CommandEntry entry = new PluginLifecycle.CommandEntry("jhin.a",
                new CliCommandSpec("alpha", "usage-a", "desc-a", (args, o, e) -> {
                    received.addAll(args);
                    o.print("ran");
                    return 7;
                }));

        int code = CliDispatcher.dispatch(List.of(entry), List.of("alpha", "one", "two"), out, err);

        assertThat(code).isEqualTo(7);
        assertThat(received).containsExactly("one", "two");
        assertThat(stdout()).isEqualTo("ran");
        assertThat(stderr()).isEmpty();
    }

    @Test
    void unknownCommandListsAndExitsTwo() {
        int code = CliDispatcher.dispatch(List.of(entry("jhin.a", "alpha", "usage-a", "desc-a")),
                List.of("nope"), out, err);

        assertThat(code).isEqualTo(2);
        assertThat(stdout()).isEqualTo("alpha  usage-a  desc-a" + System.lineSeparator());
        assertThat(stderr()).isEqualTo("unknown command: nope" + System.lineSeparator());
    }

    @Test
    void failingHandlerExitsOneWithTheReason() {
        PluginLifecycle.CommandEntry entry = new PluginLifecycle.CommandEntry("jhin.a",
                new CliCommandSpec("alpha", "usage-a", "desc-a", (args, o, e) -> {
                    throw new IllegalStateException("kaboom");
                }));

        int code = CliDispatcher.dispatch(List.of(entry), List.of("alpha"), out, err);

        assertThat(code).isEqualTo(1);
        assertThat(stderr()).isEqualTo("command alpha failed: kaboom" + System.lineSeparator());
    }

    @Test
    void blankUsageAndDescriptionAreOmittedFromTheList() {
        int code = CliDispatcher.dispatch(List.of(entry("jhin.a", "alpha", " ", "")),
                List.of(), out, err);

        assertThat(code).isEqualTo(0);
        assertThat(stdout()).isEqualTo("alpha" + System.lineSeparator());
    }

    private static PluginLifecycle.CommandEntry entry(String pluginId, String name,
            String usage, String description) {
        return new PluginLifecycle.CommandEntry(pluginId,
                new CliCommandSpec(name, usage, description, (args, o, e) -> 0));
    }

    private String stdout() {
        return outBytes.toString(StandardCharsets.UTF_8);
    }

    private String stderr() {
        return errBytes.toString(StandardCharsets.UTF_8);
    }
}
