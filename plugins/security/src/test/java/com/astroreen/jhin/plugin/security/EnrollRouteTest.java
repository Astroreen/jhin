/**
 * Enrollment route coverage: the happy path answers the documented token
 * payload, a bad body is a {@code 400} naming the offending field, and the
 * single-use and TTL refusals surface their exact wire codes —
 * {@code 410 code_used}, {@code 410 code_expired} and {@code 401
 * unauthorized} for an unknown code.
 */
package com.astroreen.jhin.plugin.security;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.security.api.Principal;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class EnrollRouteTest {

    private static final Instant START = Instant.parse("2026-01-01T00:00:00Z");

    @TempDir
    Path tmp;

    private MutableClock clock;
    private TestDbAccess db;
    private AccountServiceImpl accounts;
    private EnrollmentServiceImpl enrollment;
    private DeviceServiceImpl devices;
    private EnrollRoute route;
    private String accountId;

    @BeforeEach
    void setUp() {
        clock = new MutableClock(START);
        db = TestDbAccess.open(tmp);
        db.migrate(Migrations.all());
        accounts = new AccountServiceImpl(db, clock);
        enrollment = new EnrollmentServiceImpl(db, clock);
        devices = new DeviceServiceImpl(db, clock);
        route = new EnrollRoute(enrollment);
        accountId = accounts.create("alice").id();
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void happyPathReturnsTokenPayload() {
        EnrollmentServiceImpl.IssuedCode issued = enrollment.issue(accountId);

        HttpResponse response = route.handle(body(
                "{\"code\":\"" + issued.code() + "\",\"deviceName\":\"qa\"}"));

        assertThat(response.status()).isEqualTo(200);
        Map<String, Object> payload = Json.readMap(text(response));
        assertThat(payload.get("token")).isInstanceOf(String.class)
                .asString().isNotBlank().hasSize(64);
        assertThat(payload.get("accountId")).isEqualTo(accountId);
        assertThat(payload.get("accountName")).isEqualTo("alice");
        assertThat(payload.get("deviceId")).isInstanceOf(String.class).asString().isNotBlank();
        Principal verified = devices.verify((String) payload.get("token"));
        assertThat(verified.deviceId()).isEqualTo(payload.get("deviceId"));
    }

    @Test
    void missingCodeNamesTheField() {
        HttpResponse response = route.handle(body("{\"deviceName\":\"qa\"}"));

        assertThat(response.status()).isEqualTo(400);
        assertThat(errorOf(response)).isEqualTo(EnrollRoute.CODE_BAD_REQUEST);
        assertThat(text(response)).contains("code");
    }

    @Test
    void missingDeviceNameNamesTheField() {
        HttpResponse response = route.handle(body("{\"code\":\"whatever\"}"));

        assertThat(response.status()).isEqualTo(400);
        assertThat(errorOf(response)).isEqualTo(EnrollRoute.CODE_BAD_REQUEST);
        assertThat(text(response)).contains("deviceName");
    }

    @Test
    void invalidJsonBodyIsBadRequest() {
        HttpResponse response = route.handle(body("this is not json"));

        assertThat(response.status()).isEqualTo(400);
        assertThat(errorOf(response)).isEqualTo(EnrollRoute.CODE_BAD_REQUEST);
    }

    @Test
    void usedCodeIsGone() {
        EnrollmentServiceImpl.IssuedCode issued = enrollment.issue(accountId);
        String payload = "{\"code\":\"" + issued.code() + "\",\"deviceName\":\"first\"}";
        assertThat(route.handle(body(payload)).status()).isEqualTo(200);

        HttpResponse second = route.handle(body(payload));

        assertThat(second.status()).isEqualTo(410);
        assertThat(errorOf(second)).isEqualTo("code_used");
    }

    @Test
    void expiredCodeIsGone() {
        EnrollmentServiceImpl.IssuedCode issued = enrollment.issue(accountId);
        clock.advance(Duration.ofMillis(EnrollmentServiceImpl.TTL_MILLIS));

        HttpResponse response = route.handle(body(
                "{\"code\":\"" + issued.code() + "\",\"deviceName\":\"qa\"}"));

        assertThat(response.status()).isEqualTo(410);
        assertThat(errorOf(response)).isEqualTo("code_expired");
    }

    @Test
    void unknownCodeIsUnauthorized() {
        HttpResponse response = route.handle(body(
                "{\"code\":\"NOSUCHCODE\",\"deviceName\":\"qa\"}"));

        assertThat(response.status()).isEqualTo(401);
        assertThat(errorOf(response)).isEqualTo("unauthorized");
    }

    private static FakeHttpRequest body(String json) {
        return new FakeHttpRequest("POST", "/enroll",
                Map.of("Content-Type", "application/json"), "127.0.0.1", json);
    }

    private static String text(HttpResponse response) {
        return new String(response.body(), StandardCharsets.UTF_8);
    }

    private static String errorOf(HttpResponse response) {
        return String.valueOf(Json.readMap(text(response)).get("error"));
    }
}
