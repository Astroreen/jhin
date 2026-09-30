/**
 * Bearer-token authentication as a request filter.
 *
 * <p>Registered from {@link SecurityPlugin#start} as filter
 * {@code jhin.security.bearer} on every path, in order {@value #ORDER} (after
 * the enrollment rate limit). Requests in the allow-list — {@code GET
 * /_jhin/health}, {@code GET /_jhin/bootstrap}, {@code POST /enroll} and any
 * {@code OPTIONS} pre-flight — proceed unauthenticated; every other request
 * must carry {@code Authorization: Bearer <token>} (the scheme match is
 * case-insensitive). A valid token resolves the {@link Principal} through
 * {@link DeviceServiceImpl#verify(String)}, stores it under
 * {@link SecurityAttributes#PRINCIPAL} for the downstream routes and records
 * device liveness through {@link DeviceServiceImpl#touch(String)}, throttled
 * to at most one update per {@value #TOUCH_INTERVAL_MILLIS} milliseconds per
 * device via an in-memory timestamp map.
 *
 * <p><b>Wire codes.</b> Rejections answer with the SDK error shape
 * {@code {"error":code,"message":detail}}: {@code 401} with code
 * {@code unauthorized} for a missing, malformed or unknown token and
 * {@code 403} with code {@code forbidden} for a revoked device. An unknown
 * token answers exactly like a missing one, so the filter never reveals
 * whether a token ever existed; the revoked case is the only distinguishable
 * rejection, and only for a token that genuinely authenticates to a revoked
 * device.
 */
package com.astroreen.jhin.plugin.security;

import com.astroreen.jhin.plugin.security.api.Principal;
import com.astroreen.jhin.plugin.security.api.SecurityAttributes;
import com.astroreen.jhin.plugin.security.api.SecurityException;
import com.astroreen.jhin.sdk.http.FilterChain;
import com.astroreen.jhin.sdk.http.HttpFilter;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import java.time.Clock;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

final class BearerFilter implements HttpFilter {

    /** Run order: after the enrollment rate limit (order 50). */
    static final int ORDER = 100;

    /** Filter id registered with the HTTP registry. */
    static final String ID = "jhin.security.bearer";

    /** Allow-listed kernel health path. */
    static final String HEALTH_PATH = "/_jhin/health";

    /** Allow-listed kernel bootstrap path. */
    static final String BOOTSTRAP_PATH = "/_jhin/bootstrap";

    /** Allow-listed enrollment route path. */
    static final String ENROLL_PATH = "/enroll";

    /** Minimum interval between two liveness updates of one device. */
    static final long TOUCH_INTERVAL_MILLIS = 60_000L;

    private static final String AUTHORIZATION_HEADER = "authorization";
    private static final String BEARER_SCHEME = "bearer";

    private final DeviceServiceImpl devices;
    private final Clock clock;
    private final Map<String, Long> lastTouched = new ConcurrentHashMap<>();

    BearerFilter(DeviceServiceImpl devices, Clock clock) {
        this.devices = devices;
        this.clock = clock;
    }

    /**
     * Authenticates one request: allow-listed requests pass through, all
     * others must present a bearer token that resolves to an active device.
     * Called by the kernel on every request before the route handler.
     *
     * @param req   the request
     * @param chain the remainder of the chain
     * @return the response of the chain, or a {@code 401}/{@code 403} rejection
     * @throws Exception when a later stage fails
     */
    @Override
    public HttpResponse filter(HttpRequest req, FilterChain chain) throws Exception {
        if (isAllowed(req.method(), req.path())) {
            return chain.proceed(req);
        }
        String token = bearerToken(req.headers().get(AUTHORIZATION_HEADER));
        if (token == null) {
            return unauthorized();
        }
        Principal principal;
        try {
            principal = devices.verify(token);
        } catch (SecurityException denied) {
            if (SecurityException.CODE_FORBIDDEN.equals(denied.code())) {
                return HttpResponse.error(403, SecurityException.CODE_FORBIDDEN, denied.getMessage());
            }
            return unauthorized();
        }
        req.setAttribute(SecurityAttributes.PRINCIPAL, principal);
        touchThrottled(principal.deviceId());
        return chain.proceed(req);
    }

    /**
     * Whether a request is on the allow-list and may pass unauthenticated.
     * Exactly four cases: {@code GET /_jhin/health}, {@code GET
     * /_jhin/bootstrap}, {@code POST /enroll} and any {@code OPTIONS}.
     *
     * @param method the request method
     * @param path   the request path
     * @return {@code true} when the request must not demand a token
     */
    static boolean isAllowed(String method, String path) {
        if ("OPTIONS".equals(method)) {
            return true;
        }
        if ("POST".equals(method)) {
            return ENROLL_PATH.equals(path);
        }
        return "GET".equals(method)
                && (HEALTH_PATH.equals(path) || BOOTSTRAP_PATH.equals(path));
    }

    /**
     * Extracts the token from one {@code Authorization} header value. The
     * {@code bearer} scheme is matched case-insensitively; anything else —
     * absent header, different scheme, blank token — yields {@code null} and
     * is treated exactly like a missing credential.
     *
     * @param header the raw header value, {@code null} when absent
     * @return the token part, or {@code null} when there is none
     */
    static String bearerToken(String header) {
        if (header == null) {
            return null;
        }
        String value = header.trim();
        int separator = value.indexOf(' ');
        if (separator < 0 || !BEARER_SCHEME.equalsIgnoreCase(value.substring(0, separator))) {
            return null;
        }
        String token = value.substring(separator + 1).trim();
        return token.isEmpty() ? null : token;
    }

    /** The uniform rejection for every missing or unverifiable credential. */
    private static HttpResponse unauthorized() {
        return HttpResponse.error(401, SecurityException.CODE_UNAUTHORIZED,
                "a valid device token is required");
    }

    /**
     * Records device liveness at most once per
     * {@value #TOUCH_INTERVAL_MILLIS} milliseconds per device. The decision is
     * an in-memory timestamp check (per filter instance); only the first
     * request in each interval pays for the database write.
     *
     * @param deviceId the authenticated device
     */
    private void touchThrottled(String deviceId) {
        long now = clock.millis();
        lastTouched.compute(deviceId, (id, previous) -> {
            if (previous != null && now - previous < TOUCH_INTERVAL_MILLIS) {
                return previous;
            }
            devices.touch(id);
            return now;
        });
    }
}
