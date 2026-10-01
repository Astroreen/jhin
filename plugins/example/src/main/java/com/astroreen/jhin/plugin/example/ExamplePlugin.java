/**
 * The Jhin reference plugin: a copy-paste template that exercises every
 * extension surface of the SDK in one small, heavily commented file.
 *
 * <p>The five surfaces demonstrated here, in the order they appear in
 * {@link #start}: (3) a migration creating one prefixed table, (1) an HTTP
 * route, (4) a stream publisher with its SSE endpoint, (2) a CLI command and
 * (5) an optional tool provider contributed only when the {@code jhin.agent}
 * plugin is loaded. Copy this file, rename the plugin id and the table prefix
 * takes care of itself ({@link com.astroreen.jhin.sdk.db.DbAccess#tablePrefix}).
 */
package com.astroreen.jhin.plugin.example;

import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.cli.CliCommandSpec;
import com.astroreen.jhin.sdk.db.MigrationSpec;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.http.RouteSpec;
import com.astroreen.jhin.sdk.stream.StreamEvent;
import java.io.PrintStream;
import java.sql.PreparedStatement;
import java.util.List;
import java.util.Map;

public final class ExamplePlugin implements JhinPlugin {

    /** Stream topic every demo event is published on (surface 4). */
    static final String TOPIC = "example/events";

    /** Table name suffix; the full name is the plugin table prefix + this. */
    static final String TABLE_SUFFIX = "notes";

    /** Exported API class of jhin.agent; resolves only when it is loaded. */
    static final String AGENT_API = "com.astroreen.jhin.plugin.agent.api.ToolProvider";

    /** Plugin context, remembered for the request-time handlers. */
    private PluginContext ctx;

    /** Tools contributed (0 or 1); reported by the status route. */
    private int tools;

    /** Stream events published so far; reported by the status route. */
    private int events;

    @Override
    public void start(PluginContext ctx) throws Exception {
        this.ctx = ctx;

        // SURFACE 3 — migration + table. Applied idempotently at every start;
        // the kernel rejects the migration unless every created table starts
        // with this plugin's prefix, so build names from tablePrefix().
        ctx.db().migrate(List.of(new MigrationSpec(1, "CREATE TABLE IF NOT EXISTS "
                + ctx.db().tablePrefix() + TABLE_SUFFIX
                + " (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL,"
                + " created_at INTEGER NOT NULL)")));

        // SURFACE 1 — route. Registered before the HTTP server starts; the
        // status handler doubles as the QA observation point (tool count and
        // published-event count) and publishes one event per call so the
        // stream surface is observable end to end.
        ctx.http().route(new RouteSpec("GET", "/example/status", this::status));

        // SURFACE 4 — stream publisher. One event at startup plus one per
        // status call; GET /example/stream serves the topic over SSE so the
        // events can be observed live (see README.md).
        ctx.http().route(new RouteSpec("GET", "/example/stream",
                req -> ctx.streams().sse(TOPIC, writer -> { })));
        ctx.onStarted(() -> publish("example_ready"));

        // SURFACE 2 — CLI command. Dispatched as
        // `java -jar <kernel.jar> cli example-hello [name]`; the returned int
        // becomes the process exit code.
        ctx.cli().command(new CliCommandSpec("example-hello", "example-hello [name]",
                "prints a greeting", this::hello));

        // SURFACE 5 — optional ToolProvider. Probed by API class name (the
        // jhin.ui Integrations pattern): the agent SPI resolves only when the
        // jhin.agent plugin is loaded, and the provider class is loaded only
        // behind that probe so this plugin starts cleanly without the agent.
        if (present(AGENT_API)) {
            tools = ExampleToolProvider.register(ctx);
            ctx.log().info("jhin.agent present: registered {} tool(s)", tools);
        } else {
            ctx.log().info("jhin.agent absent: contributing no tools");
        }
    }

    /** (a) The status route: observability plus one demo event per call. */
    private HttpResponse status(HttpRequest req) {
        publish("example_status");
        return HttpResponse.json(200, Map.<String, Object>of(
                "plugin", "jhin.example",
                "tools", tools,
                "events", events,
                "topic", TOPIC));
    }

    /** (b) The CLI command: one greeting line and exit code 0. */
    private int hello(List<String> args, PrintStream out, PrintStream err) {
        out.println("hello, " + (args.isEmpty() ? "world" : args.get(0)));
        return 0;
    }

    /**
     * (d) Publishes one stream event and records it as a note row, so the
     * event is observable both live (SSE) and after the fact (table/counts).
     */
    private void publish(String type) {
        events++;
        ctx.db().write(connection -> {
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO " + ctx.db().tablePrefix() + TABLE_SUFFIX
                            + " (note, created_at) VALUES (?, ?)")) {
                insert.setString(1, type);
                insert.setLong(2, System.currentTimeMillis());
                insert.executeUpdate();
            }
            return null;
        });
        ctx.streams().publish(TOPIC, new StreamEvent(type, Map.of("note", type)));
    }

    /**
     * Whether the plugin exporting the named API class is loaded; the probe
     * pattern of jhin.ui's Integrations class, copied so this template stays
     * self-contained.
     */
    private static boolean present(String className) {
        try {
            Class.forName(className);
            return true;
        } catch (ClassNotFoundException | LinkageError e) {
            return false;
        }
    }
}
