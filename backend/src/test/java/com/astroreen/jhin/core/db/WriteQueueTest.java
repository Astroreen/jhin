package com.astroreen.jhin.core.db;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.IntStream;
import java.util.stream.LongStream;
import org.junit.jupiter.api.Test;

class WriteQueueTest {

    @Test
    void hundredParallelSubmissionsProduceGaplessSequence() throws Exception {
        WriteQueue queue = new WriteQueue();
        try {
            AtomicLong counter = new AtomicLong();
            List<Long> recorded = Collections.synchronizedList(new ArrayList<>());
            CompletableFuture<?>[] futures = new CompletableFuture[100];

            IntStream.range(0, 100).parallel().forEach(i -> {
                Callable<Long> task = () -> {
                    long seq = counter.getAndIncrement();
                    recorded.add(seq);
                    return seq;
                };
                futures[i] = queue.submit(task);
            });

            CompletableFuture.allOf(futures).get(5, TimeUnit.SECONDS);

            List<Long> expected = LongStream.range(0, 100).boxed().toList();
            Set<Long> recordedSet = new HashSet<>(recorded);
            assertThat(recorded).hasSize(100);
            assertThat(recordedSet).hasSize(100);
            assertThat(recordedSet).containsExactlyInAnyOrderElementsOf(expected);
            assertThat(recorded).containsExactlyElementsOf(expected);

            Set<Long> results = new HashSet<>();
            for (CompletableFuture<?> future : futures) {
                results.add((Long) future.get());
            }
            assertThat(results).isEqualTo(recordedSet);
        } finally {
            queue.close();
        }
    }

    @Test
    void failurePropagatesAndQueueKeepsProcessing() throws Exception {
        WriteQueue queue = new WriteQueue();
        try {
            IllegalStateException boom = new IllegalStateException("boom");
            Callable<String> bad = () -> {
                throw boom;
            };

            CompletableFuture<String> failed = queue.submit(bad);

            assertThatThrownBy(() -> failed.get(2, TimeUnit.SECONDS))
                    .isInstanceOf(ExecutionException.class)
                    .hasCause(boom);

            Callable<String> good = () -> "ok";
            CompletableFuture<String> ok = queue.submit(good);

            assertThat(ok.get(2, TimeUnit.SECONDS)).isEqualTo("ok");
        } finally {
            queue.close();
        }
    }

    @Test
    void submitCallableReturnsValue() throws Exception {
        WriteQueue queue = new WriteQueue();
        try {
            Callable<String> task = () -> "value";

            CompletableFuture<String> future = queue.submit(task);

            assertThat(future.get(2, TimeUnit.SECONDS)).isEqualTo("value");
        } finally {
            queue.close();
        }
    }

    @Test
    void submitRunnableRunsOnDedicatedDaemonWriterThread() throws Exception {
        WriteQueue queue = new WriteQueue();
        try {
            AtomicReference<Thread> writerThread = new AtomicReference<>();
            Runnable task = () -> writerThread.set(Thread.currentThread());

            CompletableFuture<Void> future = queue.submit(task);

            assertThat(future.get(2, TimeUnit.SECONDS)).isNull();
            assertThat(writerThread.get()).isNotNull();
            assertThat(writerThread.get().getName()).isEqualTo("jhin-write-queue");
            assertThat(writerThread.get().isDaemon()).isTrue();
        } finally {
            queue.close();
        }
    }

    @Test
    void submitAfterShutdownFailsFast() {
        WriteQueue queue = new WriteQueue();
        queue.close();

        Callable<String> task = () -> "value";
        CompletableFuture<String> future = queue.submit(task);

        assertThatThrownBy(() -> future.get(2, TimeUnit.SECONDS))
                .isInstanceOf(ExecutionException.class)
                .hasCauseInstanceOf(RejectedExecutionException.class);
    }
}
