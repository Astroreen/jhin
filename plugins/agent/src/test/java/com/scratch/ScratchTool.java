/**
 * Scratch consumer fixture for {@code AgentExportsTest}: a class outside the
 * agent plugin that imports the non-exported entry point of the agent plugin
 * ({@code AgentPlugin} as its superclass and {@code AgentLoop} in a method
 * signature), exactly like a dependant that ignores the export boundary.
 *
 * <p>Compiled with the test sources and packed into a fixture jar at test
 * runtime; never loaded through the test class loader itself. Loading it
 * through the kernel's {@code PluginClassLoader} must fail at runtime,
 * because its superclass {@code AgentPlugin} lives outside the exported
 * package {@code com.astroreen.jhin.plugin.agent.api}; the test asserts the
 * same boundary for {@code AgentLoop} with a direct class lookup.
 */
package com.scratch;

import com.astroreen.jhin.plugin.agent.AgentLoop;
import com.astroreen.jhin.plugin.agent.AgentPlugin;

public class ScratchTool extends AgentPlugin {

    /**
     * References the non-exported agent loop the way T32's plan named it.
     *
     * @param loop the invisible class
     */
    public void touch(AgentLoop loop) {
    }
}
