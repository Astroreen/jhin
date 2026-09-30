/**
 * Static validation of plugin schema migrations. Every table and index a
 * migration creates must carry the prefix of the owning plugin: the plugin id
 * with every character outside {@code [a-z0-9]} replaced by {@code _} plus a
 * trailing {@code _}. A migration that creates an unprefixed target is refused
 * before anything is applied.
 */
package com.astroreen.jhin.kernel.db;

import com.astroreen.jhin.sdk.PluginException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class MigrationGuard {

    /**
     * Names of the targets of {@code CREATE TABLE}, {@code CREATE INDEX} and
     * {@code CREATE UNIQUE INDEX} statements, with the optional
     * {@code IF NOT EXISTS} clause and optional quoting of the name.
     */
    private static final Pattern CREATE_TARGET = Pattern.compile(
            "\\bCREATE\\s+(?:UNIQUE\\s+)?(?:TABLE|INDEX)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"
                    + "(\"[^\"]*\"|`[^`]*`|\\[[^]]*]|[\\w.]+)",
            Pattern.CASE_INSENSITIVE);

    private MigrationGuard() {
    }

    /**
     * Computes the mandatory table and index prefix of a plugin from its id.
     *
     * @param pluginId the plugin id
     * @return every character outside {@code [a-z0-9]} replaced by {@code _},
     *         plus a trailing {@code _}
     */
    public static String prefixFor(String pluginId) {
        return pluginId.replaceAll("[^a-z0-9]", "_") + "_";
    }

    /**
     * Checks one migration script of a plugin. Every created table or index
     * must start with the plugin's prefix.
     *
     * @param pluginId the id of the owning plugin
     * @param sql      the migration script to scan
     * @throws PluginException when a created table or index does not start
     *                         with the required prefix
     */
    public static void check(String pluginId, String sql) {
        String prefix = prefixFor(pluginId);
        Matcher matcher = CREATE_TARGET.matcher(sql);
        while (matcher.find()) {
            String name = unquote(matcher.group(1));
            if (!name.startsWith(prefix)) {
                throw new PluginException(
                        "migration target " + name + " must start with prefix " + prefix);
            }
        }
    }

    private static String unquote(String raw) {
        if (raw.length() >= 2) {
            char first = raw.charAt(0);
            char last = raw.charAt(raw.length() - 1);
            if ((first == '"' && last == '"')
                    || (first == '`' && last == '`')
                    || (first == '[' && last == ']')) {
                return raw.substring(1, raw.length() - 1);
            }
        }
        return raw;
    }
}
