/**
 * Enrollment coverage: issue and redeem happy path, then the refusal cases —
 * a used code, an expired code and an unknown code are all rejected with the
 * documented wire code and HTTP status.
 */
package com.astroreen.jhin.plugin.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.plugin.security.EnrollmentServiceImpl.IssuedCode;
import com.astroreen.jhin.plugin.security.EnrollmentServiceImpl.RedeemResult;
import com.astroreen.jhin.plugin.security.api.Principal;
import com.astroreen.jhin.plugin.security.api.SecurityException;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class EnrollmentServiceTest {

    @TempDir
    Path tmp;

    private MutableClock clock;
    private TestDbAccess db;
    private AccountServiceImpl accounts;
    private EnrollmentServiceImpl enrollment;
    private DeviceServiceImpl devices;
    private String accountId;

    @BeforeEach
    void setUp() {
        clock = new MutableClock(Instant.parse("2026-01-01T00:00:00Z"));
        db = TestDbAccess.open(tmp);
        db.migrate(Migrations.all());
        accounts = new AccountServiceImpl(db, clock);
        enrollment = new EnrollmentServiceImpl(db, clock);
        devices = new DeviceServiceImpl(db, clock);
        accountId = accounts.create("alice").id();
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void issueRedeemAndTokenWorks() {
        IssuedCode issued = enrollment.issue(accountId);

        assertThat(issued.code()).isNotBlank();
        assertThat(issued.accountId()).isEqualTo(accountId);
        assertThat(issued.expiresAt()).isEqualTo(clock.millis() + EnrollmentServiceImpl.TTL_MILLIS);

        RedeemResult result = enrollment.redeem(issued.code(), "qa-laptop");

        assertThat(result.token()).isNotBlank();
        Principal principal = devices.verify(result.token());
        assertThat(principal.accountId()).isEqualTo(accountId);
        assertThat(principal.accountName()).isEqualTo("alice");
        assertThat(principal.deviceId()).isEqualTo(result.principal().deviceId());
    }

    @Test
    void redeemTwiceRefusesWithCodeUsed() {
        IssuedCode issued = enrollment.issue(accountId);
        enrollment.redeem(issued.code(), "qa-laptop");

        assertThatExceptionOfType(SecurityException.class)
                .isThrownBy(() -> enrollment.redeem(issued.code(), "qa-tablet"))
                .satisfies(error -> {
                    assertThat(error.code()).isEqualTo("code_used");
                    assertThat(error.httpStatus()).isEqualTo(410);
                });
    }

    @Test
    void redeemAfterTtlRefusesWithCodeExpired() {
        IssuedCode issued = enrollment.issue(accountId);

        clock.advance(Duration.ofMinutes(10).plusMillis(1));

        assertThatExceptionOfType(SecurityException.class)
                .isThrownBy(() -> enrollment.redeem(issued.code(), "qa-laptop"))
                .satisfies(error -> {
                    assertThat(error.code()).isEqualTo("code_expired");
                    assertThat(error.httpStatus()).isEqualTo(410);
                });
    }

    @Test
    void redeemUnknownCodeRefusesWithUnauthorized() {
        assertThatExceptionOfType(SecurityException.class)
                .isThrownBy(() -> enrollment.redeem("AAAAAAAAAAAAAAAAAAAAAAAAAA", "qa-laptop"))
                .satisfies(error -> {
                    assertThat(error.code()).isEqualTo("unauthorized");
                    assertThat(error.httpStatus()).isEqualTo(401);
                });
    }

    @Test
    void redeemCanonicalizesCaseAndGrouping() {
        IssuedCode issued = enrollment.issue(accountId);
        String typed = " " + issued.code().toLowerCase().replaceAll("(.{4})(?=.)", "$1-") + "= ";

        RedeemResult result = enrollment.redeem(typed, "qa-laptop");

        assertThat(devices.verify(result.token()).accountId()).isEqualTo(accountId);
    }

    @Test
    void issueForUnknownAccountRefusesWithNotFound() {
        assertThatExceptionOfType(SecurityException.class)
                .isThrownBy(() -> enrollment.issue("ghost"))
                .satisfies(error -> {
                    assertThat(error.code()).isEqualTo("not_found");
                    assertThat(error.httpStatus()).isEqualTo(404);
                });
    }

    @Test
    void issueRejectsBlankAccountId() {
        assertThatThrownBy(() -> enrollment.issue(" "))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
