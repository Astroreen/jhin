package com.astroreen.jhin.kernel.sched;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.sdk.sched.TaskSpec;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.Test;

/**
 * The runtime semantics of the shared scheduler seam: one-shot and periodic
 * runs, cancel idempotence, duplicate-name replacement, the swallowing of
 * throwing tasks and the bounded shutdown join. The termination assertion
 * polls with a generous test-only bound (the product bound stays at 5 s) so
 * a loaded machine cannot flake it — see plan UNVERIFIED #6.
 */
class SchedulerRegistryImplTest {

    // one-shot: the flag flips within 2 s and exactly once
    @Test
    void oneShotRunsOnceWithinTwoSeconds() {
        try (SchedulerRegistryImpl registry = new SchedulerRegistryImpl()) {
            AtomicInteger firings = new AtomicInteger();
            registry.schedule(TaskSpec.oneShot("deferred", 100, firings::incrementAndGet));
            await(() -> firings.get() == 1, 2_000);
            assertThat(firings.get()).isEqualTo(1);
            sleep(300);
            assertThat(firings.get()).as("a one-shot fires exactly once").isEqualTo(1);
        }
    }

    // periodic: at least two firings within 3 s
    @Test
    void periodicFiresAtLeastTwiceWithinThreeSeconds() {
        try (SchedulerRegistryImpl registry = new SchedulerRegistryImpl()) {
            AtomicInteger firings = new AtomicInteger();
            registry.schedule(TaskSpec.periodic("sweep", 0, 100, firings::incrementAndGet));
            await(() -> firings.get() >= 2, 3_000);
            assertThat(firings.get()).isGreaterThanOrEqualTo(2);
        }
    }

    // cancel: stops the firings, returns true once, then false forever
    @Test
    void cancelStopsTheFiringsAndIsIdempotent() {
        try (SchedulerRegistryImpl registry = new SchedulerRegistryImpl()) {
            AtomicInteger firings = new AtomicInteger();
            registry.schedule(TaskSpec.periodic("retired", 0, 50, firings::incrementAndGet));
            await(() -> firings.get() >= 2, 3_000);
            assertThat(registry.cancel("retired")).isTrue();
            int before = firings.get();
            sleep(300);
            assertThat(firings.get()).as("no firing after the cancel").isEqualTo(before);
            assertThat(registry.cancel("retired")).isFalse();
            assertThat(registry.cancel("missing")).isFalse();
            assertThat(registry.names()).isEmpty();
        }
    }

    // duplicate name: the previous task is cancelled and replaced
    @Test
    void duplicateNameReplacesThePreviousTask() {
        try (SchedulerRegistryImpl registry = new SchedulerRegistryImpl()) {
            AtomicInteger first = new AtomicInteger();
            AtomicInteger second = new AtomicInteger();
            registry.schedule(TaskSpec.periodic("job", 0, 50, first::incrementAndGet));
            await(() -> first.get() >= 2, 3_000);
            registry.schedule(TaskSpec.oneShot("job", 50, second::incrementAndGet));
            await(() -> second.get() == 1, 2_000);
            int before = first.get();
            sleep(300);
            assertThat(first.get()).as("the replaced task no longer fires").isEqualTo(before);
            assertThat(second.get()).isEqualTo(1);
            assertThat(registry.names()).containsExactly("job");
        }
    }

    // a periodic task that throws keeps its schedule: the exception is
    // swallowed, the next run still happens
    @Test
    void throwingPeriodicTaskKeepsItsSchedule() {
        try (SchedulerRegistryImpl registry = new SchedulerRegistryImpl()) {
            AtomicInteger firings = new AtomicInteger();
            registry.schedule(TaskSpec.periodic("boomer", 0, 100, () -> {
                firings.incrementAndGet();
                throw new IllegalStateException("deliberate");
            }));
            await(() -> firings.get() >= 2, 3_000);
            assertThat(firings.get()).isGreaterThanOrEqualTo(2);
            assertThat(registry.names()).containsExactly("boomer");
        }
    }

    // a one-shot that throws is swallowed and the executor stays alive
    @Test
    void throwingOneShotIsSwallowedAndTheExecutorSurvives() {
        try (SchedulerRegistryImpl registry = new SchedulerRegistryImpl()) {
            AtomicInteger later = new AtomicInteger();
            registry.schedule(TaskSpec.oneShot("boomer", 50, () -> {
                throw new IllegalStateException("deliberate");
            }));
            registry.schedule(TaskSpec.oneShot("later", 200, later::incrementAndGet));
            await(() -> later.get() == 1, 2_000);
            assertThat(later.get()).isEqualTo(1);
        }
    }

    // names reflects the schedule bookkeeping
    @Test
    void namesReflectsTheScheduledTasks() {
        try (SchedulerRegistryImpl registry = new SchedulerRegistryImpl()) {
            registry.schedule(TaskSpec.oneShot("a", 10_000, () -> {}));
            registry.schedule(TaskSpec.oneShot("b", 10_000, () -> {}));
            assertThat(registry.names()).containsExactlyInAnyOrder("a", "b");
            assertThat(registry.cancel("a")).isTrue();
            assertThat(registry.names()).containsExactly("b");
        }
    }

    // after close: scheduling is refused, cancel is a no-op, nothing fires
    @Test
    void workScheduledAfterCloseIsDropped() {
        SchedulerRegistryImpl registry = new SchedulerRegistryImpl();
        registry.close();
        AtomicInteger firings = new AtomicInteger();
        registry.schedule(TaskSpec.oneShot("late", 50, firings::incrementAndGet));
        sleep(300);
        assertThat(firings.get()).isZero();
        assertThat(registry.cancel("late")).isFalse();
        assertThat(registry.names()).isEmpty();
        registry.close(); // idempotent
    }

    // shutdown: no new firings and the executor terminates; the test polls
    // with a generous bound (10 s) while the product bound stays at 5 s
    @Test
    void closeStopsTheFiringsAndTerminatesTheExecutor() {
        SchedulerRegistryImpl registry = new SchedulerRegistryImpl();
        AtomicInteger firings = new AtomicInteger();
        registry.schedule(TaskSpec.periodic("sweep", 0, 50, firings::incrementAndGet));
        await(() -> firings.get() >= 2, 3_000);
        registry.close();
        int before = firings.get();
        sleep(300);
        assertThat(firings.get()).as("no firing after the shutdown").isEqualTo(before);
        await(registry::terminated, 10_000);
        assertThat(registry.terminated()).isTrue();
    }

    /** Polls the condition until it holds or the timeout passes. */
    private static void await(BooleanSupplier condition, long timeoutMillis) {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis);
        while (System.nanoTime() < deadline) {
            if (condition.getAsBoolean()) {
                return;
            }
            sleep(20);
        }
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
