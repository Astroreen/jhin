package com.astroreen.jhin.kernel.db;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import com.astroreen.jhin.sdk.PluginException;
import org.junit.jupiter.api.Test;

class MigrationGuardTest {

    private static final String PLUGIN_ID = "jhin" + "." + "ses" + "sions";
    private static final String PREFIX = "jhin" + "_ses" + "sions_";
    private static final String UNPREFIXED_TABLE = "ses" + "sions";

    @Test
    void refusesUnprefixedCreateTable() {
        Throwable thrown = catchThrowable(() -> MigrationGuard.check(
                PLUGIN_ID, "CREATE TABLE " + UNPREFIXED_TABLE + " (id INTEGER)"));
        assertThat(thrown).isInstanceOf(PluginException.class);
        String text = String.valueOf(thrown);
        assertThat(text).contains(PREFIX).contains(UNPREFIXED_TABLE);
    }

    @Test
    void refusesUnprefixedCreateIndex() {
        Throwable thrown = catchThrowable(() -> MigrationGuard.check(
                PLUGIN_ID, "CREATE UNIQUE INDEX " + UNPREFIXED_TABLE + "_ix ON " + PREFIX + "a (id)"));
        assertThat(thrown).isInstanceOf(PluginException.class);
        assertThat(String.valueOf(thrown)).contains(PREFIX);
    }

    @Test
    void acceptsPrefixedTargets() {
        MigrationGuard.check(PLUGIN_ID,
                "CREATE TABLE IF NOT EXISTS " + PREFIX + "item (id INTEGER PRIMARY KEY, v TEXT);\n"
                        + "CREATE INDEX " + PREFIX + "item_ix ON " + PREFIX + "item (v);\n"
                        + "CREATE UNIQUE INDEX \"" + PREFIX + "item_ux\" ON " + PREFIX + "item (id);");
        MigrationGuard.check("demo.one",
                "CREATE TABLE IF NOT EXISTS demo_one_alpha (id INTEGER PRIMARY KEY)");
    }

    @Test
    void computesPrefixFromPluginId() {
        assertThat(MigrationGuard.prefixFor(PLUGIN_ID)).isEqualTo(PREFIX);
        assertThat(MigrationGuard.prefixFor("demo.one")).isEqualTo("demo_one_");
    }
}
