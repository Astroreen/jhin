/**
 * Public API of the agent plugin: the tool SPI, the prompt SPI and the two
 * thrown types that carry their failures.
 *
 * <p>This package is the only one exported through the plugin manifest:
 * plugin-to-plugin class sharing works through manifest exports, so a plugin
 * that {@code requires jhin.agent} (for example {@code jhin.tools-builtin},
 * which contributes {@link ToolProvider} definitions) compiles against and
 * resolves these types from the agent class loader at runtime. Nothing
 * outside the exported package may be referenced across plugin boundaries —
 * non-exported classes such as the agent loop itself are invisible and fail
 * with a {@code ClassNotFoundException} naming the plugin.
 *
 * <p>The two SPI chains around one run, implemented by the agent plugin and
 * documented on the participating types: {@link ToolCallGuard} (first block
 * wins) &rarr; {@link ToolDefinition#execute} &rarr;
 * {@link ToolResultTransformer} (a throwing transformer is skipped), and
 * {@link PromptInterceptor} in front of every model call ({@code null} return
 * or {@link PluginVetoException} aborts the run).
 */
package com.astroreen.jhin.plugin.agent.api;
