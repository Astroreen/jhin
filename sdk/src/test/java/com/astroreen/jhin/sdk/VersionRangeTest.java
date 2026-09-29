package com.astroreen.jhin.sdk;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * Tests for {@link VersionRange}: the four accepted grammar forms, the numeric
 * semantics of {@link VersionRange#satisfies(String)} and the rejection of
 * malformed ranges and versions. Every rejection case documents why its input
 * is a load error.
 */
class VersionRangeTest {

    // --- accepted forms ---

    /**
     * Form 1 ({@code *}): the wildcard accepts every valid version.
     */
    @Test
    void starFormMatchesAnyValidVersion() {
        VersionRange range = VersionRange.parse("*");
        assertTrue(range.satisfies("0.0.0"));
        assertTrue(range.satisfies("1.2.3"));
        assertTrue(range.satisfies("99.99.99"));
    }

    /**
     * Form 2 (exact {@code 1.2.3}): only the identical version satisfies;
     * neighbours on either side do not.
     */
    @Test
    void exactFormMatchesOnlyEqualVersion() {
        VersionRange range = VersionRange.parse("1.2.3");
        assertTrue(range.satisfies("1.2.3"));
        assertFalse(range.satisfies("1.2.2"));
        assertFalse(range.satisfies("1.2.4"));
        assertFalse(range.satisfies("2.0.0"));
    }

    /**
     * Form 3 ({@code >=1.2.3}): the lower bound is inclusive, anything below
     * it fails.
     */
    @Test
    void gteFormIsLowerBoundInclusive() {
        VersionRange range = VersionRange.parse(">=1.2.3");
        assertTrue(range.satisfies("1.2.3"));
        assertTrue(range.satisfies("1.2.4"));
        assertTrue(range.satisfies("2.0.0"));
        assertFalse(range.satisfies("1.2.2"));
        assertFalse(range.satisfies("0.9.9"));
    }

    /**
     * Form 4 ({@code >=1.2.3 <2.0.0}): lower bound inclusive, upper bound
     * exclusive.
     */
    @Test
    void boundedFormIsLowerInclusiveUpperExclusive() {
        VersionRange range = VersionRange.parse(">=1.2.3 <2.0.0");
        assertTrue(range.satisfies("1.2.3"));
        assertTrue(range.satisfies("1.9.9"));
        assertFalse(range.satisfies("1.2.2"));
        assertFalse(range.satisfies("2.0.0"));
        assertFalse(range.satisfies("2.0.1"));
    }

    /**
     * Semantic comparison: components are numeric, so {@code 1.10.0} sorts
     * above {@code 1.2.0} (a text comparison would get this wrong).
     */
    @Test
    void comparesComponentsNumericallyNotLexicographically() {
        assertTrue(VersionRange.parse(">=1.10.0").satisfies("1.10.0"));
        assertFalse(VersionRange.parse(">=1.10.0").satisfies("1.9.0"));
        assertTrue(VersionRange.parse(">=1.2.0").satisfies("1.10.0"));
        assertTrue(VersionRange.parse("1.10.0").satisfies("1.10.0"));
        assertFalse(VersionRange.parse("1.10.0").satisfies("1.2.0"));
    }

    // --- rejections: every case below is a load error ---

    /**
     * Rejection 1: {@code null} carries no form at all, so parsing it is a
     * load error.
     */
    @Test
    void rejectsNullRange() {
        assertThrows(PluginException.class, () -> VersionRange.parse(null));
    }

    /**
     * Rejection 2: blank text names no form either — same load error as
     * {@code null}.
     */
    @Test
    void rejectsBlankRange() {
        assertThrows(PluginException.class, () -> VersionRange.parse(""));
        assertThrows(PluginException.class, () -> VersionRange.parse("   "));
    }

    /**
     * Rejection 3: {@code 1.2} has only two components; the exact form
     * requires a full {@code major.minor.patch} triple.
     */
    @Test
    void rejectsTwoComponentExactVersion() {
        assertThrows(PluginException.class, () -> VersionRange.parse("1.2"));
    }

    /**
     * Rejection 4: {@code >} is not an accepted operator — the grammar has
     * exactly one bound operator ({@code >=}).
     */
    @Test
    void rejectsUnsupportedOperator() {
        assertThrows(PluginException.class, () -> VersionRange.parse(">1.2.3"));
    }

    /**
     * Rejection 5: in the two-bound form every bound must be a full
     * {@code major.minor.patch} triple; {@code <2} is not.
     */
    @Test
    void rejectsNonSemverUpperBound() {
        assertThrows(PluginException.class, () -> VersionRange.parse(">=1.2.3 <2"));
    }

    /**
     * Rejection 6: {@link VersionRange#satisfies(String)} takes a plain
     * {@code major.minor.patch} version; prerelease suffixes like {@code -rc1}
     * are outside the grammar, so passing one is a load error.
     */
    @Test
    void rejectsInvalidVersionArgument() {
        assertThrows(PluginException.class, () -> VersionRange.parse("*").satisfies("1.2.3-rc1"));
    }
}
