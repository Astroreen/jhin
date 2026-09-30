/**
 * The single servlet of the kernel: every incoming request enters here.
 *
 * <p>Dispatch, in order: {@code OPTIONS} is answered with a permissive CORS
 * pre-flight before anything else runs; the exchange is adapted to the SDK
 * request contract and resolved against the route table; a matched route runs
 * through the filter pipeline with the route handler as the terminal link; an
 * unmatched path answers {@code 404} and a wrong method on a known path
 * answers {@code 405}, both in the standard error shape of the SDK response
 * factories.
 * Any failure along the way is logged with its stack trace and answered as a
 * {@code 500} that names only the exception class.
 */
package com.astroreen.jhin.kernel.http;

import com.astroreen.jhin.sdk.http.HttpResponse;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;

public final class JhinServlet extends HttpServlet {

    /** Answered before every other step; the Flutter web build needs it. */
    private static final String PREFLIGHT_METHOD = "OPTIONS";

    private final RouteMatcher matcher;
    private final FilterPipeline filters;
    private final ResponseWriter writer;

    /**
     * Builds the servlet around one registry: its route table resolves
     * requests and its filter pipeline wraps every matched route. Called once
     * at startup by the web wiring.
     *
     * @param registry   the registry holding the routes and filters
     * @param sseHandoff the streaming hand-off, {@code null} for none
     */
    public JhinServlet(HttpRegistryImpl registry, SseHandoff sseHandoff) {
        this(new RouteMatcher(registry.routeTable()), registry.filterPipeline(),
                new ResponseWriter(sseHandoff));
    }

    /**
     * Builds the servlet from its three parts. Exists so tests can assemble
     * the bridge without the registry.
     *
     * @param matcher  the route matcher
     * @param filters  the filter pipeline
     * @param writer   the response writer
     */
    JhinServlet(RouteMatcher matcher, FilterPipeline filters, ResponseWriter writer) {
        this.matcher = matcher;
        this.filters = filters;
        this.writer = writer;
    }

    /**
     * Serves one request through the dispatch order of the class comment.
     * Called by the servlet container on the request thread.
     *
     * @param request  the raw request
     * @param response the raw response
     * @throws IOException when the client connection fails
     */
    @Override
    protected void service(HttpServletRequest request, HttpServletResponse response) throws IOException {
        if (PREFLIGHT_METHOD.equals(request.getMethod())) {
            writer.write(request, response, preflight());
            return;
        }
        RequestImpl adapted = new RequestImpl(request);
        HttpResponse payload;
        try {
            payload = dispatch(adapted);
        } catch (Exception e) {
            writer.writeInternalError(request, response, e);
            return;
        }
        writer.write(request, response, payload);
    }

    /** Resolves the request and runs the matched route through the filters. */
    private HttpResponse dispatch(RequestImpl request) throws Exception {
        RouteMatcher.Resolution resolution = matcher.resolve(request.method(), request.path());
        switch (resolution.status()) {
            case MATCHED -> {
                request.injectPathParams(resolution.pathParams());
                return filters.execute(request, resolution.route().handler());
            }
            case METHOD_NOT_ALLOWED -> {
                return HttpResponse.error(405, "method_not_allowed",
                        "no route allows " + request.method() + " " + request.path());
            }
            default -> {
                return HttpResponse.error(404, "not_found",
                        "no plugin serves " + request.method() + " " + request.path());
            }
        }
    }

    /** The permissive pre-flight answer: 204 and the three CORS headers. */
    private static HttpResponse preflight() {
        return HttpResponse.empty(204)
                .withHeader("Access-Control-Allow-Origin", "*")
                .withHeader("Access-Control-Allow-Headers", "*")
                .withHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    }
}
