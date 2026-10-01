/**
 * Bearer filter coverage: the five allow-list cases pass unauthenticated,
 * a missing or unknown token is a uniform {@code 401 unauthorized}, a revoked
 * device is {@code 403 forbidden}, a valid token stores the principal and
 * proceeds, and the liveness update is throttled to one per minute per device.
 */
package com.astroreen.jhin.plugin.security;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.security.api.EnrollmentService;
import com.astroreen.jhin.plugin.security.api.Principal;
import com.astroreen.jhin.plugin.security.api.SecurityAttributes;
import com.astroreen.jhin.sdk.http.FilterChain;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class BearerFilterTest {

    private static final Instant START = Instant.parse("2026-01-01T00:00:00Z");

    @TempDir
    Path tmp;

    private MutableClock clock;
    private TestDbAccess db;
    private AccountServiceImpl accounts;
    private EnrollmentServiceImpl enrollment;
    private DeviceServiceImpl devices;
    private BearerFilter filter;
    private String accountId;

    private final AtomicReference<HttpRequest> proceeded = new AtomicReference<>();
    private final FilterChain chain = request -> {
        proceeded.set(request);
        return HttpResponse.text(200, "passed");
    };

    @BeforeEach
    void setUp() {
        clock = new MutableClock(START);
        db = TestDbAccess.open(tmp);
        db.migrate(Migrations.all());
        accounts = new AccountServiceImpl(db, clock);
        enrollment = new EnrollmentServiceImpl(db, clock);
        devices = new DeviceServiceImpl(db, clock);
        filter = new BearerFilter(devices, clock);
        accountId = accounts.create("alice").id();
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void allowListPassesWithoutToken() throws Exception {
        String[][] allowed = {
                {"GET", "/_jhin/health"},
                {"GET", "/_jhin/bootstrap"},
                {"POST", "/enroll"},
                {"POST", "/ui/action/enroll"},
                {"OPTIONS", "/sessions"},
        };
        for (String[] entry : allowed) {
            proceeded.set(null);
            FakeHttpRequest request = new FakeHttpRequest(entry[0], entry[1]);
            HttpResponse response = filter.filter(request, chain);
            assertThat(response.status()).as("%s %s", entry[0], entry[1]).isEqualTo(200);
            assertThat(proceeded.get()).as("%s %s proceeded", entry[0], entry[1]).isSameAs(request);
            assertThat(request.attribute(SecurityAttributes.PRINCIPAL)).isEmpty();
        }
    }

    @Test
    void missingTokenIsUnauthorized() throws Exception {
        HttpResponse response = filter.filter(new FakeHttpRequest("GET", "/sessions"), chain);

        assertThat(response.status()).isEqualTo(401);
        assertThat(errorOf(response)).isEqualTo("unauthorized");
        assertThat(proceeded.get()).isNull();
    }

    @Test
    void unknownTokenIsUnauthorizedLikeMissing() throws Exception {
        HttpResponse missing = filter.filter(new FakeHttpRequest("GET", "/sessions"), chain);
        HttpResponse unknown = filter.filter(
                requestWithToken("deadbeef"), chain);

        assertThat(unknown.status()).isEqualTo(401);
        assertThat(errorOf(unknown)).isEqualTo(errorOf(missing));
        assertThat(errorOf(unknown)).isEqualTo("unauthorized");
    }

    @Test
    void nonBearerSchemeIsUnauthorized() throws Exception {
        FakeHttpRequest request = new FakeHttpRequest("GET", "/sessions",
                Map.of("Authorization", "Basic dXNlcjpwYXNz"), "127.0.0.1", "");

        HttpResponse response = filter.filter(request, chain);

        assertThat(response.status()).isEqualTo(401);
        assertThat(errorOf(response)).isEqualTo("unauthorized");
    }

    @Test
    void revokedDeviceIsForbidden() throws Exception {
        String token = enroll("qa-revoked");
        devices.revoke(devices.list(null).get(0).id());

        HttpResponse response = filter.filter(requestWithToken(token), chain);

        assertThat(response.status()).isEqualTo(403);
        assertThat(errorOf(response)).isEqualTo("forbidden");
        assertThat(proceeded.get()).isNull();
    }

    @Test
    void validTokenSetsPrincipalAndProceeds() throws Exception {
        String token = enroll("qa-laptop");
        FakeHttpRequest request = new FakeHttpRequest("GET", "/sessions",
                Map.of("Authorization", "bearer " + token), "127.0.0.1", "");

        HttpResponse response = filter.filter(request, chain);

        assertThat(response.status()).isEqualTo(200);
        assertThat(proceeded.get()).isSameAs(request);
        Principal principal = (Principal) request.attribute(SecurityAttributes.PRINCIPAL).orElseThrow();
        assertThat(principal.accountId()).isEqualTo(accountId);
        assertThat(principal.accountName()).isEqualTo("alice");
        assertThat(principal.deviceId()).isEqualTo(devices.list(null).get(0).id());
    }

    @Test
    void lastSeenTouchedAtMostOncePerMinute() throws Exception {
        String token = enroll("qa-throttle");
        String deviceId = devices.list(null).get(0).id();
        assertThat(lastSeen(deviceId)).isEqualTo(START.toEpochMilli());

        clock.advance(Duration.ofMinutes(1));
        filter.filter(requestWithToken(token), chain);
        assertThat(lastSeen(deviceId)).isEqualTo(START.toEpochMilli() + 60_000L);

        clock.advance(Duration.ofSeconds(30));
        filter.filter(requestWithToken(token), chain);
        assertThat(lastSeen(deviceId)).as("same-minute request must not touch")
                .isEqualTo(START.toEpochMilli() + 60_000L);

        clock.advance(Duration.ofSeconds(30));
        filter.filter(requestWithToken(token), chain);
        assertThat(lastSeen(deviceId)).as("request one minute after the last touch touches again")
                .isEqualTo(START.toEpochMilli() + 120_000L);
    }

    private String enroll(String deviceName) {
        EnrollmentServiceImpl.IssuedCode issued = enrollment.issue(accountId);
        EnrollmentService.Redeemed result = enrollment.redeem(issued.code(), deviceName);
        return result.token();
    }

    private static FakeHttpRequest requestWithToken(String token) {
        return new FakeHttpRequest("GET", "/sessions",
                Map.of("Authorization", "Bearer " + token), "127.0.0.1", "");
    }

    private long lastSeen(String deviceId) {
        return devices.list(null).stream()
                .filter(row -> row.id().equals(deviceId))
                .findFirst()
                .orElseThrow()
                .lastSeenAt();
    }

    private static String errorOf(HttpResponse response) {
        String body = new String(response.body(), StandardCharsets.UTF_8);
        return String.valueOf(Json.readMap(body).get("error"));
    }
}
