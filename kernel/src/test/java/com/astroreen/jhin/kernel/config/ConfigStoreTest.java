package com.astroreen.jhin.kernel.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ConfigStoreTest {

    @TempDir Path tmp;

    @Test
    void missingFileYieldsEmptyConfiguration() {
        ConfigStore store = ConfigStore.load(tmp);
        assertThat(store.sections()).isEmpty();
        assertThat(store.section("demo")).isEmpty();
    }

    @Test
    void flattensNestedKeysAndStringifiesScalars(@TempDir Path ignored) throws IOException {
        Files.writeString(
                tmp.resolve("config.json"),
                """
                {
                  "demo": {
                    "foo": {"bar": "x", "n": 5, "flag": true},
                    "z": "keep"
                  }
                }
                """);
        ConfigStore store = ConfigStore.load(tmp);
        assertThat(store.section("demo"))
                .containsExactlyInAnyOrderEntriesOf(
                        Map.of("foo.bar", "x", "foo.n", "5", "foo.flag", "true", "z", "keep"));
    }

    @Test
    void trailingCommaThrowsNamingLineAndColumn() throws IOException {
        Files.writeString(
                tmp.resolve("config.json"),
                """
                {
                  "demo": {
                    "a": "b",
                  }
                }
                """);
        Throwable failure = catchThrowable(() -> ConfigStore.load(tmp));
        assertThat(failure)
                .isInstanceOf(ConfigException.class)
                .hasMessageContaining("config.json")
                .hasMessageMatching(".*line \\d+, column \\d+.*");
    }
}
