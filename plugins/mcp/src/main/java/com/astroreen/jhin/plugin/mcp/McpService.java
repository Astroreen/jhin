package com.astroreen.jhin.plugin.mcp;

import com.astroreen.jhin.sdk.json.Json;
import io.modelcontextprotocol.client.McpClient;
import io.modelcontextprotocol.client.McpSyncClient;
import io.modelcontextprotocol.client.transport.HttpClientSseClientTransport;
import io.modelcontextprotocol.client.transport.ServerParameters;
import io.modelcontextprotocol.client.transport.StdioClientTransport;
import io.modelcontextprotocol.json.McpJsonDefaults;
import io.modelcontextprotocol.json.TypeRef;
import io.modelcontextprotocol.spec.McpClientTransport;
import io.modelcontextprotocol.spec.McpSchema;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.function.Consumer;
import java.util.function.Function;
import org.slf4j.Logger;
import reactor.core.publisher.Mono;

/**
 * Starts one MCP client per configured server, lists its remote tools and
 * forwards tool calls to it.
 *
 * <p>Startup contract ({@link #start()}): every server is connected
 * independently. A server that fails to spawn, connect or handshake (including
 * a non-existent command) is SKIPPED with an {@code ERROR} log naming the
 * server and the reason, is recorded in {@link #startFailures()} and never
 * blocks the other servers or fails the plugin. {@link #stop()} closes every
 * transport, which destroys spawned stdio server processes.
 *
 * <p>Call contract ({@link #call}): a remote {@code isError} result or a
 * transport failure is reported as an error outcome with a message - never
 * thrown - so callers observe one surface.
 */
public final class McpService {

    /** Bound on one server's MCP handshake so a broken server can not stall startup. */
    private static final Duration INITIALIZATION_TIMEOUT = Duration.ofSeconds(15);

    /** Bound on one MCP request (initialize, listTools, callTool). */
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(20);

    private final McpConfig config;
    private final Logger log;
    private final Map<String, McpSyncClient> clients = new LinkedHashMap<>();
    private final List<RemoteTool> tools = new ArrayList<>();
    private final Map<String, String> startFailures = new LinkedHashMap<>();

    /**
     * Creates the service for one parsed configuration.
     *
     * @param config the configured servers, never {@code null}
     * @param log    the plugin logger, never {@code null}
     */
    public McpService(McpConfig config, Logger log) {
        this.config = config;
        this.log = log;
    }

    /**
     * Connects every configured server, performs the MCP handshake on it and
     * registers its tools. Per-server failures are logged as {@code ERROR},
     * recorded in {@link #startFailures()} and skipped.
     */
    public void start() {
        for (McpConfig.Server server : config.servers()) {
            try {
                startServer(server);
            } catch (Exception e) {
                String reason = describe(e);
                log.error("mcp server '{}' failed to start and was skipped: {}", server.name(), reason);
                startFailures.put(server.name(), reason);
            }
        }
    }

    /**
     * The remote tools discovered so far, in server and discovery order.
     *
     * @return an unmodifiable snapshot of the registered tools
     */
    public List<RemoteTool> tools() {
        return List.copyOf(tools);
    }

    /**
     * The servers that failed to start, mapped to their failure reason.
     *
     * @return an unmodifiable snapshot, in configuration order
     */
    public Map<String, String> startFailures() {
        return Map.copyOf(startFailures);
    }

