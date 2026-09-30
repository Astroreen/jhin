/**
 * The command-line dispatch: verb handling, listing and exit codes.
 *
 * <p>{@code cli} without a command name lists every registered command;
 * {@code cli <name> [args]} runs the handler of that command and exits with
 * its return code. An unknown name exits with {@link #EXIT_UNKNOWN} after
 * printing the list, and a kernel without any registered command answers
 * {@code no commands registered} with the same exit code. The commands come
 * from the command book of the plugin load pass, each already tagged with its
 * owning plugin.
 */
package com.astroreen.jhin.kernel.cli;

import com.astroreen.jhin.kernel.loader.PluginLifecycle;
import com.astroreen.jhin.sdk.cli.CliCommandSpec;
import java.io.PrintStream;
import java.util.List;
import java.util.Objects;

public final class CliDispatcher {

    /** Exit code of a command that ran to completion and of a bare listing. */
    public static final int EXIT_OK = 0;

    /** Exit code of a command whose handler failed while running. */
    public static final int EXIT_FAILED = 1;

    /** Exit code of an unknown command and of an empty command book. */
    public static final int EXIT_UNKNOWN = 2;

    /** Not instantiable; all access is static. */
    private CliDispatcher() {
    }

    /**
     * Dispatches one command-line invocation against the registered commands.
     *
     * @param commands the registered commands with their owners
     * @param args     the arguments after the {@code cli} verb: the command
     *                 name first, then its own arguments
     * @param out      the standard output stream
     * @param err      the standard error stream
     * @return the process exit code
     */
    public static int dispatch(List<PluginLifecycle.CommandEntry> commands, List<String> args,
            PrintStream out, PrintStream err) {
        Objects.requireNonNull(commands, "commands");
        Objects.requireNonNull(args, "args");
        Objects.requireNonNull(out, "out");
        Objects.requireNonNull(err, "err");
        if (commands.isEmpty()) {
            out.println("no commands registered");
            return EXIT_UNKNOWN;
        }
        if (args.isEmpty()) {
            list(commands, out);
            return EXIT_OK;
        }
        String name = args.get(0);
        for (PluginLifecycle.CommandEntry entry : commands) {
            if (entry.spec().name().equals(name)) {
                return run(entry, args.subList(1, args.size()), out, err);
            }
        }
        err.println("unknown command: " + name);
        list(commands, out);
        return EXIT_UNKNOWN;
    }

    /** Runs one handler; a failure is reported on the error stream. */
    private static int run(PluginLifecycle.CommandEntry entry, List<String> args,
            PrintStream out, PrintStream err) {
        try {
            return entry.spec().handler().run(args, out, err);
        } catch (Throwable failure) {
            err.println("command " + entry.spec().name() + " failed: " + reasonOf(failure));
            return EXIT_FAILED;
        }
    }

    /** Prints one line per command: name, usage and description. */
    private static void list(List<PluginLifecycle.CommandEntry> commands, PrintStream out) {
        for (PluginLifecycle.CommandEntry entry : commands) {
            out.println(line(entry.spec()));
        }
    }

    /** One printable command line: the name, then the optional detail fields. */
    private static String line(CliCommandSpec spec) {
        StringBuilder line = new StringBuilder(spec.name());
        if (spec.usage() != null && !spec.usage().isBlank()) {
            line.append("  ").append(spec.usage());
        }
        if (spec.description() != null && !spec.description().isBlank()) {
            line.append("  ").append(spec.description());
        }
        return line.toString();
    }

    /** The detail of a failure: its text, or its class name when it carries none. */
    private static String reasonOf(Throwable failure) {
        String text = failure.getMessage();
        return (text == null || text.isBlank()) ? failure.getClass().getName() : text;
    }
}
