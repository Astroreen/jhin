/**
 * The remainder of the filter chain around one request.
 *
 * <p>Handed to {@link HttpFilter#filter}; implemented by the kernel's filter
 * pipeline. Calling {@link #proceed} runs the next matching filter, or the
 * matched route handler when the chain is exhausted.
 */
package com.astroreen.jhin.sdk.http;

public interface FilterChain {

    /**
     * Runs the next stage of the chain. Called by a filter that wants the
     * request to continue towards the handler; the filter may pass a rewritten
     * request.
     *
     * @param req the request to pass on
     * @return the response produced by the rest of the chain
     * @throws Exception when a later stage fails; the kernel maps it to a 500
     *         response and logs the stack trace
     */
    HttpResponse proceed(HttpRequest req) throws Exception;
}
