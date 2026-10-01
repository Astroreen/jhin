/**
 * The restart hook of a Jhin installation: one route that asks the host to
 * exit so an external restart loop can bring it back up with a fresh process
 * and freshly loaded plugins.
 *
 * <p>The plugin is deliberately tiny and carries no dependencies. The restart
 * loop itself lives outside the JVM ({@code deploy/run.sh} or a systemd unit
 * with {@code Restart=always}); this plugin only owns the request/response
 * contract and the delayed exit.
 */
package com.astroreen.jhin.plugin.reload;

import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.http.RouteSpec;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Registers {@code POST /admin/reload}: answers {@code 202}
 * {@code {"status":"restarting"}} and exits the JVM with code {@code 0} after
 * {@link #EXIT_DELAY_MILLIS} so the 202 response reaches the client first.
 *
 * <p>Exit scheduling is on-started-guarded: the delayed exit can only be
 * armed after the kernel finished startup ({@link PluginContext#onStarted}),
 * so a request racing the boot can never tear down a half-started host. The
 * delay runs on a fresh daemon thread that simply sleeps before invoking the
 * exit action; a daemon thread cannot keep the JVM alive on its own and the
 * approach needs no scheduler. The exit action is a constructor seam: the
 * production default is {@code System.exit(0)}, tests inject a stub so the exit
 * path runs without ending the test JVM.
 */
public final class ReloadPlugin implements JhinPlugin {

    /** Delay between the accepted request and the JVM exit, in milliseconds. */
    static final long EXIT_DELAY_MILLIS = 300;

    /** The action that ends the process; injectable so tests never exit. */
    private final Runnable exitAction;

    /** Flipped once the kernel reports startup completed. */
    private final AtomicBoolean started = new AtomicBoolean();

    /** Flipped when a restart was requested, before or after startup. */
    private final AtomicBoolean restartRequested = new AtomicBoolean();

    /** Guards the exit path so only one delayed exit is ever armed. */
    private final AtomicBoolean exitScheduled = new AtomicBoolean();

    /** Production entry point: restart means {@code System.exit(0)}. */
    public ReloadPlugin() {
        this(() -> System.exit(0));
    }

    /**
     * Testable entry point over an explicit exit action.
     *
     * @param exitAction the action to run when the delayed exit fires
     */
    ReloadPlugin(Runnable exitAction) {
        this.exitAction = exitAction;
    }

    @Override
    public void start(PluginContext ctx) {
        ctx.http().route(new RouteSpec("POST", "/admin/reload", this::handleReload));
        ctx.onStarted(() -> {
            started.set(true);
            scheduleExitIfRequested();
        });
    }

    /**
     * Answers one restart request: remembers it, arms the delayed exit when
     * startup already completed and always acknowledges with
     * {@code 202 {"status":"restarting"}}.
     *
     * @param req the matched request
     * @return the 202 acknowledgement
     */
    HttpResponse handleReload(HttpRequest req) {
        restartRequested.set(true);
        scheduleExitIfRequested();
        return HttpResponse.json(202, Map.of("status", "restarting"));
    }

    /**
     * Arms the delayed exit once both conditions hold: startup completed and a
     * restart was requested. The compare-and-set keeps the exit one-shot even
     * when the request and the on-started hook race each other.
     */
    private void scheduleExitIfRequested() {
        if (started.get() && restartRequested.get() && exitScheduled.compareAndSet(false, true)) {
            Thread delayer = new Thread(this::exitAfterDelay, "jhin-reload-exit");
            delayer.setDaemon(true);
            delayer.start();
        }
    }

    /** Sleeps the acknowledgement window, then runs the exit action. */
    private void exitAfterDelay() {
        try {
            Thread.sleep(EXIT_DELAY_MILLIS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return;
        }
        exitAction.run();
    }
}
