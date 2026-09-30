/**
 * CRUD coverage of the session store: create, list, get, patch and delete, both
 * scoped by account and unscoped.
 */
package com.astroreen.jhin.plugin.sessions;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.PluginException;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;

class SessionStoreTest {

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private SessionStore store;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        db.migrate(Migrations.all());
        store = new SessionStoreImpl(db);
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void createGeneratesIdAndDefaults() {
        Session created = store.create("alice", "demo", "/tmp/demo");

        assertThat(created.id()).isNotBlank();
        assertThat(created.accountId()).isEqualTo("alice");
        assertThat(created.title()).isEqualTo("demo");
        assertThat(created.workdir()).isEqualTo("/tmp/demo");
        assertThat(created.model()).isNull();
        assertThat(created.providerId()).isNull();
        assertThat(created.status()).isEqualTo("active");
        assertThat(created.createdAt()).isPositive();
        assertThat(created.updatedAt()).isEqualTo(created.createdAt());
    }

    @Test
    void createWithoutAccountUsesLocalAccount() {
        Session created = store.create("demo", "/tmp/demo");

        assertThat(created.accountId()).isEqualTo(SessionStore.LOCAL_ACCOUNT);
    }

    @Test
    void createRejectsBlankArguments() {
        assertThatThrownBy(() -> store.create(" ", "demo", "/tmp"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> store.create("alice", "", "/tmp"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> store.create("alice", "demo", " "))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void getReturnsCreatedSession() {
        Session created = store.create("alice", "demo", "/tmp/demo");

        Optional<Session> found = store.get(created.id());

        assertThat(found).contains(created);
    }

    @Test
    void getWithAccountIsScopedToOwner() {
        Session created = store.create("alice", "demo", "/tmp/demo");

        assertThat(store.get("alice", created.id())).contains(created);
        assertThat(store.get("bob", created.id())).isEmpty();
        assertThat(store.get(created.id() + "-missing")).isEmpty();
    }

    @Test
    void listReturnsAllAndScopedViews() {
        Session first = store.create("alice", "first", "/tmp/1");
        Session second = store.create("alice", "second", "/tmp/2");
        Session third = store.create("bob", "third", "/tmp/3");

        List<Session> all = store.list();
        assertThat(all).hasSize(3).contains(first, second, third);
        List<Session> alice = store.list("alice");
        assertThat(alice).hasSize(2).contains(first, second);
        assertThat(store.list("bob")).containsExactly(third);
    }

    @Test
    void patchUpdatesOnlyGivenFieldsAndBumpsUpdatedAt() {
        Session created = store.create("alice", "demo", "/tmp/demo");

        Session patched = store.patch(created.id(),
                new SessionStore.Patch("renamed", null, "m1", null, "archived"));

        assertThat(patched.id()).isEqualTo(created.id());
        assertThat(patched.accountId()).isEqualTo(created.accountId());
        assertThat(patched.title()).isEqualTo("renamed");
        assertThat(patched.workdir()).isEqualTo("/tmp/demo");
        assertThat(patched.model()).isEqualTo("m1");
        assertThat(patched.providerId()).isNull();
        assertThat(patched.status()).isEqualTo("archived");
        assertThat(patched.createdAt()).isEqualTo(created.createdAt());
        assertThat(patched.updatedAt()).isGreaterThanOrEqualTo(created.updatedAt());
        assertThat(store.get(created.id())).contains(patched);
    }

    @Test
    void patchWithAccountIsScopedToOwner() {
        Session created = store.create("alice", "demo", "/tmp/demo");

        assertThatThrownBy(() -> store.patch("bob", created.id(),
                new SessionStore.Patch("x", null, null, null, null)))
                .isInstanceOf(PluginException.class);
        assertThatThrownBy(() -> store.patch(created.id() + "-missing",
                new SessionStore.Patch("x", null, null, null, null)))
                .isInstanceOf(PluginException.class);
    }

    @Test
    void patchWithoutChangesReturnsCurrentSession() {
        Session created = store.create("alice", "demo", "/tmp/demo");

        Session patched = store.patch(created.id(), new SessionStore.Patch(null, null, null, null, null));

        assertThat(patched).isEqualTo(created);
    }

    @Test
    void deleteRemovesSessionAndIsScoped() {
        Session created = store.create("alice", "demo", "/tmp/demo");

        assertThat(store.delete("bob", created.id())).isFalse();
        assertThat(store.get(created.id())).isPresent();
        assertThat(store.delete(created.id())).isTrue();
        assertThat(store.get(created.id())).isEmpty();
        assertThat(store.delete(created.id())).isFalse();
    }
}
