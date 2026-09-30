package com.astroreen.jhin.kernel.loader;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.sdk.ApiVersion;
import com.astroreen.jhin.sdk.PluginManifest;
import java.util.List;
import org.junit.jupiter.api.Test;

class DependencyGraphTest {

    @Test
    void ordersDiamondWithOptionalEdgeDeterministically() {
        DependencyGraph.Node core = node("core", "1.0.0");
        DependencyGraph.Node left = node("left", "1.0.0", req("core", "*", false));
        DependencyGraph.Node right = node("right", "1.0.0", req("core", "*", false));
        DependencyGraph.Node apex = node("apex", "1.0.0", req("left", ">=1.0.0", false), req("right", ">=1.0.0", false));
        DependencyGraph.Node extra = node("extra", "1.0.0");
        DependencyGraph.Node side = node("side", "1.0.0", req("extra", "*", true));

        DependencyGraph.Result result = DependencyGraph.resolve(
                List.of(side, apex, right, core, extra, left));

        assertThat(result.failed()).isEmpty();
        assertThat(result.ordered())
                .extracting(DependencyGraph.Node::id)
                .containsExactly("core", "extra", "left", "right", "apex", "side");
    }

    @Test
    void failsOnMissingRequirement() {
        DependencyGraph.Result result = DependencyGraph.resolve(List.of(
                node("bbb", "1.0.0", req("ccc", ">=1.0.0", false)),
                node("aaa", "1.0.0")));

        assertThat(result.ordered())
                .extracting(DependencyGraph.Node::id)
                .containsExactly("aaa");
        assertThat(result.failed()).hasSize(1);
        assertThat(result.failed().get(0).id()).isEqualTo("bbb");
        assertThat(result.failed().get(0).reason())
                .isEqualTo("plugin bbb requires ccc >=1.0.0, found none");
    }

    @Test
    void failsOnUnsatisfiableVersionRange() {
        DependencyGraph.Result result = DependencyGraph.resolve(List.of(
                node("aaa", "1.0.0", req("bbb", "2.0.0", false)),
                node("bbb", "1.0.0")));

        assertThat(result.ordered())
                .extracting(DependencyGraph.Node::id)
                .containsExactly("bbb");
        assertThat(result.failed()).hasSize(1);
        assertThat(result.failed().get(0).id()).isEqualTo("aaa");
        assertThat(result.failed().get(0).reason())
                .isEqualTo("plugin aaa requires bbb 2.0.0, found 1.0.0");
    }

    @Test
    void failsEveryPluginInCycleNamingTheCyclePath() {
        String expected = "dependency cycle: cyc.a -> cyc.b -> cyc.c -> cyc.a";
        DependencyGraph.Result result = DependencyGraph.resolve(List.of(
                node("cyc.b", "1.0.0", req("cyc.c", "*", false)),
                node("cyc.c", "1.0.0", req("cyc.a", "*", false)),
                node("cyc.a", "1.0.0", req("cyc.b", "*", false))));

        assertThat(result.ordered()).isEmpty();
        assertThat(result.failed())
                .extracting(DependencyGraph.Failure::id)
                .containsExactly("cyc.a", "cyc.b", "cyc.c");
        assertThat(result.failed())
                .extracting(DependencyGraph.Failure::reason)
                .containsExactly(expected, expected, expected);
    }

    @Test
    void cascadesFailureThroughNonOptionalRequirementOnly() {
        DependencyGraph.Result result = DependencyGraph.resolve(List.of(
                node("ccc", "1.0.0", req("bbb", "*", false)),
                node("ddd", "1.0.0", req("ccc", "*", true)),
                node("bbb", "1.0.0", req("zzz", "*", false)),
                node("aaa", "1.0.0")));

        assertThat(result.ordered())
                .extracting(DependencyGraph.Node::id)
                .containsExactly("aaa", "ddd");
        assertThat(result.failed()).hasSize(2);
        assertThat(result.failed().get(0).id()).isEqualTo("bbb");
        assertThat(result.failed().get(0).reason())
                .isEqualTo("plugin bbb requires zzz *, found none");
        assertThat(result.failed().get(1).id()).isEqualTo("ccc");
        assertThat(result.failed().get(1).reason()).isEqualTo("dependency bbb failed");
    }

    private static DependencyGraph.Node node(String id, String version, PluginManifest.Requirement... requires) {
        return new DependencyGraph.Node(new PluginManifest(
                id, version, ApiVersion.CURRENT, id, "test fixture", "com.example." + id,
                List.of(), List.of(requires)));
    }

    private static PluginManifest.Requirement req(String id, String versionRange, boolean optional) {
        return new PluginManifest.Requirement(id, versionRange, optional);
    }
}