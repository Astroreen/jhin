/**
 * One request filter registration: identity, scope, ordering and the filter.
 *
 * <p>Created by a plugin and handed to {@link HttpRegistry#filter(FilterSpec)}.
 * The kernel runs matching filters around every request in ascending
 * {@link #order()}, ties broken by the id of the plugin that registered the
 * filter. {@link #pathPrefix()} {@code "/"} matches all paths; any other
 * prefix selects requests whose path starts with it. A filter that returns
 * without calling {@link FilterChain#proceed} short-circuits the chain and its
 * return value is sent as the response.
 *
 * <p>Components: {@code id} — the filter id, unique within the owning plugin;
 * {@code pathPrefix} — the path prefix this filter applies to ({@code "/"}
 * means all paths); {@code order} — run order, lower values run first;
 * {@code filter} — the filter to run.
 */
package com.astroreen.jhin.sdk.http;

public record FilterSpec(String id, String pathPrefix, int order, HttpFilter filter) {}
