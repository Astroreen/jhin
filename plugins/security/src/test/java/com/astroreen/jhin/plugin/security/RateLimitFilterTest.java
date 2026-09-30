/**
 * Enrollment rate limit coverage: ten attempts per remote address slide
 * through the window, the eleventh is {@code 429 rate_limited}, addresses are
 * isolated from each other and the window slides by timestamp — attempts age
 * out after ten minutes instead of resetting at a bucket boundary.
 */
package com.astroreen.jhin.plugin.security;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.sdk.http.FilterChain;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class RateLimitFilterTest {

    private static final Instant START = Instant.parse("2026-01-01T00:00:00Z");

    private MutableClock clock;
    private RateLimitFilter filter;
    private final AtomicInteger proceeded = new AtomicInteger();
    private final FilterChain chain = request -> {
        proceeded.incrementAndGet();
        return HttpResponse.text(200, "passed");
    };

    @BeforeEach
    void setUp() {
        clock = new MutableClock(START);
        filter = new RateLimitFilter(clock);
    }

    @Test
    void tenthAttemptPassesAndEleventhIsRejected() throws Exception {
        for (int i = 1; i <= RateLimitFilter.MAX_ATTEMPTS; i++) {
            HttpResponse response = filter.filter(request("10.0.0.1"), chain);
            assertThat(response.status()).as("attempt %d", i).isEqualTo(200);
        }

        HttpResponse rejected = filter.filter(request("10.0.0.1"), chain);

        assertThat(rejected.status()).isEqualTo(429);
        assertThat(errorOf(rejected)).isEqualTo(RateLimitFilter.CODE_RATE_LIMITED);
        assertThat(proceeded.get()).isEqualTo(RateLimitFilter.MAX_ATTEMPTS);
    }

    @Test
    void addressesAreIsolated() throws Exception {
        for (int i = 0; i < RateLimitFilter.MAX_ATTEMPTS; i++) {
            filter.filter(request("10.0.0.1"), chain);
        }

        HttpResponse other = filter.filter(request("10.0.0.2"), chain);
        HttpResponse rejected = filter.filter(request("10.0.0.1"), chain);

        assertThat(other.status()).as("other address keeps its own window").isEqualTo(200);
        assertThat(rejected.status()).isEqualTo(429);
    }

    @Test
    void windowSlidesAfterTenMinutes() throws Exception {
        for (int i = 0; i < RateLimitFilter.MAX_ATTEMPTS; i++) {
            filter.filter(request("10.0.0.1"), chain);
        }
        assertThat(filter.filter(request("10.0.0.1"), chain).status()).isEqualTo(429);

        clock.advance(Duration.ofMinutes(9));
        assertThat(filter.filter(request("10.0.0.1"), chain).status())
                .as("attempts are still inside the window after nine minutes").isEqualTo(429);

        clock.advance(Duration.ofMinutes(1));
        assertThat(filter.filter(request("10.0.0.1"), chain).status())
                .as("the window has slid past every recorded attempt").isEqualTo(200);
    }

    private static FakeHttpRequest request(String remoteAddr) {
        return new FakeHttpRequest("POST", "/enroll", Map.of(), remoteAddr, "{}");
    }

    private static String errorOf(HttpResponse response) {
        String body = new String(response.body(), StandardCharsets.UTF_8);
        return String.valueOf(Json.readMap(body).get("error"));
    }
}
