/**
 * Model Context Protocol (MCP) client plugin: remote tools contributed by
 * user-declared MCP servers.
 *
 * <p>The plugin reads {@code $JHIN_HOME/mcp.json} (see {@link McpConfig} for
 * the schema), starts one MCP client per declared server through the official
 * Java MCP SDK (stdio and SSE transports, see {@link McpService}) and exposes
 * every remote tool as a {@code jhin.agent} {@code ToolDefinition} named
 * {@code mcp__<server>__<tool>} (see {@link McpToolProvider}).
 *
 * <p>Declaring external MCP servers is the very purpose of this plugin: the
 * servers are user-provided programs or endpoints, not product tools, so the
 * zero-external-binaries rule of the built-in tool set does not apply here.
 */
package com.astroreen.jhin.plugin.mcp;
