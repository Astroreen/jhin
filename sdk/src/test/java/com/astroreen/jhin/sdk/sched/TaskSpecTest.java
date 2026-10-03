package com.astroreen.jhin.sdk.sched;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * Tests for {@link TaskSpec}: the factories build one-shot and periodic
 * specs, the derived {@code periodic()} flag follows the interval, and every
 * illegal argument is rejected at construction — the SDK validates the spec
 * shape only and never runs anything.
 */
class TaskSpecTest {

    @Test
    void oneShotFactoryBuildsSpecWithoutInterval() {
        Runnable work = () -> {};
        TaskSpec spec = TaskSpec.oneShot("cleanup", 500, work);
        assertEquals("cleanup", spec.name());
        assertEquals(500, spec.initialDelay());
        assertNullInterval(spec);
        assertEquals(work, spec.runnable());
        assertFalse(spec.periodic());
    }

    @Test
    void periodicFactoryBuildsSpecWithInterval() {
        TaskSpec spec = TaskSpec.periodic("sweep", 1_000, 30_000, () -> {});
        assertEquals("sweep", spec.name());
        assertEquals(1_000, spec.initialDelay());
        assertEquals(30_000L, spec.interval());
        assertTrue(spec.periodic());
    }

    @Test
    void zeroInitialDelayIsAccepted() {
        assertEquals(0, TaskSpec.oneShot("now", 0, () -> {}).initialDelay());
    }

    @Test
    void rejectsBlankName() {
        assertThrows(IllegalArgumentException.class,
                () -> new TaskSpec(null, 0, null, () -> {}));
        assertThrows(IllegalArgumentException.class,
                () -> new TaskSpec("  ", 0, null, () -> {}));
    }

    @Test
    void rejectsNegativeInitialDelay() {
        assertThrows(IllegalArgumentException.class,
                () -> TaskSpec.oneShot("late", -1, () -> {}));
    }

    @Test
    void rejectsNonPositiveInterval() {
        assertThrows(IllegalArgumentException.class,
                () -> new TaskSpec("fast", 0, 0L, () -> {}));
        assertThrows(IllegalArgumentException.class,
                () -> new TaskSpec("backwards", 0, -5L, () -> {}));
    }

    @Test
    void rejectsNullRunnable() {
        assertThrows(IllegalArgumentException.class,
                () -> new TaskSpec("empty", 0, null, null));
    }

    private static void assertNullInterval(TaskSpec spec) {
        assertEquals(null, spec.interval());
    }
}
