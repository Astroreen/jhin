/**
 * Host CLI commands of the security plugin — the admin entry point that
 * replaces the v1 {@code jhin-admin} tool. Four commands are registered on
 * {@link com.astroreen.jhin.sdk.cli.CliRegistry} during
 * {@link SecurityPlugin#start}: {@code create-account <name>},
 * {@code create-enrollment <account>}, {@code list-devices [account]} and
 * {@code revoke-device <deviceId>}.
 *
 * <p><b>Service wiring.</b> The handlers use direct references to the
 * plugin's own service implementations, handed over by
 * {@link SecurityPlugin#start} — the plugin constructs them, so no
 * {@code ServiceRegistry} lookup indirection is needed and the CLI sees the
 * exact instances the routes will see.
 *
 * <p><b>Account arguments.</b> Every {@code <account>} argument is resolved
 * deterministically: exact account id first, then exact account name. One
 * input form covers both, with no guessing.
 *
 * <p><b>Secrets.</b> The enrollment code is printed to stdout exactly once,
 * on its own {@code code: } line, and is never passed to a logger — the
 * kernel log stays code-free.
 *
 * <p><b>Exit codes.</b> 0 on success, 1 on any bad input or unknown entity;
 * the kernel propagates the handler's return value as the process exit code.
 */
package com.astroreen.jhin.plugin.security;

import com.astroreen.jhin.plugin.security.EnrollmentServiceImpl.IssuedCode;
import com.astroreen.jhin.plugin.security.api.AccountDirectory.Account;
import com.astroreen.jhin.plugin.security.api.SecurityException;
import com.astroreen.jhin.sdk.cli.CliCommandSpec;
import com.astroreen.jhin.sdk.cli.CliRegistry;
import java.io.PrintStream;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

final class SecurityCli {

    /** Exit code of a command that did what it was asked. */
    static final int EXIT_OK = 0;

    /** Exit code of a command with bad input or an unknown entity. */
    static final int EXIT_BAD_INPUT = 1;

    private final AccountServiceImpl accounts;
    private final EnrollmentServiceImpl enrollment;
    private final DeviceServiceImpl devices;

    SecurityCli(AccountServiceImpl accounts, EnrollmentServiceImpl enrollment,
            DeviceServiceImpl devices) {
        this.accounts = accounts;
        this.enrollment = enrollment;
        this.devices = devices;
    }

    /**
     * Registers the four admin commands on the host CLI registry. Called once
     * from {@link SecurityPlugin#start}.
     *
     * @param cli the CLI registry of this plugin's context
     */
    void register(CliRegistry cli) {
        cli.command(new CliCommandSpec("create-account", "<name>",
                "create an account", this::createAccount));
        cli.command(new CliCommandSpec("create-enrollment", "<account>",
                "issue a single-use enrollment code (account id or name)",
                this::createEnrollment));
        cli.command(new CliCommandSpec("list-devices", "[account]",
                "list enrolled devices (all, or one account by id or name)",
                this::listDevices));
        cli.command(new CliCommandSpec("revoke-device", "<deviceId>",
                "revoke a device by id", this::revokeDevice));
    }

    /**
     * {@code create-account <name>}: creates an account and prints its id and
     * name. Fails on a missing argument and on a name that is already taken.
     */
    private int createAccount(List<String> args, PrintStream out, PrintStream err) {
        if (args.size() != 1 || args.get(0).isBlank()) {
            err.println("usage: create-account <name>");
            return EXIT_BAD_INPUT;
        }
        try {
            Account account = accounts.create(args.get(0));
            out.println("created account: " + account.name() + " (id: " + account.id() + ")");
            return EXIT_OK;
        } catch (SecurityException error) {
            err.println(error.getMessage());
            return EXIT_BAD_INPUT;
        }
    }

    /**
     * {@code create-enrollment <account>}: issues a single-use enrollment
     * code for an account resolved by id, then by name. The code is printed
     * to stdout exactly once and never logged. Fails with
     * {@code unknown account: <arg>} when nothing matches.
     */
    private int createEnrollment(List<String> args, PrintStream out, PrintStream err) {
        if (args.size() != 1 || args.get(0).isBlank()) {
            err.println("usage: create-enrollment <account>");
            return EXIT_BAD_INPUT;
        }
        String ref = args.get(0);
        Optional<Account> account = resolveAccount(ref);
        if (account.isEmpty()) {
            err.println("unknown account: " + ref);
            return EXIT_BAD_INPUT;
        }
        try {
            IssuedCode issued = enrollment.issue(account.get().id());
            out.println("issued enrollment code for " + account.get().name()
                    + " (id: " + account.get().id() + "), valid until "
                    + Instant.ofEpochMilli(issued.expiresAt()));
            out.println("code: " + issued.code());
            return EXIT_OK;
        } catch (SecurityException error) {
            err.println(error.getMessage());
            return EXIT_BAD_INPUT;
        }
    }

    /**
     * {@code list-devices [account]}: prints one row per device (id, name,
     * account, last seen, status) for every device or just one account,
     * resolved by id, then by name. Prints {@code no devices} when nothing
     * matches. Fails with {@code unknown account: <arg>} on a bad filter.
     */
    private int listDevices(List<String> args, PrintStream out, PrintStream err) {
        if (args.size() > 1 || (args.size() == 1 && args.get(0).isBlank())) {
            err.println("usage: list-devices [account]");
            return EXIT_BAD_INPUT;
        }
        String accountId = null;
        if (args.size() == 1) {
            String ref = args.get(0);
            Optional<Account> account = resolveAccount(ref);
            if (account.isEmpty()) {
                err.println("unknown account: " + ref);
                return EXIT_BAD_INPUT;
            }
            accountId = account.get().id();
        }
        List<DeviceServiceImpl.DeviceRow> rows = devices.list(accountId);
        if (rows.isEmpty()) {
            out.println("no devices");
            return EXIT_OK;
        }
        out.println(String.format("%-36s %-12s %-12s %-20s %s",
                "ID", "NAME", "ACCOUNT", "LAST SEEN", "STATUS"));
        for (DeviceServiceImpl.DeviceRow row : rows) {
            out.println(String.format("%-36s %-12s %-12s %-20s %s",
                    row.id(),
                    row.name(),
                    row.accountName() == null ? "-" : row.accountName(),
                    Instant.ofEpochMilli(row.lastSeenAt()),
                    row.revokedAt() == null ? "active" : "revoked"));
        }
        return EXIT_OK;
    }

    /**
     * {@code revoke-device <deviceId>}: revokes a device and confirms on
     * stdout. Idempotent — revoking a revoked device confirms again. Fails
     * with {@code unknown device: <deviceId>} when the id matches no row.
     */
    private int revokeDevice(List<String> args, PrintStream out, PrintStream err) {
        if (args.size() != 1 || args.get(0).isBlank()) {
            err.println("usage: revoke-device <deviceId>");
            return EXIT_BAD_INPUT;
        }
        String deviceId = args.get(0);
        if (!devices.revoke(deviceId)) {
            err.println("unknown device: " + deviceId);
            return EXIT_BAD_INPUT;
        }
        out.println("revoked device: " + deviceId);
        return EXIT_OK;
    }

    /**
     * Resolves an account argument: exact id first, then exact name.
     *
     * @param ref the user-typed account id or name
     * @return the matching account, or empty when neither lookup matches
     */
    private Optional<Account> resolveAccount(String ref) {
        return accounts.findById(ref).or(() -> accounts.findByName(ref));
    }
}
