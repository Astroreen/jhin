package com.astroreen.jhin.admin;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.core.accounts.AccountService;
import com.astroreen.jhin.core.accounts.DevicePrincipal;
import com.astroreen.jhin.core.accounts.DeviceService;
import com.astroreen.jhin.core.accounts.EnrollmentException;
import com.astroreen.jhin.core.accounts.EnrollmentException.Reason;
import com.astroreen.jhin.core.accounts.EnrollResult;
import com.astroreen.jhin.core.accounts.EnrollmentService;
import com.astroreen.jhin.core.accounts.Hashes;
import com.astroreen.jhin.core.accounts.IssueResult;
import com.astroreen.jhin.core.accounts.IssuedDevice;
import com.astroreen.jhin.core.db.DatabaseConfig;
import com.astroreen.jhin.core.db.MigrationRunner;
import com.astroreen.jhin.core.db.WriteQueue;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.Optional;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;

class AdminCliTest {

    @TempDir
    Path jhinHome;

    private DataSource dataSource;
    private WriteQueue writeQueue;
    private AccountService accounts;
    private EnrollmentService enrollments;
    private DeviceService devices;
    private ByteArrayOutputStream outBuffer;
    private ByteArrayOutputStream errBuffer;
    private AdminCli cli;

    @BeforeEach
    void setUp() throws Exception {
        dataSource = DatabaseConfig.createDataSource(jhinHome);
        new MigrationRunner(dataSource).migrate();
        writeQueue = new WriteQueue();
        JdbcClient jdbcClient = JdbcClient.create(dataSource);
        accounts = new AccountService(jdbcClient, writeQueue);
        enrollments = new EnrollmentService(jdbcClient, writeQueue);
        devices = new DeviceService(jdbcClient, writeQueue, event -> {});
        outBuffer = new ByteArrayOutputStream();
        errBuffer = new ByteArrayOutputStream();
        cli = new AdminCli(
                accounts,
                enrollments,
                devices,
                new PrintStream(outBuffer, true, StandardCharsets.UTF_8),
                new PrintStream(errBuffer, true, StandardCharsets.UTF_8));
    }

    @AfterEach
    void tearDown() {
        writeQueue.close();
    }

    @Test
    void enrollmentConsumesOnceThenUsed() {
        String accountId = accounts.createAccount("alice");
        IssueResult issued = enrollments.issueEnrollment(accountId);

        EnrollResult consumed = enrollments.consumeEnrollment(issued.code());

        assertThat(consumed.accountId()).isEqualTo(accountId);
        assertThatThrownBy(() -> enrollments.consumeEnrollment(issued.code()))
                .isInstanceOf(EnrollmentException.class)
                .extracting(e -> ((EnrollmentException) e).reason())
                .isEqualTo(Reason.USED);
    }

    @Test
    void expiredEnrollmentCodeIsRejected() throws Exception {
        String accountId = accounts.createAccount("alice");
        IssueResult issued = enrollments.issueEnrollment(accountId);

        try (Connection connection = dataSource.getConnection();
                PreparedStatement statement =
                        connection.prepareStatement("UPDATE enrollment_codes SET expires_at = ?")) {
            statement.setLong(1, System.currentTimeMillis() - 1);
            statement.executeUpdate();
        }

        assertThatThrownBy(() -> enrollments.consumeEnrollment(issued.code()))
                .isInstanceOf(EnrollmentException.class)
                .extracting(e -> ((EnrollmentException) e).reason())
                .isEqualTo(Reason.EXPIRED);
    }

    @Test
    void unknownEnrollmentCodeIsRejected() {
        String accountId = accounts.createAccount("alice");
        enrollments.issueEnrollment(accountId);

        assertThatThrownBy(() -> enrollments.consumeEnrollment("JBSWY3DPEHPK3PXPJBSWY3DP"))
                .isInstanceOf(EnrollmentException.class)
                .extracting(e -> ((EnrollmentException) e).reason())
                .isEqualTo(Reason.INVALID);
    }

    @Test
    void deviceLookupTouchAndRevoke() {
        String accountId = accounts.createAccount("alice");
        IssuedDevice issued = devices.issueDevice(accountId, "laptop");

        Optional<DevicePrincipal> found = devices.lookup(issued.token());
        assertThat(found).isPresent();
        assertThat(found.get().id()).isEqualTo(issued.id());
        assertThat(found.get().accountId()).isEqualTo(accountId);
        assertThat(found.get().name()).isEqualTo("laptop");
        assertThat(found.get().revoked()).isFalse();
        assertThat(devices.lookup("wrong")).isEmpty();

        devices.touch(issued.id(), "remote-host-1");
        DevicePrincipal touched = devices.listDevices(accountId).get(0);
        assertThat(touched.lastSeen()).isNotNull();
        assertThat(touched.lastIp()).isEqualTo("remote-host-1");

        assertThat(devices.revokeDevice(issued.id())).isTrue();
        assertThat(devices.lookup(issued.token())).isEmpty();
    }

    @Test
    void plaintextSecretsAreNeverStored() throws Exception {
        String accountId = accounts.createAccount("alice");
        IssueResult issued = enrollments.issueEnrollment(accountId);
        IssuedDevice device = devices.issueDevice(accountId, "laptop");

        String codeHash = querySingleString("SELECT code_hash FROM enrollment_codes");
        String tokenHash = querySingleString("SELECT token_hash FROM devices");

        assertThat(codeHash).hasSize(64).matches("[0-9a-f]{64}").isNotEqualTo(issued.code());
        assertThat(tokenHash).hasSize(64).matches("[0-9a-f]{64}").isNotEqualTo(device.token());
        assertThat(codeHash).isEqualTo(Hashes.sha256Hex(issued.code()));
        assertThat(tokenHash).isEqualTo(Hashes.sha256Hex(device.token()));
    }

    @Test
    void enrollmentCodeIsBase32WithFixedLength() {
        String accountId = accounts.createAccount("alice");

        IssueResult issued = enrollments.issueEnrollment(accountId);

        assertThat(issued.code()).matches("^[A-Z2-7]+$").hasSize(26);
    }

    @Test
    void cliDispatchAndUnknownCommandUsage() {
        resetBuffers();
        assertThat(cli.run("create-account", "alice")).isZero();
        String accountId = out().trim();
        assertThat(accountId).matches("[0-9a-f-]{36}");

        resetBuffers();
        assertThat(cli.run("create-enrollment", "alice")).isZero();
        assertThat(out()).contains("code: ").contains("expires_at: ");
        assertThat(err()).isEmpty();

        resetBuffers();
        assertThat(cli.run("list-accounts")).isZero();
        assertThat(out()).contains("alice").contains(accountId);

        resetBuffers();
        assertThat(cli.run("bogus-command")).isEqualTo(2);
        assertThat(err()).contains("usage:");

        resetBuffers();
        assertThat(cli.run()).isEqualTo(2);
        assertThat(err()).contains("usage:");

        resetBuffers();
        assertThat(cli.run("create-account", "bob", "extra")).isEqualTo(2);
    }

    private void resetBuffers() {
        outBuffer.reset();
        errBuffer.reset();
    }

    private String out() {
        return outBuffer.toString(StandardCharsets.UTF_8);
    }

    private String err() {
        return errBuffer.toString(StandardCharsets.UTF_8);
    }

    private String querySingleString(String sql) throws Exception {
        try (Connection connection = dataSource.getConnection();
                Statement statement = connection.createStatement();
                ResultSet rs = statement.executeQuery(sql)) {
            assertThat(rs.next()).isTrue();
            return rs.getString(1);
        }
    }
}
