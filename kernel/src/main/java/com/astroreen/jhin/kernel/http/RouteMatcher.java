/**
 * Resolves one request {@code (method, path)} against a {@link RouteTable}.
 *
 * <p>Matching is exact on segment count and prefers a literal template
 * segment over a {@code {param}} one at every position, scanning left to
 * right: the first segment where two candidates disagree decides between
 * them. When no route matches the method but the path matches a route of
 * another method, the resolution is a method rejection rather than a missing
 * route, so the caller can answer {@code 405} instead of {@code 404}.
 */
package com.astroreen.jhin.kernel.http;

import com.astroreen.jhin.sdk.http.RouteSpec;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

public final class RouteMatcher {

    /** How one request resolved against the route table. */
    public enum Status {
        /** A route matched; the handler runs. */
        MATCHED,
        /** No registered route has a template matching the path. */
        NOT_FOUND,
        /** The path matches a route, but none registered for the request method. */
        METHOD_NOT_ALLOWED
    }

    /**
     * The outcome of one resolution.
     *
     * <p>Components: {@code status} — how the request resolved; {@code route} —
     * the matched route, {@code null} unless {@code status} is
     * {@link Status#MATCHED}; {@code pathParams} — the template captures of the
     * matched route, empty unless matched.
     */
    public record Resolution(Status status, RouteSpec route, Map<String, String> pathParams) {

        /**
         * A resolution that matched a route.
         *
         * @param route      the matched route
         * @param pathParams the template captures
         * @return the resolution
         */
        public static Resolution matched(RouteSpec route, Map<String, String> pathParams) {
            return new Resolution(Status.MATCHED, route, pathParams);
        }

        /**
         * A resolution whose path matches no registered template.
         *
         * @return the resolution
         */
        public static Resolution notFound() {
            return new Resolution(Status.NOT_FOUND, null, Map.of());
        }

        /**
         * A resolution whose path matches templates of other methods only.
         *
         * @return the resolution
         */
        public static Resolution methodNotAllowed() {
            return new Resolution(Status.METHOD_NOT_ALLOWED, null, Map.of());
        }
    }

    private final RouteTable table;

    /**
     * Creates a matcher over one route table.
     *
     * @param table the table to resolve against
     */
    public RouteMatcher(RouteTable table) {
        this.table = Objects.requireNonNull(table, "table");
    }

    /**
     * Resolves one request. The matched route is the left-to-right literal
     * winner among the candidates of the request's method and segment count;
     * when none matches, other methods are probed to tell
     * {@link Status#METHOD_NOT_ALLOWED} from {@link Status#NOT_FOUND}.
     *
     * @param method the request method, matched exactly as registered
     * @param path   the request path
     * @return the resolution, never {@code null}
     */
    public Resolution resolve(String method, String path) {
        Objects.requireNonNull(method, "method");
        List<String> requestSegments = RouteTable.splitPath(path);
        RouteTable.Entry match = match(table.candidates(method, requestSegments.size()),
                requestSegments, 0);
        if (match != null) {
            return Resolution.matched(match.spec(), paramsOf(match, requestSegments));
        }
        for (String other : table.methods()) {
            if (!other.equals(method)
                    && match(table.candidates(other, requestSegments.size()),
                            requestSegments, 0) != null) {
                return Resolution.methodNotAllowed();
            }
        }
        return Resolution.notFound();
    }

    /**
     * Picks the winning entry for one request shape. At each depth the literal
     * branch is tried before the param branch, so a literal segment beats a
     * {@code {param}} one at the first position where candidates disagree;
     * when the literal branch dead-ends deeper down, the param branch is tried.
     * Entries indistinguishable in shape resolve in registration order.
     */
    private static RouteTable.Entry match(List<RouteTable.Entry> candidates,
            List<String> requestSegments, int depth) {
        if (candidates.isEmpty()) {
            return null;
        }
        if (depth == requestSegments.size()) {
            return candidates.get(0);
        }
        String requestSegment = requestSegments.get(depth);
        List<RouteTable.Entry> literal = new ArrayList<>();
        List<RouteTable.Entry> param = new ArrayList<>();
        for (RouteTable.Entry entry : candidates) {
            String templateSegment = entry.segments().get(depth);
            if (isParam(templateSegment)) {
                param.add(entry);
            } else if (templateSegment.equals(requestSegment)) {
                literal.add(entry);
            }
        }
        RouteTable.Entry matched = match(literal, requestSegments, depth + 1);
        return matched != null ? matched : match(param, requestSegments, depth + 1);
    }

    /**
     * Collects the {@code {name}} captures of the matched entry, left to right.
     * Each capture is percent-decoded, so a client that encodes reserved path
     * characters (a colon in {@code chat%3A<id>}, for example) sees the value
     * it sent.
     */
    private static Map<String, String> paramsOf(RouteTable.Entry entry,
            List<String> requestSegments) {
        Map<String, String> params = new LinkedHashMap<>();
        List<String> templateSegments = entry.segments();
        for (int i = 0; i < templateSegments.size(); i++) {
            String templateSegment = templateSegments.get(i);
            if (isParam(templateSegment)) {
                params.put(templateSegment.substring(1, templateSegment.length() - 1),
                        decodePathSegment(requestSegments.get(i)));
            }
        }
        return Collections.unmodifiableMap(params);
    }

    /**
     * Percent-decodes one captured path segment as UTF-8. A literal {@code +}
     * stays a plus: it is escaped before decoding so the segment is decoded
     * with path semantics, not form semantics. A malformed escape is returned
     * unchanged rather than failing the whole request.
     */
    private static String decodePathSegment(String segment) {
        try {
            return URLDecoder.decode(segment.replace("+", "%2B"), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            return segment;
        }
    }

    /** Whether one template segment is a whole-segment {@code {name}} capture. */
    private static boolean isParam(String segment) {
        return segment.length() >= 2
                && segment.charAt(0) == '{'
                && segment.charAt(segment.length() - 1) == '}';
    }
}