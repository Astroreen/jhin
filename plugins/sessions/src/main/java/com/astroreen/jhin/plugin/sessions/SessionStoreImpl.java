/**
 * SQLite-backed {@link SessionStore} over the {@code jhin_sessions_sessions}
 * table. Reads go through {@code DbAccess.read}, writes through the serialized
 * {@code DbAccess.write} lane.
 */
package com.astroreen.jhin.plugin.sessions;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.db.DbAccess;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

final class SessionStoreImpl implements SessionStore {

    /** List order of every view: pinned first, then the manual positions. */
    private static final String LIST_ORDER =
            " ORDER BY pinned DESC, pinned_order ASC, sort_order ASC, created_at DESC, id";

    private final DbAccess db;

    SessionStoreImpl(DbAccess db) {
        this.db = db;
    }

    @Override
    public Session create(String accountId, String title, String workdir) {
        requireText(accountId, "accountId");
        requireText(title, "title");
        requireText(workdir, "workdir");
        String id = UUID.randomUUID().toString();
        long now = System.currentTimeMillis();
        return db.write(connection -> {
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO jhin_sessions_sessions"
                            + "(id, account_id, title, workdir, model, provider_id, status, created_at, updated_at)"
                            + " VALUES (?, ?, ?, ?, NULL, NULL, 'active', ?, ?)")) {
                insert.setString(1, id);
                insert.setString(2, accountId);
                insert.setString(3, title);
                insert.setString(4, workdir);
                insert.setLong(5, now);
                insert.setLong(6, now);
                insert.executeUpdate();
            }
            return new Session(id, accountId, title, workdir, null, null, "active", now, now);
        });
    }

    @Override
    public Session create(String title, String workdir) {
        return create(LOCAL_ACCOUNT, title, workdir);
    }

    @Override
    public Optional<Session> get(String id) {
        return find(null, id);
    }

    @Override
    public Optional<Session> get(String accountId, String id) {
        return find(accountId, id);
    }

    @Override
    public List<Session> list() {
        return listByAccount(null, null);
    }

    @Override
    public List<Session> list(String accountId) {
        return listByAccount(accountId, null);
    }

    @Override
    public List<Session> list(StatusFilter filter) {
        return listByAccount(null, filter);
    }

    @Override
    public List<Session> list(String accountId, StatusFilter filter) {
        return listByAccount(accountId, filter);
    }

    @Override
    public Session patch(String id, Patch patch) {
        return applyPatch(null, id, patch, Set.of());
    }

    @Override
    public Session patch(String accountId, String id, Patch patch) {
        return applyPatch(accountId, id, patch, Set.of());
    }

    @Override
    public Session patch(String id, Patch patch, Set<ClearableField> clears) {
        return applyPatch(null, id, patch, clears);
    }

    @Override
    public Session patch(String accountId, String id, Patch patch, Set<ClearableField> clears) {
        return applyPatch(accountId, id, patch, clears);
    }

    @Override
    public boolean delete(String id) {
        return remove(null, id);
    }

    @Override
    public boolean delete(String accountId, String id) {
        return remove(accountId, id);
    }

    private Optional<Session> find(String accountId, String id) {
        String sql = accountId == null
                ? "SELECT * FROM jhin_sessions_sessions WHERE id = ?"
                : "SELECT * FROM jhin_sessions_sessions WHERE id = ? AND account_id = ?";
        return db.read(connection -> {
            try (PreparedStatement query = connection.prepareStatement(sql)) {
                query.setString(1, id);
                if (accountId != null) {
                    query.setString(2, accountId);
                }
                try (ResultSet rs = query.executeQuery()) {
                    return rs.next() ? Optional.of(map(rs)) : Optional.empty();
                }
            }
        });
    }

    private List<Session> listByAccount(String accountId, StatusFilter filter) {
        long now = System.currentTimeMillis();
        List<String> where = new ArrayList<>();
        List<Object> params = new ArrayList<>();
        if (accountId != null) {
            where.add("account_id = ?");
            params.add(accountId);
        }
        if (filter == null) {
            where.add("archived_at IS NULL");
        } else {
            switch (filter) {
                case ACTIVE -> {
                    where.add("settled_at IS NULL AND archived_at IS NULL"
                            + " AND (snoozed_until IS NULL OR snoozed_until <= ?)");
                    params.add(now);
                }
                case SNOOZED -> {
                    where.add("snoozed_until > ?");
                    params.add(now);
                }
                case SETTLED -> where.add("settled_at IS NOT NULL");
                case ARCHIVED -> where.add("archived_at IS NOT NULL");
                case ALL -> { }
            }
        }
        String sql = "SELECT * FROM jhin_sessions_sessions"
                + (where.isEmpty() ? "" : " WHERE " + String.join(" AND ", where))
                + LIST_ORDER;
        return db.read(connection -> {
            List<Session> out = new ArrayList<>();
            try (PreparedStatement query = connection.prepareStatement(sql)) {
                for (int i = 0; i < params.size(); i++) {
                    query.setObject(i + 1, params.get(i));
                }
                try (ResultSet rs = query.executeQuery()) {
                    while (rs.next()) {
                        out.add(map(rs));
                    }
                }
            }
            return List.copyOf(out);
        });
    }

    private Session applyPatch(String accountId, String id, Patch patch, Set<ClearableField> clears) {
        if (patch == null) {
            throw new IllegalArgumentException("patch must not be null");
        }
        if (clears == null) {
            throw new IllegalArgumentException("clears must not be null");
        }
        rejectConflict(patch, clears);
        Optional<Session> current = find(accountId, id);
        if (current.isEmpty()) {
            throw new PluginException("session " + id + " not found");
        }
        if (patch.isEmpty() && clears.isEmpty()) {
            return current.get();
        }
        Session base = current.get();
        String title = patch.title() != null ? patch.title() : base.title();
        String workdir = patch.workdir() != null ? patch.workdir() : base.workdir();
        String model = patch.model() != null ? patch.model() : base.model();
        String providerId = patch.providerId() != null ? patch.providerId() : base.providerId();
        String status = patch.status() != null ? patch.status() : base.status();
        boolean pinned = patch.pinned() != null ? patch.pinned() : base.pinned();
        Integer pinnedOrder = applyOne(patch.pinnedOrder(), base.pinnedOrder(),
                clears.contains(ClearableField.PINNED_ORDER));
        Long settledAt = applyOne(patch.settledAt(), base.settledAt(),
                clears.contains(ClearableField.SETTLED_AT));
        Long snoozedUntil = applyOne(patch.snoozedUntil(), base.snoozedUntil(),
                clears.contains(ClearableField.SNOOZED_UNTIL));
        Long archivedAt = applyOne(patch.archivedAt(), base.archivedAt(),
                clears.contains(ClearableField.ARCHIVED_AT));
        boolean autoSettle = patch.autoSettle() != null ? patch.autoSettle() : base.autoSettle();
        Integer sortOrder = applyOne(patch.sortOrder(), base.sortOrder(),
                clears.contains(ClearableField.SORT_ORDER));
        String settledReason = applyOne(patch.settledReason(), base.settledReason(),
                clears.contains(ClearableField.SETTLED_REASON));
        boolean autoSettleSuppressed = patch.autoSettleSuppressed() != null
                ? patch.autoSettleSuppressed() : base.autoSettleSuppressed();
        long updatedAt = System.currentTimeMillis();
        return db.write(connection -> {
            try (PreparedStatement update = connection.prepareStatement(
                    "UPDATE jhin_sessions_sessions SET title = ?, workdir = ?, model = ?,"
                            + " provider_id = ?, status = ?, pinned = ?, pinned_order = ?,"
                            + " settled_at = ?, snoozed_until = ?, archived_at = ?,"
                            + " auto_settle = ?, sort_order = ?, settled_reason = ?,"
                            + " auto_settle_suppressed = ?, updated_at = ? WHERE id = ?")) {
                update.setString(1, title);
                update.setString(2, workdir);
                update.setString(3, model);
                update.setString(4, providerId);
                update.setString(5, status);
                update.setBoolean(6, pinned);
                update.setObject(7, pinnedOrder);
                update.setObject(8, settledAt);
                update.setObject(9, snoozedUntil);
                update.setObject(10, archivedAt);
                update.setBoolean(11, autoSettle);
                update.setObject(12, sortOrder);
                update.setString(13, settledReason);
                update.setBoolean(14, autoSettleSuppressed);
                update.setLong(15, updatedAt);
                update.setString(16, id);
                update.executeUpdate();
            }
            return new Session(id, base.accountId(), title, workdir,
                    model, providerId, status, base.createdAt(), updatedAt,
                    pinned, pinnedOrder, settledAt, snoozedUntil, archivedAt,
                    autoSettle, sortOrder, settledReason, autoSettleSuppressed);
        });
    }

    /**
     * Resolves one column of a clear-aware patch: {@code null} when the field
     * is cleared, otherwise the patched value or the current one.
     */
    private static <T> T applyOne(T patched, T base, boolean clear) {
        if (clear) {
            return null;
        }
        return patched != null ? patched : base;
    }

    /** Rejects a patch that both sets and clears the same field. */
    private static void rejectConflict(Patch patch, Set<ClearableField> clears) {
        if (clears.isEmpty()) {
            return;
        }
        rejectConflict(patch.pinnedOrder() != null, clears.contains(ClearableField.PINNED_ORDER), "pinnedOrder");
        rejectConflict(patch.settledAt() != null, clears.contains(ClearableField.SETTLED_AT), "settledAt");
        rejectConflict(patch.settledReason() != null, clears.contains(ClearableField.SETTLED_REASON), "settledReason");
        rejectConflict(patch.snoozedUntil() != null, clears.contains(ClearableField.SNOOZED_UNTIL), "snoozedUntil");
        rejectConflict(patch.archivedAt() != null, clears.contains(ClearableField.ARCHIVED_AT), "archivedAt");
        rejectConflict(patch.sortOrder() != null, clears.contains(ClearableField.SORT_ORDER), "sortOrder");
    }

    private static void rejectConflict(boolean set, boolean clear, String field) {
        if (set && clear) {
            throw new IllegalArgumentException(field + " must not be set and cleared at once");
        }
    }

    private boolean remove(String accountId, String id) {
        String sql = accountId == null
                ? "DELETE FROM jhin_sessions_sessions WHERE id = ?"
                : "DELETE FROM jhin_sessions_sessions WHERE id = ? AND account_id = ?";
        return db.write(connection -> {
            try (PreparedStatement delete = connection.prepareStatement(sql)) {
                delete.setString(1, id);
                if (accountId != null) {
                    delete.setString(2, accountId);
                }
                if (delete.executeUpdate() <= 0) {
                    return false;
                }
            }
            try (PreparedStatement wipe = connection.prepareStatement(
                    "DELETE FROM jhin_sessions_events WHERE session_id = ?")) {
                wipe.setString(1, id);
                wipe.executeUpdate();
            }
            return true;
        });
    }

    private static Session map(ResultSet rs) throws SQLException {
        return new Session(
                rs.getString("id"),
                rs.getString("account_id"),
                rs.getString("title"),
                rs.getString("workdir"),
                rs.getString("model"),
                rs.getString("provider_id"),
                rs.getString("status"),
                rs.getLong("created_at"),
                rs.getLong("updated_at"),
                rs.getBoolean("pinned"),
                nullableInt(rs, "pinned_order"),
                nullableLong(rs, "settled_at"),
                nullableLong(rs, "snoozed_until"),
                nullableLong(rs, "archived_at"),
                rs.getBoolean("auto_settle"),
                nullableInt(rs, "sort_order"),
                rs.getString("settled_reason"),
                rs.getBoolean("auto_settle_suppressed"));
    }

    private static Integer nullableInt(ResultSet rs, String column) throws SQLException {
        int value = rs.getInt(column);
        return rs.wasNull() ? null : value;
    }

    private static Long nullableLong(ResultSet rs, String column) throws SQLException {
        long value = rs.getLong(column);
        return rs.wasNull() ? null : value;
    }

    private static void requireText(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " must not be null or blank");
        }
    }
}