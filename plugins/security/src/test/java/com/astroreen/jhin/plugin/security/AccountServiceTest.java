/**
 * Account directory coverage: create, unique-name conflict and lookups.
 */
package com.astroreen.jhin.plugin.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.plugin.security.api.AccountDirectory.Account;
import com.astroreen.jhin.plugin.security.api.SecurityException;
import java.time.Clock;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;

class AccountServiceTest {

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private AccountServiceImpl accounts;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        db.migrate(Migrations.all());
        accounts = new AccountServiceImpl(db, Clock.systemUTC());
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void createGeneratesIdAndTimestamp() {
        Account created = accounts.create("alice");

        assertThat(created.id()).isNotBlank();
        assertThat(created.name()).isEqualTo("alice");
        assertThat(created.createdAt()).isPositive();
        assertThat(accounts.findById(created.id())).contains(created);
    }

    @Test
    void createRejectsBlankName() {
        assertThatThrownBy(() -> accounts.create(" "))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> accounts.create(null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void createWithTakenNameFailsWithConflict() {
        accounts.create("alice");

        assertThatExceptionOfType(SecurityException.class)
                .isThrownBy(() -> accounts.create("alice"))
                .satisfies(error -> {
                    assertThat(error.code()).isEqualTo("conflict");
                    assertThat(error.httpStatus()).isEqualTo(409);
                });
    }

    @Test
    void findByNameAndListAccounts() {
        Account alice = accounts.create("alice");
        Account bob = accounts.create("bob");

        Optional<Account> found = accounts.findByName("bob");
        assertThat(found).contains(bob);
        assertThat(accounts.findByName("ghost")).isEmpty();
        assertThat(accounts.findById("ghost")).isEmpty();

        List<Account> all = accounts.list();
        assertThat(all).containsExactly(alice, bob);
    }
}