    /**
     * Forwards one {@code tools/call} to the owning server and maps the
     * result. Never throws: transport failures and remote {@code isError}
     * results come back as error outcomes.
     *
     * @param server    the server name owning the tool
     * @param tool      the remote tool name
     * @param arguments the call arguments, possibly empty
     * @return the mapped result, never {@code null}
     */
    public RemoteCallResult call(String server, String tool, Map<String, Object> arguments) {
        McpSyncClient client = clients.get(server);
        if (client == null) {
            return RemoteCallResult.failure("MCP server '" + server + "' is not connected");
        }
        try {
            McpSchema.CallToolResult result = client.callTool(new McpSchema.CallToolRequest(tool, arguments, null));
            String text = joinText(result.content());
            String structured = result.structuredContent() != null ? Json.write(result.structuredContent()) : null;
            if (Boolean.TRUE.equals(result.isError())) {
                return RemoteCallResult.failure(text.isBlank()
                        ? "MCP tool '" + server + "/" + tool + "' failed" : text);
            }
            return new RemoteCallResult(false, text, structured);
        } catch (Exception e) {
            return RemoteCallResult.failure(
                    "MCP tool '" + server + "/" + tool + "' call failed: " + describe(e));
        }
    }

    /**
     * Closes every client transport (destroying spawned stdio server
     * processes) and forgets the registered tools. Idempotent.
     */
    public void stop() {
        for (Map.Entry<String, McpSyncClient> entry : clients.entrySet()) {
            try {
                McpSyncClient client = entry.getValue();
                if (!client.closeGracefully()) {
                    client.close();
                }
            } catch (Exception e) {
                log.warn("mcp server '{}' failed to close cleanly: {}", entry.getKey(), describe(e));
            }
        }
        clients.clear();
        tools.clear();
    }

    /**
     * Connects one server: transport, client, handshake, tool listing.
     *
     * @param server the server spec
     * @throws Exception when the spawn, connection or handshake fails; the
     *                   caller logs and skips the server
     */
    private void startServer(McpConfig.Server server) throws Exception {
        McpClientTransport transport = new ConnectGuardTransport(buildTransport(server));
        McpSyncClient client = McpClient.sync(transport)
                .clientInfo(McpSchema.Implementation.builder("Jhin", "0.2.0").build())
                .requestTimeout(REQUEST_TIMEOUT)
                .initializationTimeout(INITIALIZATION_TIMEOUT)
                .build();
        try {
            client.initialize();
            McpSchema.ListToolsResult listed = client.listTools();
            clients.put(server.name(), client);
            for (McpSchema.Tool tool : listed.tools()) {
                String label = tool.title() == null || tool.title().isBlank() ? tool.name() : tool.title();
                String description = tool.description() == null || tool.description().isBlank()
                        ? "MCP tool '" + tool.name() + "' of server '" + server.name() + "'"
                        : tool.description();
                tools.add(new RemoteTool(server.name(), tool.name(), label, description, tool.inputSchema()));
            }
            log.info("mcp server '{}' connected ({}): {} tool(s)",
                    server.name(), server.transport(), listed.tools().size());
        } catch (Exception e) {
            closeQuietly(server.name(), client);
            throw e;
        }
    }

    /**
     * Builds the client transport of one server: a spawned stdio program or an
     * SSE endpoint.
     *
     * <p>The SDK marks {@link HttpClientSseClientTransport} deprecated because
     * the MCP specification renamed the old HTTP+SSE transport to a
     * backwards-compatibility case of streamable HTTP; user-declared SSE
     * servers are still in the wild and the declared schema is
     * {@code stdio|sse}, so the legacy transport stays supported here.
     *
     * @param server the server spec
     * @return the transport
     */
    @SuppressWarnings("deprecation")
    private static McpClientTransport buildTransport(McpConfig.Server server) {
        if (server.isStdio()) {
            ServerParameters params = ServerParameters.builder(server.command())
                    .args(server.args())
                    .env(server.env())
                    .build();
            return new StdioClientTransport(params, McpJsonDefaults.getMapper());
        }
        return HttpClientSseClientTransport.builder(server.url()).build();
    }

    /**
     * Closes a half-started client without propagating close failures.
     *
     * @param name   the server name (for the log)
     * @param client the client to close
     */
    private void closeQuietly(String name, McpSyncClient client) {
        try {
            client.close();
        } catch (Exception e) {
            log.warn("mcp server '{}' failed to close after a start error: {}", name, describe(e));
        }
    }

