/**
 * Payload budget for the web client (T207.3, T300): every shipped runtime
 * chunk and stylesheet stays under its uncompressed size ceiling, and the
 * nine payloads together stay under the total ceilings, so the shell document
 * and the asset responses keep their load profile. The assertions read the
 * real class-path resources of this plugin — the same bytes the routes serve
 * — not a copy.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.InputStream;
import org.junit.jupiter.api.Test;

class WebAssetBudgetTest {

    /** Uncompressed byte ceiling of one {@code .js} runtime chunk (60 kB decimal). */
    private static final int JS_CHUNK_BUDGET = 60_000;

    /** Uncompressed byte ceiling of one {@code .css} stylesheet (40 kB decimal). */
    private static final int CSS_FILE_BUDGET = 40_000;

    /** Uncompressed byte ceiling of all six runtime chunks together (300 kB decimal). */
    private static final int JS_TOTAL_BUDGET = 300_000;

    /** Uncompressed byte ceiling of all three stylesheets together (120 kB decimal). */
    private static final int CSS_TOTAL_BUDGET = 120_000;

    @Test
    void everyJsChunkStaysWithinItsBudget() throws IOException {
        for (String name : WebAssets.JS) {
            assertThat(resource("/web/js/" + name).length)
                    .as("chunk %s", name)
                    .isLessThanOrEqualTo(JS_CHUNK_BUDGET);
        }
    }

    @Test
    void everyStylesheetStaysWithinItsBudget() throws IOException {
        for (String name : WebAssets.CSS) {
            assertThat(resource("/web/css/" + name).length)
                    .as("stylesheet %s", name)
                    .isLessThanOrEqualTo(CSS_FILE_BUDGET);
        }
    }

    @Test
    void theJsChunksTogetherStayWithinTheTotalBudget() throws IOException {
        int total = 0;
        for (String name : WebAssets.JS) {
            total += resource("/web/js/" + name).length;
        }
        assertThat(total).isLessThanOrEqualTo(JS_TOTAL_BUDGET);
    }

    @Test
    void theStylesheetsTogetherStayWithinTheTotalBudget() throws IOException {
        int total = 0;
        for (String name : WebAssets.CSS) {
            total += resource("/web/css/" + name).length;
        }
        assertThat(total).isLessThanOrEqualTo(CSS_TOTAL_BUDGET);
    }

    private static byte[] resource(String name) throws IOException {
        try (InputStream in = WebAssetBudgetTest.class.getResourceAsStream(name)) {
            assertThat(in).as("classpath resource %s", name).isNotNull();
            return in.readAllBytes();
        }
    }
}
