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

    @Test
    void createDefaultsLifecycleFields() {
        Session created = store.create("alice", "demo", "/tmp/demo");

        assertThat(created.pinned()).isFalse();
        assertThat(created.pinnedOrder()).isNull();
        assertThat(created.settledAt()).isNull();
        assertThat(created.snoozedUntil()).isNull();
        assertThat(created.archivedAt()).isNull();
        assertThat(created.autoSettle()).isTrue();
        assertThat(created.sortOrder()).isNull();
        assertThat(created.settledReason()).isNull();
        assertThat(created.autoSettleSuppressed()).isFalse();
    }

    @Test
    void patchAppliesOnlyGivenLifecycleFields() {
        Session created = store.create("alice", "demo", "/tmp/demo");

        Session pinned = store.patch(created.id(), lifecyclePatch(true, null, null, null, null, 3, null));

        assertThat(pinned.pinned()).isTrue();
        assertThat(pinned.pinnedOrder()).isEqualTo(3);
        assertThat(pinned.title()).isEqualTo("demo");
        assertThat(pinned.settledAt()).isNull();
        assertThat(pinned.snoozedUntil()).isNull();
        assertThat(pinned.archivedAt()).isNull();
        assertThat(pinned.autoSettle()).isTrue();
        assertThat(pinned.sortOrder()).isNull();
        assertThat(pinned.settledReason()).isNull();
        assertThat(pinned.autoSettleSuppressed()).isFalse();

        Session settled = store.patch(created.id(),
                lifecyclePatch(null, 42L, null, null, "manual", null, 7));

        assertThat(settled.pinned()).isTrue();
        assertThat(settled.pinnedOrder()).isEqualTo(3);
        assertThat(settled.settledAt()).isEqualTo(42L);
        assertThat(settled.settledReason()).isEqualTo("manual");
        assertThat(settled.sortOrder()).isEqualTo(7);
        assertThat(settled.autoSettle()).isTrue();
        assertThat(settled.snoozedUntil()).isNull();
    }

    @Test
    void patchSettledAtBumpsUpdatedAt() throws InterruptedException {
        Session created = store.create("alice", "demo", "/tmp/demo");
        Thread.sleep(5);

        Session patched = store.patch(created.id(),
                lifecyclePatch(null, 1_700_000_000_000L, null, null, "inactive", null, null));

        assertThat(patched.settledAt()).isEqualTo(1_700_000_000_000L);
        assertThat(patched.settledReason()).isEqualTo("inactive");
        assertThat(patched.updatedAt()).isGreaterThan(created.updatedAt());
        assertThat(store.get(created.id())).contains(patched);
    }

    @Test
    void patchLifecycleOnUnknownSessionThrows() {
        assertThatThrownBy(() -> store.patch("missing-session",
                lifecyclePatch(true, null, null, null, null, null, null)))
                .isInstanceOf(PluginException.class);
    }

    @Test
    void patchIsEmptyOnlyWhenEveryFieldIsNull() {
        assertThat(new SessionStore.Patch(null, null, null, null, null,
                null, null, null, null, null, null, null, null, null).isEmpty()).isTrue();
        assertThat(new SessionStore.Patch(null, null, null, null, null,
                true, null, null, null, null, null, null, null, null).isEmpty()).isFalse();
        assertThat(new SessionStore.Patch(null, null, null, null, null,
                null, null, 1L, null, null, null, null, null, null).isEmpty()).isFalse();
        assertThat(new SessionStore.Patch(null, null, null, null, null,
                null, null, null, null, null, null, null, null, true).isEmpty()).isFalse();
    }

    @Test
    void listOrdersByPinnedThenPositionsThenCreatedAt() {
        insertRow("b", 1, 1, null, 2000);
        insertRow("a", 1, 2, null, 1000);
        insertRow("c", 0, null, 2, 3000);
        insertRow("d", 0, null, 1, 4000);
        insertRow("e", 0, null, null, 5000);
        insertRow("f", 0, null, null, 6000);

        // Literal SQLite ordering: pinned DESC, then each position ASC with
        // unset (NULL) positions sorting first inside their group, then
        // created_at DESC.
        assertThat(store.list("alice"))
                .extracting(Session::id)
                .containsExactly("b", "a", "f", "e", "d", "c");
    }

    @Test
    void listStatusFilterMatrix() {
        long now = System.currentTimeMillis();
        store.create("alice", "active", "/tmp/1");
        Session staleSnooze = store.create("alice", "stale-snooze", "/tmp/2");
        store.patch(staleSnooze.id(), lifecyclePatch(null, null, now - 60_000, null, null, null, null));
        Session snoozed = store.create("alice", "snoozed", "/tmp/3");
        store.patch(snoozed.id(), lifecyclePatch(null, null, now + 3_600_000, null, null, null, null));
        Session settled = store.create("alice", "settled", "/tmp/4");
        store.patch(settled.id(), lifecyclePatch(null, now, null, null, "manual", null, null));
        Session settledPinned = store.create("alice", "settled-pinned", "/tmp/5");
        store.patch(settledPinned.id(), lifecyclePatch(true, now, null, null, "manual", null, null));
        Session archived = store.create("alice", "archived", "/tmp/6");
        store.patch(archived.id(), lifecyclePatch(null, null, null, now, null, null, null));
        Session settledSnoozed = store.create("alice", "settled-snoozed", "/tmp/7");
        store.patch(settledSnoozed.id(),
                lifecyclePatch(null, now, now + 3_600_000, null, "inactive", null, null));

        assertThat(store.list("alice", SessionStore.StatusFilter.ACTIVE))
                .extracting(Session::title)
                .containsExactlyInAnyOrder("active", "stale-snooze");
        assertThat(store.list("alice", SessionStore.StatusFilter.SNOOZED))
                .extracting(Session::title)
                .containsExactlyInAnyOrder("snoozed", "settled-snoozed");
        assertThat(store.list("alice", SessionStore.StatusFilter.SETTLED))
                .extracting(Session::title)
                .containsExactlyInAnyOrder("settled", "settled-pinned", "settled-snoozed");
        assertThat(store.list("alice", SessionStore.StatusFilter.ARCHIVED))
                .extracting(Session::title)
                .containsExactly("archived");
        assertThat(store.list("alice", SessionStore.StatusFilter.ALL))
                .hasSize(7);
        assertThat(store.list("alice"))
                .extracting(Session::title)
                .doesNotContain("archived")
                .hasSize(6);
        assertThat(store.list(SessionStore.StatusFilter.ALL))
                .extracting(Session::title)
                .contains("active", "archived", "settled-snoozed");
    }

    private void insertRow(String id, int pinned, Integer pinnedOrder, Integer sortOrder, long createdAt) {
        db.write(connection -> {
            try (java.sql.PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO jhin_sessions_sessions"
                            + "(id, account_id, title, workdir, model, provider_id, status,"
                            + " created_at, updated_at, pinned, pinned_order, sort_order)"
                            + " VALUES (?, 'alice', ?, '/tmp/w', NULL, NULL, 'active', ?, ?, ?, ?, ?)")) {
                insert.setString(1, id);
                insert.setString(2, id);
                insert.setLong(3, createdAt);
                insert.setLong(4, createdAt);
                insert.setInt(5, pinned);
                insert.setObject(6, pinnedOrder);
                insert.setObject(7, sortOrder);
                insert.executeUpdate();
            }
            return null;
        });
    }

    private static SessionStore.Patch lifecyclePatch(Boolean pinned, Long settledAt, Long snoozedUntil,
            Long archivedAt, String settledReason, Integer pinnedOrder, Integer sortOrder) {
        return new SessionStore.Patch(null, null, null, null, null,
                pinned, pinnedOrder, settledAt, snoozedUntil, archivedAt,
                null, sortOrder, settledReason, null);
    }
}
