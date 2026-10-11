/**
 * The {@code Ui.raw} sweep (docs/web-client.md section 3): no product screen
 * may use the unescaped escape hatch. Walks every Java source under
 * {@code plugins/ui-default/src/main/java} with pure {@code java.nio} (repo
 * rule 1: no external binaries) and fails on a single {@code Ui.raw(}
 * call-site. The sweep result is recorded as QA evidence when
 * {@code JHIN_EVIDENCE_DIR} is set (scripts/qa/t201.sh).
 */
package com.astroreen.jhin.plugin.uikit.html;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

class RawEscapeSweepTest {

    /** The forbidden call-site pattern: the hatch, in product screens. */
    private static final String FORBIDDEN = "Ui.raw(";

    /** The sweep root relative to the repository root. */
    private static final String SWEEP_ROOT = "plugins/ui-default/src/main/java";

    @Test
    void productScreensNeverUseTheRawEscapeHatch() throws IOException {
        Path root = repositoryRoot().resolve(SWEEP_ROOT);
        assertThat(Files.isDirectory(root))
                .as("sweep root exists: %s", root)
                .isTrue();

        List<String> offenders = new ArrayList<>();
        List<String> scanned = new ArrayList<>();
        try (Stream<Path> files = Files.walk(root)) {
            files.filter(path -> path.toString().endsWith(".java"))
                    .sorted()
                    .forEach(path -> {
                        scanned.add(root.relativize(path).toString());
                        try {
                            String source = Files.readString(path, StandardCharsets.UTF_8);
                            if (source.contains(FORBIDDEN)) {
                                offenders.add(root.relativize(path).toString());
                            }
                        } catch (IOException failure) {
                            throw new IllegalStateException("cannot read " + path, failure);
                        }
                    });
        }

        String report = "# T201 raw-escape sweep (scripts/qa/t201.sh)\n"
                + "# Rule: no product screen under " + SWEEP_ROOT + " may call " + FORBIDDEN + "\n"
                + "scanned=" + scanned.size() + "\n"
                + "offenders=" + offenders.size() + "\n"
                + (offenders.isEmpty()
                        ? "result=0 uses of " + FORBIDDEN + " under " + SWEEP_ROOT + "\n"
                        : "result=FAIL offenders:\n" + String.join("\n", offenders) + "\n");
        HtmlRendererTest.writeEvidence("raw-sweep.txt", report);

        assertThat(offenders)
                .as("product screens must not call %s", FORBIDDEN)
                .isEmpty();
    }

    /**
     * The repository root: walk up from the test working directory (the
     * ui-kit module dir under Gradle) until the {@code plugins/ui-default}
     * tree is found.
     */
    private static Path repositoryRoot() {
        Path current = Path.of("").toAbsolutePath();
        for (Path candidate = current; candidate != null; candidate = candidate.getParent()) {
            if (Files.isDirectory(candidate.resolve(SWEEP_ROOT))) {
                return candidate;
            }
        }
        throw new IllegalStateException(
                "cannot locate the repository root from " + current);
    }
}