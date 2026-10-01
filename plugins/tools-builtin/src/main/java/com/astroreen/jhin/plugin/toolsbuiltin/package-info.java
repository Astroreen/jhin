/**
 * Implementation package of the tools-builtin plugin: the entry point and the
 * built-in tool definitions (ls, write, read, edit, edit-diff, find, grep,
 * bash, powershell) contributed to {@code jhin.agent} through the exported SPI
 * {@code com.astroreen.jhin.plugin.agent.api}.
 *
 * <p>Not exported in the plugin manifest: this plugin contributes services,
 * no types, so its {@code exports} list stays empty. Every tool is pure Java
 * (no external binaries): {@code find}/{@code grep} walk with
 * {@code java.nio.file} and {@code java.util.regex}, diffs use java-diff-utils
 * and shell execution uses zt-exec - both bundled into the plugin jar.
 */
package com.astroreen.jhin.plugin.toolsbuiltin;
