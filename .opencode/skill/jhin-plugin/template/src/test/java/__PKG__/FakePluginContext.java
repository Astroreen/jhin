/**
 * Test double of {@link com.astroreen.jhin.sdk.PluginContext} driving the real
 * plugin: records the registered routes and throws on the parts the tests do
 * not touch, so an unexpected registration fails loudly instead of being
 * silently ignored.
 */
package __PKG__;

import com.astroreen.jhin.sdk.ApiVersion;
import com.astroreen.jhin.sdk.ConfigView;
import com.astroreen.jhin.sdk.KernelInfo;
import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.PluginManifest;
import com.astroreen.jhin.sdk.ServiceRegistry;
import com.astroreen.jhin.sdk.cli.CliRegistry;
import com.astroreen.jhin.sdk.db.DbAccess;
import com.astroreen.jhin.sdk.http.HttpRegistry;
import com.astroreen.jhin.sdk.http.RouteSpec;
import com.astroreen.jhin.sdk.stream.StreamRegistry;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

final class FakePluginContext implements PluginContext {

    private final Logger log = LoggerFactory.getLogger("__PLUGIN_ID__");
    private final List<RouteSpec> routes = new ArrayList<>();

    @Override
    public PluginManifest manifest() {
        return new PluginManifest("__PLUGIN_ID__", "0.2.0", ApiVersion.CURRENT,
                "__PLUGIN_NAME__", "test", __PLUGIN_NAME__Plugin.class.getName(),
                List.of(), List.of());
    }

    @Override
    public Logger log() {
        return log;
    }

    @Override
    public Path dataDir() {
        return Path.of("build").resolve("tmp").resolve("__PLUGIN_ID__");
    }

    @Override
    public ConfigView config() {
        throw new UnsupportedOperationException("not under test");
    }

    @Override
    public ServiceRegistry services() {
        throw new UnsupportedOperationException("not under test");
    }

    @Override
    public HttpRegistry http() {
        return new HttpRegistry() {
            @Override
            public void route(RouteSpec spec) {
                routes.add(spec);
            }

            @Override
            public void filter(com.astroreen.jhin.sdk.http.FilterSpec spec) {
                throw new UnsupportedOperationException("not under test");
            }

            @Override
            public void tls(com.astroreen.jhin.sdk.http.TlsProvider provider) {
                throw new UnsupportedOperationException("not under test");
            }
        };
    }

    @Override
    public DbAccess db() {
        throw new UnsupportedOperationException("not under test");
    }

    @Override
    public StreamRegistry streams() {
        throw new UnsupportedOperationException("not under test");
    }

    @Override
    public CliRegistry cli() {
        throw new UnsupportedOperationException("not under test");
    }

    @Override
    public KernelInfo kernel() {
        throw new UnsupportedOperationException("not under test");
    }

    @Override
    public void onStarted(Runnable hook) {
        throw new UnsupportedOperationException("not under test");
    }

    @Override
    public void onShutdown(Runnable hook) {
        throw new UnsupportedOperationException("not under test");
    }

    List<RouteSpec> routes() {
        return List.copyOf(routes);
    }
}
