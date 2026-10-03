package com.astroreen.jhin.sdk.sched;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Contract test for {@link SchedulerRegistry}. The SDK declares the seam
 * only — the executor lives in the kernel (T52) — so this test pins the
 * interface shape with a minimal in-test implementation: schedule returns the
 * accepted spec as the handle, cancel reports whether something was actually
 * cancelled and is a no-op for unknown names, names reflects the schedule.
 */
class SchedulerRegistryContractTest {

    /** Minimal in-test implementation standing in for the kernel executor. */
    private static final class FakeRegistry implements SchedulerRegistry {
        private final Set<String> scheduled = new HashSet<>();

        @Override
        public TaskSpec schedule(TaskSpec spec) {
            scheduled.add(spec.name());
            return spec;
        }

        @Override
        public boolean cancel(String name) {
            return scheduled.remove(name);
        }

        @Override
        public Set<String> names() {
            return Set.copyOf(scheduled);
        }
    }

    @Test
    void scheduleReturnsTheSpecAsHandle() {
        SchedulerRegistry registry = new FakeRegistry();
        TaskSpec spec = TaskSpec.periodic("sweep", 100, 1_000, () -> {});
        assertSame(spec, registry.schedule(spec));
        assertEquals(Set.of("sweep"), registry.names());
    }

    @Test
    void cancelKnownNameReturnsTrueAndRemovesIt() {
        SchedulerRegistry registry = new FakeRegistry();
        registry.schedule(TaskSpec.oneShot("cleanup", 50, () -> {}));
        assertTrue(registry.cancel("cleanup"));
        assertFalse(registry.cancel("cleanup"), "cancelling twice is a no-op");
        assertEquals(Set.of(), registry.names());
    }

    @Test
    void cancelUnknownNameIsFalseAndNeverThrows() {
        SchedulerRegistry registry = new FakeRegistry();
        assertFalse(registry.cancel("missing"));
        assertFalse(registry.cancel(null), "a null name is a no-op, not an error");
    }
}
