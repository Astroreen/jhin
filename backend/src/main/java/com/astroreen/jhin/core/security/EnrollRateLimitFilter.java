package com.astroreen.jhin.core.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Rate-limit на /enroll: скользящее окно 3 запроса за 60 секунд на client IP (in-memory,
 * ConcurrentHashMap IP → метки времени). Превышение — 429 + Retry-After (секунды до
 * освобождения окна). Счётчики протухших IP подчищаются лениво при разрастании карты.
 */
public class EnrollRateLimitFilter extends OncePerRequestFilter {

    public static final String ENROLL_PATH = "/enroll";
    public static final int DEFAULT_MAX_REQUESTS = 3;
    public static final long DEFAULT_WINDOW_MILLIS = 60_000L;

    private static final int MAX_TRACKED_IPS = 10_000;

    private final ConcurrentHashMap<String, Deque<Long>> hitsByIp = new ConcurrentHashMap<>();
    private final int maxRequests;
    private final long windowMillis;
    private final LongSupplier nowMillis;

    public EnrollRateLimitFilter() {
        this(DEFAULT_MAX_REQUESTS, DEFAULT_WINDOW_MILLIS, System::currentTimeMillis);
    }

    EnrollRateLimitFilter(int maxRequests, long windowMillis, LongSupplier nowMillis) {
        this.maxRequests = maxRequests;
        this.windowMillis = windowMillis;
        this.nowMillis = nowMillis;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI().substring(request.getContextPath().length());
        return !ENROLL_PATH.equals(path);
    }

    @Override
    protected void doFilterInternal(
            HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {
        long now = nowMillis.getAsLong();
        Deque<Long> window = hitsByIp.computeIfAbsent(request.getRemoteAddr(), key -> new ArrayDeque<>());
        synchronized (window) {
            while (!window.isEmpty() && window.peekFirst() <= now - windowMillis) {
                window.pollFirst();
            }
            if (window.size() >= maxRequests) {
                rateLimited(response, window.peekFirst() + windowMillis - now);
                return;
            }
            window.addLast(now);
        }
        if (hitsByIp.size() > MAX_TRACKED_IPS) {
            pruneStaleIps(now);
        }
        filterChain.doFilter(request, response);
    }

    private void pruneStaleIps(long now) {
        hitsByIp.entrySet().removeIf(entry -> {
            Deque<Long> window = entry.getValue();
            synchronized (window) {
                while (!window.isEmpty() && window.peekFirst() <= now - windowMillis) {
                    window.pollFirst();
                }
                return window.isEmpty();
            }
        });
    }

    private static void rateLimited(HttpServletResponse response, long retryAfterMillis) throws IOException {
        response.setStatus(429);
        response.setHeader("Retry-After", String.valueOf(Math.max(1, (retryAfterMillis + 999) / 1000)));
        response.setContentType("application/json");
        response.getWriter().write("{\"error\":\"rate_limited\"}");
    }
}
