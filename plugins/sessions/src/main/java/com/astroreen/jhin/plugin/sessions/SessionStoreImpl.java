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
import java.util.UUID;

final class SessionStoreImpl implements SessionStore {

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
        return listByAccount(null);
    }

    @Override
    public List<Session> list(String accountId) {
        return listByAccount(accountId);
    }

    @Override
    public Session patch(String id, Patch patch) {
        return applyPatch(null, id, patch);
    }

    @Override
    public Session patch(String accountId, String id, Patch patch) {
        return applyPatch(accountId, id, patch);
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

    private List<Session> listByAccount(String accountId) {
        String sql = accountId == null
                ? "SELECT * FROM jhin_sessions_sessions ORDER BY created_at DESC, id"
                : "SELECT * FROM jhin_sessions_sessions WHERE account_id = ?"
                        + " ORDER BY created_at DESC, id";
        return db.read(connection -> {
            List<Session> out = new ArrayList<>();
            try (PreparedStatement query = connection.prepareStatement(sql)) {
                if (accountId != null) {
                    query.setString(1, accountId);
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

    private Session applyPatch(String accountId, String id, Patch patch) {
        if (patch == null) {
            throw new IllegalArgumentException("patch must not be null");
        }
        Optional<Session> current = find(accountId, id);
        if (current.isEmpty()) {
            throw new PluginException("session " + id + " not found");
        }
        if (patch.isEmpty()) {
            return current.get();
        }
        String title = patch.title() != null ? patch.title() : current.get().title();
        String workdir = patch.workdir() != null ? patch.workdir() : current.get().workdir();
        String model = patch.model() != null ? patch.model() : current.get().model();
        String providerId = patch.providerId() != null ? patch.providerId() : current.get().providerId();
        String status = patch.status() != null ? patch.status() : current.get().status();
        long updatedAt = System.currentTimeMillis();
        return db.write(connection -> {
            try (PreparedStatement update = connection.prepareStatement(
                    "UPDATE jhin_sessions_sessions SET title = ?, workdir = ?, model = ?,"
                            + " provider_id = ?, status = ?, updated_at = ? WHERE id = ?")) {
                update.setString(1, title);
                update.setString(2, workdir);
                update.setString(3, model);
                update.setString(4, providerId);
                update.setString(5, status);
                update.setLong(6, updatedAt);
                update.setString(7, id);
                update.executeUpdate();
            }
            return new Session(id, current.get().accountId(), title, workdir,
                    model, providerId, status, current.get().createdAt(), updatedAt);
        });
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
                rs.getLong("updated_at"));
    }

    private static void requireText(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " must not be null or blank");
        }
    }
}
