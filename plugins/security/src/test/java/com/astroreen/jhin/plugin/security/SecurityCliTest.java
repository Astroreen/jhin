/**
 * CLI coverage: the four admin commands through their registered handlers —
 * every happy path, then the refusal cases. The revoke happy path runs
 * against a device row created by the plugin's own enrollment service (the
 * QA script cannot do that yet: redemption needs the T28 HTTP route).
 */
package com.astroreen.jhin.plugin.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;

import com.astroreen.jhin.plugin.security.EnrollmentServiceImpl.RedeemResult;
import com.astroreen.jhin.plugin.security.api.SecurityException;
import com.astroreen.jhin.sdk.cli.CliCommandSpec;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SecurityCliTest {

    @TempDir
    Path tmp;

    private MutableClock clock;
    private TestDbAccess db;
    private AccountServiceImpl accounts;
    private EnrollmentServiceImpl enrollment;
    private DeviceServiceImpl devices;
    private final Map<String, CliCommandSpec> commands = new LinkedHashMap<>();
    private final ByteArrayOutputStream outBytes = new ByteArrayOutputStream();
    private final ByteArrayOutputStream errBytes = new ByteArrayOutputStream();
    private final PrintStream out = new PrintStream(outBytes, true, StandardCharsets.UTF_8);
    private final PrintStream err = new PrintStream(errBytes, true, StandardCharsets.UTF_8);

    @BeforeEach
    void setUp() {
        clock = new MutableClock(Instant.parse("2026-01-01T00:00:00Z"));
        db = TestDbAccess.open(tmp);
        db.migrate(Migrations.all());
        accounts = new AccountServiceImpl(db, clock);
        enrollment = new EnrollmentServiceImpl(db, clock);
        devices = new DeviceServiceImpl(db, clock);
        new SecurityCli(accounts, enrollment, devices)
                .register(spec -> commands.put(spec.name(), spec));
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void registerPublishesFourCommands() {
        assertThat(commands.keySet()).containsExactlyInAnyOrder(
                "create-account", "create-enrollment", "list-devices", "revoke-device");
    }

    @Test
    void createAccountPrintsNameAndId() {
        int code = run("create-account", List.of("alice"));

        assertThat(code).isEqualTo(0);
        String id = accounts.findByName("alice").orElseThrow().id();
        assertThat(stdout()).isEqualTo(
                "created account: alice (id: " + id + ")" + System.lineSeparator());
        assertThat(stderr()).isEmpty();
    }

    @Test
    void createAccountMissingArgumentFails() {
        int code = run("create-account", List.of());

        assertThat(code).isEqualTo(1);
        assertThat(stderr()).isEqualTo(
                "usage: create-account <name>" + System.lineSeparator());
    }

    @Test
    void createAccountDuplicateNameFails() {
        run("create-account", List.of("alice"));
        resetStreams();

        int code = run("create-account", List.of("alice"));

        assertThat(code).isEqualTo(1);
        assertThat(stderr()).contains("account name already exists: alice");
    }

    @Test
    void createEnrollmentPrintsCodeExactlyOnce() {
        run("create-account", List.of("alice"));
        resetStreams();

        int code = run("create-enrollment", List.of("alice"));

        assertThat(code).isEqualTo(0);
        assertThat(stderr()).isEmpty();
        String issued = issuedCode();
        assertThat(issued).isNotBlank();
        assertThat(countOccurrences(stdout(), issued)).isEqualTo(1);
        RedeemResult result = enrollment.redeem(issued, "qa-laptop");
        assertThat(result.token()).isNotBlank();
    }

    @Test
    void createEnrollmentResolvesByNameAndById() {
        run("create-account", List.of("alice"));
        String id = accounts.findByName("alice").orElseThrow().id();
        resetStreams();

        assertThat(run("create-enrollment", List.of("alice"))).isEqualTo(0);
        resetStreams();
        assertThat(run("create-enrollment", List.of(id))).isEqualTo(0);
    }

    @Test
    void createEnrollmentUnknownAccountFailsWithExactText() {
        int code = run("create-enrollment", List.of("ghost"));

        assertThat(code).isEqualTo(1);
        assertThat(stderr()).isEqualTo("unknown account: ghost" + System.lineSeparator());
    }

    @Test
    void listDevicesEmptyPrintsNoDevices() {
        run("create-account", List.of("alice"));
        resetStreams();

        assertThat(run("list-devices", List.of())).isEqualTo(0);
        assertThat(stdout()).isEqualTo("no devices" + System.lineSeparator());
        resetStreams();

        assertThat(run("list-devices", List.of("alice"))).isEqualTo(0);
        assertThat(stdout()).isEqualTo("no devices" + System.lineSeparator());
    }

    @Test
    void listDevicesShowsServiceCreatedDevice() {
        run("create-account", List.of("alice"));
        String accountId = accounts.findByName("alice").orElseThrow().id();
        String deviceId = enrollment.redeem(
                enrollment.issue(accountId).code(), "qa-laptop").principal().deviceId();
        resetStreams();

        assertThat(run("list-devices", List.of())).isEqualTo(0);
        assertThat(stdout()).contains(deviceId, "qa-laptop", "alice", "active");
        resetStreams();

        assertThat(run("list-devices", List.of("alice"))).isEqualTo(0);
        assertThat(stdout()).contains(deviceId, "qa-laptop", "alice", "active");
    }

    @Test
    void listDevicesUnknownAccountFailsWithExactText() {
        int code = run("list-devices", List.of("ghost"));

        assertThat(code).isEqualTo(1);
        assertThat(stderr()).isEqualTo("unknown account: ghost" + System.lineSeparator());
    }

    @Test
    void revokeDeviceConfirmsAndMarksServiceCreatedDevice() {
        run("create-account", List.of("alice"));
        String accountId = accounts.findByName("alice").orElseThrow().id();
        RedeemResult result = enrollment.redeem(
                enrollment.issue(accountId).code(), "qa-laptop");
        String deviceId = result.principal().deviceId();
        resetStreams();

        int code = run("revoke-device", List.of(deviceId));

        assertThat(code).isEqualTo(0);
        assertThat(stdout()).isEqualTo(
                "revoked device: " + deviceId + System.lineSeparator());
        assertThat(devices.list(null)).singleElement().satisfies(row -> {
            assertThat(row.id()).isEqualTo(deviceId);
            assertThat(row.revokedAt()).isNotNull();
        });
        assertThatExceptionOfType(SecurityException.class)
                .isThrownBy(() -> devices.verify(result.token()))
                .satisfies(error -> assertThat(error.code()).isEqualTo("forbidden"));
    }

    @Test
    void revokeDeviceUnknownIdFails() {
        int code = run("revoke-device", List.of("nope"));

        assertThat(code).isEqualTo(1);
        assertThat(stderr()).isEqualTo("unknown device: nope" + System.lineSeparator());
    }

    private int run(String name, List<String> args) {
        CliCommandSpec spec = commands.get(name);
        assertThat(spec).as("command %s is registered", name).isNotNull();
        return spec.handler().run(args, out, err);
    }

    private String stdout() {
        return outBytes.toString(StandardCharsets.UTF_8);
    }

    private String stderr() {
        return errBytes.toString(StandardCharsets.UTF_8);
    }

    private void resetStreams() {
        outBytes.reset();
        errBytes.reset();
    }

    /** Extracts the printed enrollment code from the {@code code: } line. */
    private String issuedCode() {
        return stdout().lines()
                .filter(line -> line.startsWith("code: "))
                .map(line -> line.substring("code: ".length()))
                .findFirst()
                .orElse("");
    }

    private static int countOccurrences(String haystack, String needle) {
        return haystack.split(Pattern.quote(needle), -1).length - 1;
    }
}
