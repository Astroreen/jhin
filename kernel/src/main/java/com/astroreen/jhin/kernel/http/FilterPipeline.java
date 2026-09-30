/**
 * Runs the registered request filters around one matched route handler.
 *
 * <p>Filters run in ascending {@code (FilterSpec.order)}, ties broken by the
 * id of the plugin that registered them; only filters whose
 * {@code pathPrefix} matches the request path take part. The chain is built
 * per request so a filter sees exactly the remainder that follows it, with the
 * route handler as the terminal link; a filter that returns without calling
 * {@link com.astroreen.jhin.sdk.http.FilterChain#proceed} short-circuits, and
 * its response is sent as-is. A filter that throws propagates to the caller,
 * which maps the failure to a {@code 500} response.
 */
package com.astroreen.jhin.kernel.http;

import com.astroreen.jhin.sdk.http.FilterSpec;
import com.astroreen.jhin.sdk.http.HttpFilter;
import com.astroreen.jhin.sdk.http.HttpHandler;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.CopyOnWriteArrayList;

public final class FilterPipeline {

    /** Runs after every filter, in {@code (order, pluginId)} order. */
    private static final Comparator<Entry> RUN_ORDER =
            Comparator.comparingInt((Entry entry) -> entry.spec().order())
                    .thenComparing(Entry::pluginId);

    private final List<Entry> entries = new CopyOnWriteArrayList<>();

    /**
     * Registers one filter. Called once per registration, before the HTTP
     * listener starts.
     *
     * @param spec     the filter to register
     * @param pluginId id of the plugin that owns the filter
     */
    public void add(FilterSpec spec, String pluginId) {
        Objects.requireNonNull(spec, "spec");
        Objects.requireNonNull(pluginId, "pluginId");
        entries.add(new Entry(spec, pluginId));
    }

    /**
     * Whether no filter is registered at all. Called once at startup by the
     * security check of the boot sequence.
     *
     * @return {@code true} while the pipeline holds no filter
     */
    public boolean isEmpty() {
        return entries.isEmpty();
    }

    /**
     * Runs the filters that apply to the request around one terminal link (the
     * matched route handler). Filters are selected by
     * {@link FilterSpec#pathPrefix()} and ordered by {@code (order, pluginId)};
     * the response of the first filter that short-circuits is returned
     * directly.
     *
     * @param request  the request to filter
     * @param terminal the route handler that runs when no filter short-circuits
     * @return the response produced by the chain
     * @throws Exception when a filter or the terminal link fails
     */
    public HttpResponse execute(HttpRequest request, HttpHandler terminal) throws Exception {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(terminal, "terminal");
        List<Entry> applicable = new ArrayList<>();
        for (Entry entry : entries) {
            if (applies(entry.spec().pathPrefix(), request.path())) {
                applicable.add(entry);
            }
        }
        applicable.sort(RUN_ORDER);
        return invoke(applicable, 0, request, terminal);
    }

    private static HttpResponse invoke(List<Entry> chain, int index, HttpRequest request,
            HttpHandler terminal) throws Exception {
        if (index == chain.size()) {
            return terminal.handle(request);
        }
        Entry entry = chain.get(index);
        HttpFilter filter = entry.spec().filter();
        return filter.filter(request, next -> invoke(chain, index + 1, next, terminal));
    }

    /** Whether one filter prefix selects the request path; {@code /} selects all. */
    private static boolean applies(String pathPrefix, String path) {
        return pathPrefix == null || pathPrefix.isEmpty() || "/".equals(pathPrefix)
                || (path != null && path.startsWith(pathPrefix));
    }

    /** One registered filter together with the plugin that registered it. */
    private record Entry(FilterSpec spec, String pluginId) {}
}
