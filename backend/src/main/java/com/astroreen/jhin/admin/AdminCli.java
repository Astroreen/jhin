package com.astroreen.jhin.admin;

import com.astroreen.jhin.core.accounts.Account;
import com.astroreen.jhin.core.accounts.AccountService;
import com.astroreen.jhin.core.accounts.DevicePrincipal;
import com.astroreen.jhin.core.accounts.DeviceService;
import com.astroreen.jhin.core.accounts.EnrollmentService;
import com.astroreen.jhin.core.accounts.IssueResult;
import java.io.PrintStream;
import java.time.Instant;
import java.util.List;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Админская CLI-логика (без System.exit — возвращает exit-код): create-account,
 * create-enrollment, list-accounts, list-devices, revoke-device. Удобно дёргать
 * программно в тестах (свои PrintStream'ы, без Spring).
 */
@Component
public class AdminCli {

    private final AccountService accounts;
    private final EnrollmentService enrollments;
    private final DeviceService devices;
    private final PrintStream out;
    private final PrintStream err;

    @Autowired
    public AdminCli(AccountService accounts, EnrollmentService enrollments, DeviceService devices) {
        this(accounts, enrollments, devices, System.out, System.err);
    }

    public AdminCli(
            AccountService accounts,
            EnrollmentService enrollments,
            DeviceService devices,
            PrintStream out,
            PrintStream err) {
        this.accounts = accounts;
        this.enrollments = enrollments;
        this.devices = devices;
        this.out = out;
        this.err = err;
    }

    /** Возвращает exit-код: 0 — успех, 1 — ошибка, 2 — неизвестная команда/usage. */
    public int run(String... args) {
        if (args.length == 0) {
            usage();
            return 2;
        }
        try {
            switch (args[0]) {
                case "create-account" -> {
                    if (args.length != 2) {
                        usage();
                        return 2;
                    }
                    out.println(accounts.createAccount(args[1]));
                }
                case "create-enrollment" -> {
                    if (args.length != 2) {
                        usage();
                        return 2;
                    }
                    Account account = resolveAccount(args[1]);
                    IssueResult issued = enrollments.issueEnrollment(account.id());
                    out.println("code: " + issued.code());
                    out.println("expires_at: " + Instant.ofEpochMilli(issued.expiresAt()));
                }
                case "list-accounts" -> {
                    if (args.length != 1) {
                        usage();
                        return 2;
                    }
                    listAccounts();
                }
                case "list-devices" -> {
                    if (args.length != 2) {
                        usage();
                        return 2;
                    }
                    listDevices(resolveAccount(args[1]));
                }
                case "revoke-device" -> {
                    if (args.length != 2) {
                        usage();
                        return 2;
                    }
                    if (!devices.revokeDevice(args[1])) {
                        err.println("unknown device: " + args[1]);
                        return 1;
                    }
                    out.println("revoked device " + args[1]);
                }
                default -> {
                    usage();
                    return 2;
                }
            }
            return 0;
        } catch (Exception e) {
            err.println(e.getMessage() != null ? e.getMessage() : e.toString());
            return 1;
        }
    }

    private Account resolveAccount(String nameOrId) {
        return accounts
                .findByName(nameOrId)
                .or(() -> accounts.findById(nameOrId))
                .orElseThrow(() -> new IllegalArgumentException("unknown account: " + nameOrId));
    }

    private void listAccounts() {
        out.printf("%-36s  %-16s  %-24s%n", "id", "name", "created_at");
        for (Account account : accounts.listAccounts()) {
            out.printf(
                    "%-36s  %-16s  %-24s%n",
                    account.id(), account.name(), Instant.ofEpochMilli(account.createdAt()));
        }
    }

    private void listDevices(Account account) {
        List<DevicePrincipal> devicesOfAccount = devices.listDevices(account.id());
        out.printf("%-36s  %-16s  %-24s  %s%n", "id", "name", "last_seen", "revoked");
        for (DevicePrincipal device : devicesOfAccount) {
            out.printf(
                    "%-36s  %-16s  %-24s  %s%n",
                    device.id(),
                    device.name(),
                    device.lastSeen() == null ? "-" : Instant.ofEpochMilli(device.lastSeen()),
                    device.revoked());
        }
    }

    private void usage() {
        err.println("usage: admin <command> [args]");
        err.println("commands:");
        err.println("  create-account <name>");
        err.println("  create-enrollment <accountNameOrId>");
        err.println("  list-accounts");
        err.println("  list-devices <account>");
        err.println("  revoke-device <deviceId>");
    }
}