    /**
     * Joins the text content items of one remote result. Non-text items
     * (images and friends) are left out of the text surface.
     *
     * @param content the result content items
     * @return the joined text, possibly empty
     */
    private static String joinText(List<McpSchema.Content> content) {
        StringBuilder text = new StringBuilder();
        for (McpSchema.Content item : content) {
            if (item instanceof McpSchema.TextContent textContent) {
                if (text.length() > 0) {
                    text.append('\n');
                }
                text.append(textContent.text());
            }
        }
        return text.toString();
    }

    /**
     * Renders one failure as the whole cause chain,
     * {@code <class>: <message> <- <class>: <message> ...}, unwrapping the
     * reactive/transport wrappers so the log names the real cause and keeps
     * the useful outer messages (for example the failing command line).
     *
     * @param e the failure
     * @return the one-line description
     */
    private static String describe(Throwable e) {
        StringBuilder text = new StringBuilder();
        for (Throwable current = e; current != null;
                current = current.getCause() == current ? null : current.getCause()) {
            if (text.length() > 0) {
                text.append(" <- ");
            }
            text.append(current.getClass().getSimpleName());
            String message = current.getMessage();
            if (message != null && !message.isBlank()) {
                text.append(": ").append(message);
            }
        }
        return text.toString();
    }

    /**
     * One remote tool discovered on a server.
     *
     * @param server      the owning server name
     * @param name        the remote tool name
     * @param label       the display label (remote title, else the name)
     * @param description the tool description (never blank)
     * @param inputSchema the JSON Schema of the arguments, as a map
     */
    public record RemoteTool(String server, String name, String label, String description,
                             Map<String, Object> inputSchema) {
    }

    /**
     * The mapped outcome of one remote {@code tools/call}.
     *
     * @param error      {@code true} when the call failed remotely or the
     *                   transport failed
     * @param text       the conversation text, never {@code null}
     * @param structured optional JSON text of the remote
     *                   {@code structuredContent}, {@code null} when absent
     */
    public record RemoteCallResult(boolean error, String text, String structured) {

        /**
         * An error outcome with just a message.
         *
         * @param message the failure description, never {@code null}
         * @return the error outcome
         */
        static RemoteCallResult failure(String message) {
            return new RemoteCallResult(true, message, null);
        }
    }

    /**
     * Wraps the SDK transport so a failed {@code connect} (a non-existent
     * command, an unreachable endpoint) surfaces from the first
     * {@code sendMessage} instead of being swallowed by the SDK's async
     * connect hook and re-surfacing as a request timeout.
     */
    private static final class ConnectGuardTransport implements McpClientTransport {

        private final McpClientTransport delegate;
        private final CompletableFuture<Void> connectOutcome = new CompletableFuture<>();

        ConnectGuardTransport(McpClientTransport delegate) {
            this.delegate = delegate;
        }

        @Override
        public Mono<Void> connect(Function<Mono<McpSchema.JSONRPCMessage>, Mono<McpSchema.JSONRPCMessage>> handler) {
            return delegate.connect(handler)
                    .doOnSuccess(ignored -> connectOutcome.complete(null))
                    .doOnError(connectOutcome::completeExceptionally);
        }

        @Override
        public Mono<Void> sendMessage(McpSchema.JSONRPCMessage message) {
            return Mono.fromFuture(connectOutcome, true).then(Mono.defer(() -> delegate.sendMessage(message)));
        }

        @Override
        public Mono<Void> closeGracefully() {
            return delegate.closeGracefully();
        }

        @Override
        public List<String> protocolVersions() {
            return delegate.protocolVersions();
        }

        @Override
        public <T> T unmarshalFrom(Object data, TypeRef<T> typeRef) {
            return delegate.unmarshalFrom(data, typeRef);
        }

        @Override
        public void setExceptionHandler(Consumer<Throwable> handler) {
            delegate.setExceptionHandler(handler);
        }
    }
}
