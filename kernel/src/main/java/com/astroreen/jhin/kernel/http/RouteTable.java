/**
 * Registration side of the HTTP route space: one entry per
 * {@code (method, path template)} pair, indexed by method and segment count so
 * the matcher only ever compares templates of the exact same shape.
 *
 * <p>Ownership is part of every registration. A duplicate
 * {@code (method, path)} that is not a fallback is refused with a
 * {@link PluginException} naming the plugin that already owns the pair; a
 * fallback entry (the host's provisional routes) is replaced silently by the
 * next registration of the same pair, so an explicit route always supersedes
 * the provisional one it shadows.
 */
package com.astroreen.jhin.kernel.http;

import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.http.RouteSpec;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

public final class RouteTable {

    /** Method to segment count to the entries of that shape, in registration order. */
    private final Map<String, Map<Integer, List<Entry>>> byMethod = new HashMap<>();

    /** Exact {@code (method, path)} pair to its single entry, for conflict detection. */
    private final Map<Key, Entry> byKey = new LinkedHashMap<>();

    /**
     * Registers a plugin route. Replaces a fallback entry under the same
     * {@code (method, path)} silently.
     *
     * @param spec  the route to register
     * @param owner id of the plugin that owns the route
     * @throws PluginException when a non-fallback entry already owns the pair;
     *         the text is {@code route conflict: <method> <path> already owned
     *         by <owner>}
     */
    public synchronized void register(RouteSpec spec, String owner) {
        add(spec, owner, false);
    }

    /**
     * Registers a fallback route: a provisional entry the host offers until a
     * plugin claims the same {@code (method, path)}. Replaces an existing
     * fallback entry silently; refused when a non-fallback entry owns the pair.
     *
     * @param spec  the fallback route to register
     * @param owner id of the registering side
     * @throws PluginException when a non-fallback entry already owns the pair
     */
    public synchronized void registerFallback(RouteSpec spec, String owner) {
        add(spec, owner, true);
    }

    /**
     * The entries registered for one method and segment count, in registration
     * order. Called by {@link RouteMatcher}; the empty list when nothing is
     * registered for the shape.
     *
     * @param method        the request method, matched exactly as registered
     * @param segmentCount  the number of path segments of the request
     * @return the candidate entries of that shape
     */
    synchronized List<Entry> candidates(String method, int segmentCount) {
        Map<Integer, List<Entry>> byCount = byMethod.get(method);
        if (byCount == null) {
            return List.of();
        }
        List<Entry> entries = byCount.get(segmentCount);
        return entries == null ? List.of() : List.copyOf(entries);
    }

    /**
     * Every method that has at least one registered route. Called by
     * {@link RouteMatcher} to tell a missing route apart from a wrong method.
     *
     * @return the registered methods
     */
    synchronized Set<String> methods() {
        return Set.copyOf(byMethod.keySet());
    }

    /**
     * Splits a path into its non-empty segments. A template path and a request
     * path that differ only in trailing slashes produce the same segments.
     *
     * @param path the path to split; {@code null} is treated as {@code /}
     * @return the segments, root {@code /} producing none
     */
    static List<String> splitPath(String path) {
        List<String> segments = new ArrayList<>();
        if (path != null) {
            for (String segment : path.split("/")) {
                if (!segment.isEmpty()) {
                    segments.add(segment);
                }
            }
        }
        return List.copyOf(segments);
    }

    private void add(RouteSpec spec, String owner, boolean fallback) {
        Objects.requireNonNull(spec, "spec");
        Objects.requireNonNull(owner, "owner");
        Key key = new Key(spec.method(), spec.path());
        Entry existing = byKey.get(key);
        if (existing != null && !existing.fallback()) {
            throw new PluginException("route conflict: " + spec.method() + " " + spec.path()
                    + " already owned by " + existing.owner());
        }
        Entry entry = new Entry(spec, owner, fallback, splitPath(spec.path()));
        byKey.put(key, entry);
        List<Entry> bucket = byMethod
                .computeIfAbsent(spec.method(), ignored -> new HashMap<>())
                .computeIfAbsent(entry.segments().size(), ignored -> new ArrayList<>());
        bucket.removeIf(registered -> registered.spec().path().equals(spec.path()));
        bucket.add(entry);
    }

    /** Map key: the exact method and path template of one registration. */
    private record Key(String method, String path) {}

    /** One registered route with its ownership and split template segments. */
    record Entry(RouteSpec spec, String owner, boolean fallback, List<String> segments) {}
}
