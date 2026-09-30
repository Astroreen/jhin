package com.astroreen.jhin.kernel.loader;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

class ManifestParserTest {

    private final ManifestParser parser = new ManifestParser();

    @Test
    void acceptsValidManifest() {
        ManifestParser.Result result = parser.parse("""
                {"id":"demo.one","version":"1.2.3","apiVersion":1,"name":"Demo","description":"d",
                 "mainClass":"com.example.Demo","exports":["com.example.api"],
                 "requires":[{"id":"demo.base","versionRange":">=1.0.0","optional":false}]}""");

        assertThat(result.accepted()).isTrue();
        assertThat(result.failureReason()).isNull();
        assertThat(result.manifest().id()).isEqualTo("demo.one");
        assertThat(result.manifest().version()).isEqualTo("1.2.3");
        assertThat(result.manifest().apiVersion()).isEqualTo(1);
        assertThat(result.manifest().mainClass()).isEqualTo("com.example.Demo");
        assertThat(result.manifest().exports()).containsExactly("com.example.api");
        assertThat(result.manifest().requires()).hasSize(1);
        assertThat(result.manifest().requires().get(0).id()).isEqualTo("demo.base");
    }

    @Test
    void rejectsWrongApiVersionWithExactReason() {
        ManifestParser.Result result = parser.parse("""
                {"id":"demo.one","version":"1.2.3","apiVersion":2,
                 "mainClass":"com.example.Demo"}""");

        assertThat(result.accepted()).isFalse();
        assertThat(result.failureReason())
                .isEqualTo("plugin demo.one targets api 2, kernel provides 1");
    }

    @Test
    void rejectsInvalidFieldNamingIt() {
        ManifestParser.Result result = parser.parse("""
                {"id":"demo.one","version":"1.2.3","apiVersion":1,"mainClass":""}""");

        assertThat(result.accepted()).isFalse();
        assertThat(result.failureReason()).isEqualTo("mainClass must not be blank");
    }

    @Test
    void rejectsUnreadableJson() {
        ManifestParser.Result result = parser.parse("{");

        assertThat(result.accepted()).isFalse();
        assertThat(result.failureReason()).contains("jhin-plugin.json");
    }

    @Test
    void parseAllKeepsHigherSemverNumerically() {
        ManifestParser.Candidate kept = only(parseAll(
                scanned("a.jar", manifest("demo.one", "1.2.0")),
                scanned("b.jar", manifest("demo.one", "1.10.0"))));

        assertThat(kept.jar()).isEqualTo(Path.of("b.jar"));
        assertThat(kept.manifest().version()).isEqualTo("1.10.0");
    }

    @Test
    void parseAllDropsRejectedJars() {
        List<ManifestParser.Candidate> accepted = parseAll(
                scanned("bad.jar", "{\"id\":\"demo.bad\"}"),
                scanned("good.jar", manifest("demo.one", "1.0.0")));

        assertThat(accepted).hasSize(1);
        assertThat(accepted.get(0).jar()).isEqualTo(Path.of("good.jar"));
    }

    private List<ManifestParser.Candidate> parseAll(PluginScanner.ScannedJar... scanned) {
        return parser.parseAll(List.of(scanned));
    }

    private static ManifestParser.Candidate only(List<ManifestParser.Candidate> candidates) {
        assertThat(candidates).hasSize(1);
        return candidates.get(0);
    }

    private static PluginScanner.ScannedJar scanned(String jar, String manifestJson) {
        return new PluginScanner.ScannedJar(Path.of(jar), manifestJson);
    }

    private static String manifest(String id, String version) {
        return "{\"id\":\"" + id + "\",\"version\":\"" + version + "\",\"apiVersion\":1,"
                + "\"mainClass\":\"com.example.Demo\"}";
    }
}