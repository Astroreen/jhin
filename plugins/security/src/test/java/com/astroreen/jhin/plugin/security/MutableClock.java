/**
 * Settable clock for time-dependent tests: the services take a
 * {@link java.time.Clock}, so expiry behaviour is exercised by advancing this
 * clock instead of sleeping.
 */
package com.astroreen.jhin.plugin.security;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;

final class MutableClock extends Clock {

    private Instant instant;

    MutableClock(Instant start) {
        this.instant = start;
    }

    /**
     * Moves the clock forward.
     *
     * @param duration how far to advance
     */
    void advance(Duration duration) {
        instant = instant.plus(duration);
    }

    @Override
    public Instant instant() {
        return instant;
    }

    @Override
    public ZoneId getZone() {
        return ZoneOffset.UTC;
    }

    @Override
    public Clock withZone(ZoneId zone) {
        return this;
    }
}
