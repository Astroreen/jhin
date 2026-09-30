/**
 * Runs one CLI command.
 *
 * <p>Implemented by a plugin and registered with a {@link CliCommandSpec}
 * through {@link CliRegistry#command(CliCommandSpec)}. The kernel invokes it
 * when {@code java -jar jhin-kernel.jar cli <name> [args...]} matches the
 * spec's name; the process exit code is the handler's return value.
 */
package com.astroreen.jhin.sdk.cli;

import java.io.PrintStream;
import java.util.List;

public interface CliHandler {

    /**
     * Runs the command. Called by the kernel on the CLI dispatch thread.
     *
     * @param args the command arguments after the command name
     * @param out  the standard output stream
     * @param err  the standard error stream
     * @return the process exit code
     */
    int run(List<String> args, PrintStream out, PrintStream err);
}
