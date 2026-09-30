/**
 * One CLI command registration: name, usage, description and handler.
 *
 * <p>Created by a plugin and handed to
 * {@link CliRegistry#command(CliCommandSpec)}. The kernel uses {@code name}
 * for dispatch and {@code usage} / {@code description} in help output.
 *
 * <p>Components: {@code name} — the command name, matched exactly after
 * {@code cli}; {@code usage} — the one-line usage string; {@code description}
 * — the human-readable description; {@code handler} — the handler to run.
 */
package com.astroreen.jhin.sdk.cli;

public record CliCommandSpec(String name, String usage, String description,
                             CliHandler handler) {}
