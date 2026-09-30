/**
 * The single-threaded write lane of the shared SQLite file. Every write is
 * submitted here and executed one at a time, in submission order, so callers
 * never collide with each other and never observe database locking errors.
 *
 * <p>{@link #write(Callable)} blocks until the submitted task completes and
 * rethrows failures as they happened inside the task: a {@link java.sql.SQLException}
 * is thrown as itself and any other failure is rethrown unchanged.
 */
package com.astroreen.jhin.kernel.db;

import java.sql.SQLException;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

public final class WriteQueue implements AutoCloseable {

    private final ExecutorService executor;

    /**
     * Creates a queue backed by one daemon thread that owns the write lane.
     */
    public WriteQueue() {
        this.executor = Executors.newSingleThreadExecutor(task -> {
            Thread thread = new Thread(task, "jhin-db-writer");
            thread.setDaemon(true);
            return thread;
        });
    }

    /**
     * Submits a write task and waits for its result.
     *
     * @param <R>  the task result type
     * @param task the write task to execute on the queue thread
     * @return whatever the task returns
     * @throws SQLException when the task fails with a database error, when the
     *                      caller is interrupted while waiting, or when the
     *                      task fails with a checked exception that is not a
     *                      database error
     */
    public <R> R write(Callable<R> task) throws SQLException {
        Future<R> future = executor.submit(task);
        try {
            return future.get();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new SQLException("interrupted while waiting for a queued write", e);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof SQLException sql) {
                throw sql;
            }
            toss(cause);
            throw new SQLException(cause);
        }
    }

    /**
     * Rethrows the given failure without declaring it. Exists so the queue
     * unwraps every failure type unchanged and the compiler keeps the
     * {@link #write(Callable)} contract of declaring only
     * {@link java.sql.SQLException}.
     *
     * @param <E>   the failure type the compiler assumes
     * @param cause the failure to rethrow
     * @throws E always, at the exact type of {@code cause}
     */
    @SuppressWarnings("unchecked")
    private static <E extends Throwable> void toss(Throwable cause) throws E {
        throw (E) cause;
    }

    /**
     * Stops accepting new writes and waits briefly for queued writes to
     * finish. Interrupts are restored and any remaining writes are cancelled.
     */
    @Override
    public void close() {
        executor.shutdown();
        try {
            if (!executor.awaitTermination(5, TimeUnit.SECONDS)) {
                executor.shutdownNow();
            }
        } catch (InterruptedException e) {
            executor.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }
}
