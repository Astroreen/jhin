package com.astroreen.jhin.kernel.db;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import java.nio.file.Path;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.function.Function;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class WriteQueueTest {

    private static Function<String, String> env(Path home) {
        return k -> "JHIN_HOME".equals(k) ? home.toString() : null;
    }

    @Test
    void serializesTwoHundredConcurrentWrites(@TempDir Path tmp) throws Exception {
        try (Database database = Database.open(env(tmp))) {
            database.write(connection -> {
                try (Statement statement = connection.createStatement()) {
                    statement.execute("CREATE TABLE tally (n INTEGER)");
                }
                return null;
            });
            int total = 200;
            ExecutorService callers = Executors.newFixedThreadPool(8);
            List<Future<?>> pending = new ArrayList<>();
            for (int i = 0; i < total; i++) {
                pending.add(callers.submit(() -> database.write(connection -> {
                    try (Statement statement = connection.createStatement()) {
                        statement.execute("INSERT INTO tally (n) VALUES (1)");
                    }
                    return null;
                })));
            }
            List<Throwable> problems = new ArrayList<>();
            for (Future<?> pendingTask : pending) {
                try {
                    pendingTask.get();
                } catch (ExecutionException e) {
                    problems.add(e.getCause());
                }
            }
            callers.shutdown();
            assertThat(problems)
                    .describedAs("no write may fail or observe database locking")
                    .isEmpty();
            int count = database.read(connection -> {
                try (Statement statement = connection.createStatement();
                        ResultSet rs = statement.executeQuery("SELECT count(*) FROM tally")) {
                    return rs.next() ? rs.getInt(1) : -1;
                }
            });
            assertThat(count).isEqualTo(total);
        }
    }

    @Test
    void unwrapsSqlFailureFromQueuedTask() {
        WriteQueue queue = new WriteQueue();
        try {
            Throwable thrown = catchThrowable(() -> queue.write((Callable<String>) () -> {
                throw new SQLException("boom");
            }));
            assertThat(thrown).isInstanceOf(SQLException.class);
            assertThat(String.valueOf(thrown)).contains("boom");
        } finally {
            queue.close();
        }
    }

    @Test
    void unwrapsUncheckedFailureFromQueuedTask() {
        WriteQueue queue = new WriteQueue();
        try {
            Throwable thrown = catchThrowable(() -> queue.write((Callable<String>) () -> {
                throw new IllegalStateException("bang");
            }));
            assertThat(thrown).isInstanceOf(IllegalStateException.class);
            assertThat(String.valueOf(thrown)).contains("bang");
        } finally {
            queue.close();
        }
    }
}
