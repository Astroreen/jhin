/**
 * One HTTP route: method, path template and handler.
 *
 * <p>Created by a plugin during {@link com.astroreen.jhin.sdk.JhinPlugin#start}
 * and handed to {@link HttpRegistry#route(RouteSpec)}. The kernel matches
 * incoming requests against the template and fills
 * {@link HttpRequest#pathParams()} with the captures.
 *
 * <p>Path templates follow the form {@code /sessions/{id}/events}: one
 * {@code {name}} placeholder at most per path segment, no wildcards. The
 * constructor normalizes the path — ensures a leading slash and strips
 * trailing slashes (root {@code /} keeps its slash) — and rejects wildcard
 * segments ({@code *}, {@code **}), path traversal segments ({@code ..}) and
 * segments with more than one {@code {name}} placeholder with
 * {@link IllegalArgumentException}.
 */
package com.astroreen.jhin.sdk.http;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

public record RouteSpec(String method, String path, HttpHandler handler) {

    // path templates: /sessions/{id}/events ; one {name} per segment ; no wildcards

    private static final Pattern PLACEHOLDER = Pattern.compile("\\{[^{}]*}");

    /**
     * Creates a route, normalizing and validating its path template. Called
     * by a plugin at registration time; the checks run once, here, so the
     * kernel can trust every registered template.
     *
     * @param method  the HTTP method this route serves (not normalized)
     * @param path    the path template; normalized to have a leading slash and
     *                no trailing slash (except root {@code /})
     * @param handler the handler invoked when the route matches
     * @throws IllegalArgumentException if {@code path} is {@code null}, or any
     *         segment is a wildcard ({@code *}, {@code **}), is {@code ..}, or
     *         contains more than one {@code {name}} placeholder; the message
     *         names the offending segment
     */
    public RouteSpec {
        if (path == null) {
            throw new IllegalArgumentException("path must not be null");
        }
        String normalized = path.trim();
        if (normalized.isEmpty()) {
            normalized = "/";
        } else {
            if (!normalized.startsWith("/")) {
                normalized = "/" + normalized;
            }
            while (normalized.length() > 1 && normalized.endsWith("/")) {
                normalized = normalized.substring(0, normalized.length() - 1);
            }
        }
        for (String segment : normalized.split("/", -1)) {
            if (!segment.isEmpty()) {
                validateSegment(segment);
            }
        }
        path = normalized;
    }

    private static void validateSegment(String segment) {
        if (segment.contains("*")) {
            throw new IllegalArgumentException(
                    "path segment '" + segment + "' must not contain wildcards (* or **)");
        }
        if (segment.equals("..")) {
            throw new IllegalArgumentException(
                    "path segment '" + segment + "' is a path traversal");
        }
        int opens = 0;
        int closes = 0;
        for (int i = 0; i < segment.length(); i++) {
            char c = segment.charAt(i);
            if (c == '{') {
                opens++;
            } else if (c == '}') {
                closes++;
            }
        }
        Matcher matcher = PLACEHOLDER.matcher(segment);
        int placeholders = 0;
        String name = null;
        while (matcher.find()) {
            placeholders++;
            name = matcher.group();
        }
        if (placeholders > 1) {
            throw new IllegalArgumentException(
                    "path segment '" + segment + "' must contain at most one {name} placeholder");
        }
        if (opens != placeholders || closes != placeholders) {
            throw new IllegalArgumentException(
                    "path segment '" + segment + "' has a malformed {name} placeholder");
        }
        if (placeholders == 1 && name.substring(1, name.length() - 1).isBlank()) {
            throw new IllegalArgumentException(
                    "path segment '" + segment + "' has an empty placeholder name");
        }
    }
}
