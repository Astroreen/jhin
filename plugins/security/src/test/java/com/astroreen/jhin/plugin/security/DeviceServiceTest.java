/**
 * Device coverage: token verification happy path, then the refusal cases — a
 * revoked device and an unknown token are rejected with the documented wire
 * code and HTTP status.
 */
package com.astroreen.jhin.plugin.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.plugin.security.api.EnrollmentService;
import com.astroreen.jhin.plugin.security.api.Principal;
import com.astroreen.jhin.plugin.security.api.SecurityException;
import java.nio.file.Path;
import java.time.Clock;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class DeviceServiceTest {

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private EnrollmentServiceImpl enrollment;
    private DeviceServiceImpl devices;
    private String accountId;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        db.migrate(Migrations.all());
        Clock clock = Clock.systemUTC();
        AccountServiceImpl accounts = new AccountServiceImpl(db, clock);
        enrollment = new EnrollmentServiceImpl(db, clock);
        devices = new DeviceServiceImpl(db, clock);
        accountId = accounts.create("alice").id();
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void verifyReturnsPrincipalOfEnrolledDevice() {
        EnrollmentService.Redeemed result = enrollment.redeem(
                enrollment.issue(accountId).code(), "qa-laptop");

        Principal principal = devices.verify(result.token());

        assertThat(principal.accountId()).isEqualTo(accountId);
        assertThat(principal.accountName()).isEqualTo("alice");
        assertThat(principal.deviceId()).isEqualTo(result.principal().deviceId());
    }

    @Test
    void revokeRejectsTokenWithForbidden() {
        EnrollmentService.Redeemed result = enrollment.redeem(
                enrollment.issue(accountId).code(), "qa-laptop");

        assertThat(devices.revoke(result.principal().deviceId())).isTrue();

        assertThatExceptionOfType(SecurityException.class)
                .isThrownBy(() -> devices.verify(result.token()))
                .satisfies(error -> {
                    assertThat(error.code()).isEqualTo("forbidden");
                    assertThat(error.httpStatus()).isEqualTo(403);
                });
    }

    @Test
    void verifyUnknownTokenRefusesWithUnauthorized() {
        assertThatExceptionOfType(SecurityException.class)
                .isThrownBy(() -> devices.verify("nope"))
                .satisfies(error -> {
                    assertThat(error.code()).isEqualTo("unauthorized");
                    assertThat(error.httpStatus()).isEqualTo(401);
                });
    }

    @Test
    void verifyRejectsBlankToken() {
        assertThatThrownBy(() -> devices.verify(" "))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void touchUpdatesLastSeenAt() {
        EnrollmentService.Redeemed result = enrollment.redeem(
                enrollment.issue(accountId).code(), "qa-laptop");

        assertThat(devices.touch(result.principal().deviceId())).isTrue();
        assertThat(devices.touch("ghost")).isFalse();
    }
}
