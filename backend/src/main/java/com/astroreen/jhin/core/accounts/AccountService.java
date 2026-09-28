package com.astroreen.jhin.core.accounts;

import com.astroreen.jhin.core.db.WriteQueue;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.sql.ResultSet;
import java.sql.SQLException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

@Service
public class AccountService {

    private static final String SQL_INSERT = "INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)";
    private static final String SQL_BY_ID = "SELECT id, name, created_at FROM accounts WHERE id = ?";
    private static final String SQL_BY_NAME = "SELECT id, name, created_at FROM accounts WHERE name = ?";
    private static final String SQL_LIST = "SELECT id, name, created_at FROM accounts ORDER BY created_at, id";

    private final JdbcClient jdbcClient;
    private final WriteQueue writeQueue;

    @Autowired
    public AccountService(JdbcClient jdbcClient, WriteQueue writeQueue) {
        this.jdbcClient = jdbcClient;
        this.writeQueue = writeQueue;
    }

    public String createAccount(String name) {
        String id = UUID.randomUUID().toString();
        long createdAt = System.currentTimeMillis();
        await(writeQueue.submit(() -> {
            jdbcClient.sql(SQL_INSERT).param(id).param(name).param(createdAt).update();
            return id;
        }));
        return id;
    }

    public Optional<Account> findById(String id) {
        return jdbcClient.sql(SQL_BY_ID).param(id).query(AccountService::mapRow).optional();
    }

    public Optional<Account> findByName(String name) {
        return jdbcClient.sql(SQL_BY_NAME).param(name).query(AccountService::mapRow).optional();
    }

    public List<Account> listAccounts() {
        return jdbcClient.sql(SQL_LIST).query(AccountService::mapRow).list();
    }

    private static Account mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new Account(rs.getString("id"), rs.getString("name"), rs.getLong("created_at"));
    }

    private static <T> T await(CompletableFuture<T> future) {
        try {
            return future.join();
        } catch (CompletionException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            if (cause instanceof RuntimeException runtimeException) {
                throw runtimeException;
            }
            throw new IllegalStateException(cause);
        }
    }
}
