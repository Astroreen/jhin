/**
 * Scratch consumer fixture for {@code AgentExportsTest}: a class outside the
 * agent plugin that imports the non-exported entry point of the agent plugin,
 * exactly like a dependant that ignores the export boundary.
 *
 * <p>Compiled with the test sources and packed into a fixture jar at test
 * runtime; never loaded through the test class loader itself. Loading it
 * through the kernel's {@code PluginClassLoader} must fail at runtime,
 * because its superclass {@code AgentPlugin} lives outside the exported
 * package {@code com.astroreen.jhin.plugin.agent.api}. T33 extends this
 * fixture to reference {@code com.astroreen.jhin.plugin.agent.AgentLoop} the
 * same way.
 */
package com.scratch;

import com.astroreen.jhin.plugin.agent.AgentPlugin;

public class ScratchTool extends AgentPlugin {}
