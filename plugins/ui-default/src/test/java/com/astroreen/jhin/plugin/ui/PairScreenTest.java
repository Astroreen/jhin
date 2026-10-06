/**
 * The T114 {@code pair} screen: the real enrollment form (the
 * {@code EnrollScreen} alias), the hidden {@code enroll-error} banner and the
 * expired-code refusal that patches the banner visible with the documented
 * security message. The {@code --fail} QA path inverts the expired-code
 * expectation through {@code T114_FAIL_MODE}.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.security.api.SecurityException;
import com.astroreen.jhin.plugin.ui.screens.EnrollScreen;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class PairScreenTest {

    /** The deliberately wrong expectation of the {@code --fail} run. */
    private static final boolean FAIL_MODE =
            "true".equals(System.getenv("T114_FAIL_MODE"));

    @Test
    void thePairScreenIsTheEnrollmentForm() {
        Map<String, Object> json = EnrollScreen.render().toJson();

        assertThat(typesIn(json)).contains("screen", "form", "input");
        assertThat(nodesOfType(json, "input")).extracting(input -> input.get("id"))
                .containsExactly("code", "deviceName");
        assertThat(stringsIn(json)).contains("Pair with this environment", "Enroll this device");
    }

    @Test
    void thePairScreenCarriesTheHiddenErrorBanner() {
        Map<String, Object> json = EnrollScreen.render().toJson();

        Map<String, Object> banner = nodesWithId(json, EnrollScreen.ERROR_ID).get(0);
        assertThat(banner).containsEntry("type", "banner").containsEntry("visible", false);
    }

    @Test
    void theExpiredCodePatchesTheErrorBannerVisible() {
        EnrollAction action = new EnrollAction(new FakeEnrollmentService());

        List<Map<String, Object>> ops = action.handle(null,
                Map.of("code", FakeEnrollmentService.BAD_CODE, "deviceName", "qa-device"));

        if (FAIL_MODE) {
            // The deliberately wrong expectation: the expired code succeeds
            // (no error-banner patch).
            assertThat(ops).extracting(op -> op.get("op")).containsExactly("setToken", "navigate");
            return;
        }
        assertThat(ops).hasSize(1);
        assertThat(ops.get(0)).containsEntry("op", "patch")
                .containsEntry("id", EnrollScreen.ERROR_ID);
        Map<String, Object> props = castMap(ops.get(0).get("props"));
        assertThat(props).containsEntry("visible", true);
        assertThat(String.valueOf(props.get("content"))).contains("enrollment code expired");
    }

    @Test
    void theExpiredCodeIsTheDocumentedSecurityError() {
        FakeEnrollmentService enrollment = new FakeEnrollmentService();

        try {
            enrollment.redeem(FakeEnrollmentService.BAD_CODE, "qa-device");
            assertThat(false).as("the expired code must be refused").isTrue();
        } catch (SecurityException refused) {
            assertThat(refused.code()).isEqualTo(SecurityException.CODE_CODE_EXPIRED);
            assertThat(refused.httpStatus()).isEqualTo(410);
        }
    }

    // --- node walking helpers over the JSON wire shape ---

    private static List<Map<String, Object>> nodesOfType(Object fragment, String type) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(fragment, map -> {
            if (type.equals(map.get("type"))) {
                found.add(map);
            }
        });
        return found;
    }

    private static List<Map<String, Object>> nodesWithId(Object fragment, String id) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(fragment, map -> {
            if (id.equals(map.get("id"))) {
                found.add(map);
            }
        });
        return found;
    }

    private static java.util.Set<String> typesIn(Object fragment) {
        java.util.Set<String> types = new java.util.HashSet<>();
        walk(fragment, map -> {
            if (map.get("type") != null) {
                types.add(String.valueOf(map.get("type")));
            }
        });
        return types;
    }

    private static List<String> stringsIn(Object fragment) {
        List<String> texts = new ArrayList<>();
        collectStrings(fragment, texts);
        return texts;
    }

    private static void collectStrings(Object fragment, List<String> texts) {
        if (fragment instanceof String text) {
            texts.add(text);
        } else if (fragment instanceof Map<?, ?> map) {
            for (Object value : map.values()) {
                collectStrings(value, texts);
            }
        } else if (fragment instanceof List<?> list) {
            for (Object nested : list) {
                collectStrings(nested, texts);
            }
        }
    }

    private static void walk(Object fragment, java.util.function.Consumer<Map<String, Object>> seen) {
        if (fragment instanceof Map<?, ?> map) {
            Map<String, Object> copy = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                copy.put(String.valueOf(entry.getKey()), entry.getValue());
            }
            seen.accept(copy);
            for (Object nested : map.values()) {
                walk(nested, seen);
            }
        } else if (fragment instanceof List<?> list) {
            for (Object nested : list) {
                walk(nested, seen);
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }
}