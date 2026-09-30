package com.astroreen.jhin.sdk.db;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * Tests for {@link MigrationSpec}: the constructor rejects {@code version < 1}
 * and blank SQL with {@link IllegalArgumentException}; a legal pair is stored
 * unchanged.
 */
class MigrationSpecTest {

    // --- happy path ---

    /**
     * A legal migration stores its components unchanged.
     */
    @Test
    void storesVersionAndSql() {
        MigrationSpec spec = new MigrationSpec(1, "CREATE TABLE jhin_sessions_ (id)");
        assertEquals(1, spec.version());
        assertEquals("CREATE TABLE jhin_sessions_ (id)", spec.sql());
    }

    // --- failure path: version < 1 ---

    /**
     * Version {@code 0} is rejected; the message names the bound.
     */
    @Test
    void rejectsZeroVersion() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> new MigrationSpec(0, "CREATE TABLE t (id)"));
        assertTrue(e.getMessage().contains(">= 1"), e.getMessage());
    }

    /**
     * A negative version is rejected; the message names the bound.
     */
    @Test
    void rejectsNegativeVersion() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> new MigrationSpec(-1, "CREATE TABLE t (id)"));
        assertTrue(e.getMessage().contains(">= 1"), e.getMessage());
    }

    // --- failure path: blank sql ---

    /**
     * A {@code null} script is rejected as blank.
     */
    @Test
    void rejectsNullSql() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> new MigrationSpec(1, null));
        assertTrue(e.getMessage().contains("sql"), e.getMessage());
    }

    /**
     * An empty script is rejected as blank.
     */
    @Test
    void rejectsEmptySql() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> new MigrationSpec(1, ""));
        assertTrue(e.getMessage().contains("blank"), e.getMessage());
    }

    /**
     * A whitespace-only script is rejected as blank.
     */
    @Test
    void rejectsWhitespaceSql() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> new MigrationSpec(1, "  \t\n"));
        assertTrue(e.getMessage().contains("blank"), e.getMessage());
    }
}
