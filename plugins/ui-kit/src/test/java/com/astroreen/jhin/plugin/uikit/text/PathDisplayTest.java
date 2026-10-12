/**
 * {@link com.astroreen.jhin.plugin.uikit.text.PathDisplay} (T302):
 * middle truncation keeps the basename and the ≤ {@code max} budget, the
 * basename/looksLikePath helpers classify summary lines, and the path chip
 * carries the truncated label with the full path in the tooltip.
 */
package com.astroreen.jhin.plugin.uikit.text;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.uikit.UiNode;
import org.junit.jupiter.api.Test;

class PathDisplayTest {

    @Test
    void shortPathsStayUnchanged() {
        assertThat(PathDisplay.middleTruncate("src/auth.java", 48))
                .isEqualTo("src/auth.java");
        assertThat(PathDisplay.middleTruncate("/tmp/a", 48)).isEqualTo("/tmp/a");
        assertThat(PathDisplay.middleTruncate("a/b/c", 5)).isEqualTo("a/b/c");
    }

    @Test
    void longPathsMiddleTruncateKeepingTheBasename() {
        String path = "/home/astroreen/Documents/jhin/plugins/ui-default/src/main/java/"
                + "com/astroreen/jhin/plugin/ui/screens/MessageCardBuilder.java";
        String display = PathDisplay.middleTruncate(path, PathDisplay.DEFAULT_MAX);
        assertThat(display.length()).isLessThanOrEqualTo(48);
        assertThat(display).endsWith("MessageCardBuilder.java");
        assertThat(display).contains("\u2026");
        assertThat(display).startsWith("/home/");
    }

    @Test
    void fileJavaSurvivesTheFortyEightBudget() {
        String path = "/very/long/first/half/that/keeps/going/and/going/"
                + "structure/file.java";
        String display = PathDisplay.middleTruncate(path, 48);
        assertThat(display.length()).isLessThanOrEqualTo(48);
        assertThat(display).endsWith("file.java");
    }

    @Test
    void anOverlongBasenameFallsBackToTheTail() {
        String path = "/x/" + "verylongname".repeat(6) + ".java";
        String display = PathDisplay.middleTruncate(path, 20);
        assertThat(display.length()).isLessThanOrEqualTo(20);
        assertThat(display).startsWith("\u2026");
        assertThat(display).endsWith(".java");
    }

    @Test
    void noHeadFitsFallsBackToTheDotSlashForm() {
        String path = "/names-that-are-quite-long-here/end.java";
        String display = PathDisplay.middleTruncate(path, 12);
        assertThat(display.length()).isLessThanOrEqualTo(12);
        assertThat(display).isEqualTo("\u2026/end.java");
    }

    @Test
    void trailingSlashesDoNotChangeTheBasename() {
        assertThat(PathDisplay.middleTruncate("/tmp/very/long/path/segment/that/exceeds/demo/", 20))
                .endsWith("demo");
        assertThat(PathDisplay.basename("/tmp/demo/")).isEqualTo("demo");
        assertThat(PathDisplay.basename("/tmp/demo")).isEqualTo("demo");
        assertThat(PathDisplay.basename("/")).isEqualTo("/");
        assertThat(PathDisplay.basename(null)).isEmpty();
    }

    @Test
    void looksLikePathSeparatesPathsFromProseAndJson() {
        assertThat(PathDisplay.looksLikePath("/tmp/a")).isTrue();
        assertThat(PathDisplay.looksLikePath("src/auth.java")).isTrue();
        assertThat(PathDisplay.looksLikePath("~/x/y.txt")).isTrue();
        assertThat(PathDisplay.looksLikePath("./rel/file")).isTrue();
        assertThat(PathDisplay.looksLikePath("git")).isFalse();
        assertThat(PathDisplay.looksLikePath("hello world/x")).isFalse();
        assertThat(PathDisplay.looksLikePath("{\"path\":\"src/auth.java\"}")).isFalse();
        assertThat(PathDisplay.looksLikePath("write {\"path\":\"/tmp/a\"}")).isFalse();
        assertThat(PathDisplay.looksLikePath("")).isFalse();
        assertThat(PathDisplay.looksLikePath(null)).isFalse();
    }

    @Test
    void chipCarriesTheTruncatedLabelAndFullTooltip() {
        UiNode node = PathDisplay.chip("/tmp/demo");
        assertThat(node.type()).isEqualTo("chip");
        assertThat(node.props()).containsEntry("kind", "file")
                .containsEntry("label", "/tmp/demo")
                .containsEntry("tooltip", "/tmp/demo");
    }

    @Test
    void chipLabelRespectsTheFortyEightCharacterBudget() {
        String path = "/home/astroreen/Documents/jhin/plugins/ui-default/src/main/java/"
                + "com/astroreen/jhin/plugin/ui/screens/MessageCardBuilder.java";
        UiNode node = PathDisplay.chip(path);
        String label = String.valueOf(node.props().get("label"));
        assertThat(label.length()).isLessThanOrEqualTo(48);
        assertThat(label).endsWith("MessageCardBuilder.java");
        assertThat(node.props()).containsEntry("tooltip", path);
    }
}
