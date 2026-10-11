/**
 * Payload budget for the web client (T207.3): the shipped {@code app.js} and
 * {@code app.css} stay under their uncompressed size ceilings so the shell
 * document and the asset responses keep their load profile. The assertions
 * read the real class-path resources of this plugin — the same bytes the
 * routes serve — not a copy.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.InputStream;
import org.junit.jupiter.api.Test;

class WebAssetBudgetTest {

    /** Uncompressed byte ceiling of {@code /web/app.js} (60 kB decimal). */
    private static final int APP_JS_BUDGET = 60_000;

    /** Uncompressed byte ceiling of {@code /web/app.css} (40 kB decimal). */
    private static final int APP_CSS_BUDGET = 40_000;

    @Test
    void appJsStaysWithinItsBudget() throws IOException {
        assertThat(resource("/web/app.js").length)
                .isLessThanOrEqualTo(APP_JS_BUDGET);
    }

    @Test
    void appCssStaysWithinItsBudget() throws IOException {
        assertThat(resource("/web/app.css").length)
                .isLessThanOrEqualTo(APP_CSS_BUDGET);
    }

    private static byte[] resource(String name) throws IOException {
        try (InputStream in = WebAssetBudgetTest.class.getResourceAsStream(name)) {
            assertThat(in).as("classpath resource %s", name).isNotNull();
            return in.readAllBytes();
        }
    }
}
