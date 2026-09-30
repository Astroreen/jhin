/**
 * Implementation package of the agent plugin: the entry point (and, from T33
 * on, the agent loop, prompt builders, run service and tool invoker).
 *
 * <p>Deliberately NOT exported in the plugin manifest: dependants compile
 * against {@code com.astroreen.jhin.plugin.agent.api} only, and every class
 * here stays invisible across the plugin class-loader boundary (the export
 * boundary is proven by {@code AgentExportsTest}).
 */
package com.astroreen.jhin.plugin.agent;
