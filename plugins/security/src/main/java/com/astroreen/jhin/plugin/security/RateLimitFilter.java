/**
 * Enrollment rate limiting as a request filter: a per-address sliding window
 * over the enrollment endpoint.
 *
 * <p>Registered from {@link SecurityPlugin#start} as filter
 * {@code jhin.security.enroll-rate} on the {@code /enroll} path prefix, in
 * order {@value #ORDER} (before bearer authentication). At most
 * {@value #MAX_ATTEMPTS} requests per {@code remoteAddr} are forwarded to the
 * route within any {@value #WINDOW_MILLIS} millisecond window; the
 * {@value #MAX_ATTEMPTS} + 1st is rejected with {@code 429} and the SDK error
 * code {@code rate_limited}. The window slides by request timestamp — old
 * attempts fall out as they age past the window, there are no fixed buckets —
 * and only forwarded requests are recorded, so a stream of rejections neither
 * grows nor extends the window.
 *
 * <p>The counters are in-memory and per kernel process (restart resets them)
 * and thread-safe: one record deque per remote address, mutated under the
 * deque's own monitor. The clock is injectable so tests slide the window
 * instead of sleeping.
 */
package com.astroreen.jhin.plugin.security;

import com.astroreen.jhin.sdk.http.FilterChain;
import com.astroreen.jhin.sdk.http.HttpFilter;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import java.time.Clock;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

final class RateLimitFilter implements HttpFilter {

    /** Run order: before bearer authentication (order 100). */
    static final int ORDER = 50;

    /** Filter id registered with the HTTP registry. */
    static final String ID = "jhin.security.enroll-rate";

    /** Attempts forwarded per remote address within the window. */
    static final int MAX_ATTEMPTS = 10;

    /** Sliding window length in milliseconds. */
    static final long WINDOW_MILLIS = 10 * 60 * 1000L;

    /** Wire code of the {@code 429} rejection. */
    static final String CODE_RATE_LIMITED = "rate_limited";

    private final Clock clock;
    private final Map<String, Deque<Long>> attempts = new ConcurrentHashMap<>();

    RateLimitFilter(Clock clock) {
        this.clock = clock;
    }

    /**
     * Applies the sliding window to one enrollment request. Called by the
     * kernel on every request under the {@code /enroll} prefix.
     *
     * @param req   the request
     * @param chain the remainder of the chain
     * @return the response of the chain, or {@code 429 rate_limited}
     * @throws Exception when a later stage fails
     */
    @Override
    public HttpResponse filter(HttpRequest req, FilterChain chain) throws Exception {
        long now = clock.millis();
        Deque<Long> window = attempts.computeIfAbsent(req.remoteAddr(), key -> new ArrayDeque<>());
        synchronized (window) {
            while (!window.isEmpty() && now - window.peekFirst() >= WINDOW_MILLIS) {
                window.pollFirst();
            }
            if (window.size() >= MAX_ATTEMPTS) {
                return HttpResponse.error(429, CODE_RATE_LIMITED,
                        "too many enrollment attempts from this address, try again later");
            }
            window.addLast(now);
        }
        return chain.proceed(req);
    }
}
