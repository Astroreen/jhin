/**
 * Route example of {@code __PLUGIN_ID__}: one GET endpoint answering a small
 * JSON identity payload. Every route of a plugin is prefixed with its module
 * name (derived from the plugin id below), so two plugins can never collide on
 * a path.
 */
package __PKG__;

import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.http.RouteSpec;
import java.util.List;
import java.util.Map;

final class Routes {

    private Routes() {
    }

    /**
     * Registers every route of this plugin. Called from
     * {@code __PLUGIN_NAME__Plugin#start} while the kernel still accepts
     * registrations.
     *
     * @param ctx the plugin context handed to start
     */
    static void install(PluginContext ctx) {
        ctx.http().route(new RouteSpec("GET", prefix(ctx) + "/ping", Routes::ping));
    }

    /**
     * Path prefix of every route of this plugin: {@code /<module>} of the
     * skill's naming table — the id suffix with dots turned into dashes, so
     * {@code __PLUGIN_ID__} serves {@code GET /<module>/ping}.
     *
     * @param ctx the plugin context
     * @return the route prefix, with a leading slash and no trailing slash
     */
    static String prefix(PluginContext ctx) {
        String id = ctx.manifest().id();
        int cut = id.indexOf('.');
        String suffix = (cut < 0 ? id : id.substring(cut + 1));
        return "/" + suffix.replace('.', '-');
    }

    /**
     * The ping handler. Answers 200 with the plugin identity; an empty
     * {@code ?name=} is refused with 400 naming the problem.
     *
     * @param req the matched request
     * @return the response
     */
    static HttpResponse ping(HttpRequest req) {
        String name = first(req, "name");
        if (name != null && name.isBlank()) {
            return HttpResponse.error(400, "invalid_name", "name must not be blank");
        }
        return HttpResponse.json(200, Map.<String, Object>of(
                "plugin", "__PLUGIN_ID__",
                "ok", true,
                "greeting", name == null ? "ping" : "hello, " + name));
    }

    private static String first(HttpRequest req, String key) {
        List<String> values = req.query().get(key);
        return (values == null || values.isEmpty()) ? null : values.get(0);
    }
}
