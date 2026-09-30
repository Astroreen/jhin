package com.astroreen.jhin.kernel.config;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

class ConfigViewTest {

    private static Function<String, String> env(Map<String, String> values) {
        return values::get;
    }

    @Test
    void envBeatsFile() {
        var view = new ConfigViewImpl(
                "demo", Map.of("timeout", "from-file"), env(Map.of("JHIN_DEMO_TIMEOUT", "from-env")));
        assertThat(view.get("timeout")).contains("from-env");
        assertThat(view.get("timeout", "fallback")).isEqualTo("from-env");
    }

    @Test
    void fileBeatsDefault() {
        var view = new ConfigViewImpl("demo", Map.of("timeout", "from-file"), env(Map.of()));
        assertThat(view.get("timeout", "fallback")).isEqualTo("from-file");
    }

    @Test
    void defaultBeatsMissingSources() {
        var view = new ConfigViewImpl("demo", Map.of(), env(Map.of()));
        assertThat(view.get("timeout")).isEmpty();
        assertThat(view.get("timeout", "fallback")).isEqualTo("fallback");
    }

    @Test
    void mapsEnvNameForNamespacedSection() {
        assertThat(ConfigViewImpl.envName("jhin.sessions", "foo.bar"))
                .isEqualTo("JHIN_SESSIONS_FOO_BAR");
        var view = new ConfigViewImpl(
                "jhin.sessions", Map.of(), env(Map.of("JHIN_SESSIONS_FOO_BAR", "hit")));
        assertThat(view.get("foo.bar")).contains("hit");
    }

    @Test
    void typedGettersParseOrFallBack() {
        var view = new ConfigViewImpl(
                "demo",
                Map.of("size", "42", "big", "1234567890123", "flag", "true", "off", "false", "bad", "xx"),
                env(Map.of()));
        assertThat(view.getInt("size", 0)).isEqualTo(42);
        assertThat(view.getLong("big", 0L)).isEqualTo(1234567890123L);
        assertThat(view.getBool("flag", false)).isTrue();
        assertThat(view.getBool("off", true)).isFalse();
        assertThat(view.getBool("bad", true)).isTrue();
        assertThat(view.getInt("bad", 7)).isEqualTo(7);
        assertThat(view.getInt("absent", 7)).isEqualTo(7);
    }

    @Test
    void allResolvesEveryKey() {
        var view = new ConfigViewImpl(
                "demo", Map.of("a", "1", "b", "2"), env(Map.of("JHIN_DEMO_A", "9")));
        assertThat(view.all()).containsExactlyInAnyOrderEntriesOf(Map.of("a", "9", "b", "2"));
    }
}
