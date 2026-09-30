/**
 * Kernel implementation of the per-section configuration contract.
 *
 * <p>Resolution order per key: environment variable, then the
 * {@code config.json} section, then the default supplied by the caller. The
 * environment name is {@code JHIN_} plus the section id and the key, both
 * upper-cased with dots turned into underscores and with the {@code jhin.}
 * namespace prefix of the section id dropped because it is carried by the
 * fixed {@code JHIN_} prefix itself: section {@code jhin.core} key
 * {@code foo.bar} is read from {@code JHIN_CORE_FOO_BAR}. The environment
 * lookup is injected so tests can supply their own values.
 */
package com.astroreen.jhin.kernel.config;

import com.astroreen.jhin.sdk.ConfigView;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;

public final class ConfigViewImpl implements ConfigView {

    /** Prefix of the fixed namespace carried by every environment name. */
    private static final String NAMESPACE = "jhin.";

    /** Fixed prefix of every environment name. */
    private static final String ENV_PREFIX = "JHIN_";

    private final String id;
    private final Map<String, String> values;
    private final Function<String, String> env;

    /**
     * Creates a view backed by the real environment.
     *
     * @param id     the section id owning the configuration
     * @param values the flattened {@code config.json} entries of the section
     */
    public ConfigViewImpl(String id, Map<String, String> values) {
        this(id, values, System::getenv);
    }

    /**
     * Creates a view backed by the given environment lookup.
     *
     * @param id     the section id owning the configuration
     * @param values the flattened {@code config.json} entries of the section
     * @param env   lookup returning the value of an environment variable, or
     *              {@code null} when it is not set
     */
    public ConfigViewImpl(String id, Map<String, String> values, Function<String, String> env) {
        this.id = id;
        this.values = Map.copyOf(values);
        this.env = env;
    }

    /**
     * Builds the environment variable name carrying the given key for the
     * given section.
     *
     * @param id  the section id
     * @param key the dotted key
     * @return the environment variable name
     */
    static String envName(String id, String key) {
        String local = id.startsWith(NAMESPACE) ? id.substring(NAMESPACE.length()) : id;
        return ENV_PREFIX + under(local) + "_" + under(key);
    }

    private static String under(String dotted) {
        return dotted.toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]+", "_");
    }

    @Override
    public Optional<String> get(String key) {
        String fromEnv = env.apply(envName(id, key));
        if (fromEnv != null) {
            return Optional.of(fromEnv);
        }
        return Optional.ofNullable(values.get(key));
    }

    @Override
    public String get(String key, String def) {
        return get(key).orElse(def);
    }

    @Override
    public int getInt(String key, int def) {
        try {
            return get(key).map(Integer::parseInt).orElse(def);
        } catch (NumberFormatException e) {
            return def;
        }
    }

    @Override
    public long getLong(String key, long def) {
        try {
            return get(key).map(Long::parseLong).orElse(def);
        } catch (NumberFormatException e) {
            return def;
        }
    }

    @Override
    public boolean getBool(String key, boolean def) {
        return get(key).map(value -> {
            if (value.equalsIgnoreCase("true")) {
                return Boolean.TRUE;
            }
            if (value.equalsIgnoreCase("false")) {
                return Boolean.FALSE;
            }
            return def;
        }).orElse(def);
    }

    @Override
    public Map<String, String> all() {
        Map<String, String> out = new LinkedHashMap<>();
        for (String key : values.keySet()) {
            out.put(key, get(key).orElse(""));
        }
        return Map.copyOf(out);
    }
}
