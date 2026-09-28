package com.astroreen.jhin.core.security;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.servlet.FilterChain;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class EnrollRateLimitFilterTest {

    private static final long WINDOW_MILLIS = 60_000L;
    private static final String IP_A = "10.0.0.1";
    private static final String IP_B = "10.0.0.2";

    private final AtomicLong now = new AtomicLong(1_700_000_000_000L);
    private final AtomicInteger chainCalls = new AtomicInteger();
    private final FilterChain chain = (request, response) -> chainCalls.incrementAndGet();

    private EnrollRateLimitFilter filter;

    @BeforeEach
    void setUp() {
        filter = new EnrollRateLimitFilter(3, WINDOW_MILLIS, now::get);
    }

    @Test
    void threeRequestsPassFourthIsRateLimitedWithRetryAfter() throws Exception {
        for (int i = 0; i < 3; i++) {
            assertThat(perform("/enroll", IP_A).getStatus()).isEqualTo(200);
        }
        assertThat(chainCalls.get()).isEqualTo(3);

        MockHttpServletResponse limited = perform("/enroll", IP_A);

        assertThat(limited.getStatus()).isEqualTo(429);
        assertThat(limited.getHeader("Retry-After")).isEqualTo("60");
        assertThat(limited.getHeader("Content-Type")).isEqualTo("application/json");
        assertThat(limited.getContentAsString()).isEqualTo("{\"error\":\"rate_limited\"}");
        assertThat(chainCalls.get()).isEqualTo(3);
    }

    @Test
    void differentClientIpsAreIndependent() throws Exception {
        for (int i = 0; i < 3; i++) {
            perform("/enroll", IP_A);
        }

        assertThat(perform("/enroll", IP_B).getStatus()).isEqualTo(200);
        assertThat(perform("/enroll", IP_A).getStatus()).isEqualTo(429);
        assertThat(chainCalls.get()).isEqualTo(4);
    }

    @Test
    void windowElapseAllowsRequestsAgain() throws Exception {
        for (int i = 0; i < 4; i++) {
            perform("/enroll", IP_A);
        }
        assertThat(chainCalls.get()).isEqualTo(3);

        now.addAndGet(WINDOW_MILLIS);

        assertThat(perform("/enroll", IP_A).getStatus()).isEqualTo(200);
        assertThat(chainCalls.get()).isEqualTo(4);
    }

    @Test
    void otherPathsAreNotRateLimited() throws Exception {
        for (int i = 0; i < 5; i++) {
            assertThat(perform("/api/other", IP_A).getStatus()).isEqualTo(200);
        }
        assertThat(chainCalls.get()).isEqualTo(5);
    }

    private MockHttpServletResponse perform(String path, String ip) throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", path);
        request.setRemoteAddr(ip);
        MockHttpServletResponse response = new MockHttpServletResponse();
        filter.doFilter(request, response, chain);
        return response;
    }
}
