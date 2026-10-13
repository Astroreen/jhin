/**
 * The run's changed-files summary of {@link RunSummaryBuilder} (T310): the
 * first-seen row order and the {@code ADDED} line counts of two writes to
 * two paths, the {@code MODIFIED} reclassification and the summed deltas of
 * a write followed by an edit on one path, the always-{@code MODIFIED}
 * edit-only row, the before-image deletions of a second write to the same
 * path, the silent drop of unknown tool names and of malformed payloads
 * (null map, missing or blank path, non-string content) without throwing,
 * the {@code isEmpty()} gate before and after ignored events, the reserved
 * {@code recordDelete} mark and the {@code splitLines} line-count rule
 * (trailing newline adds no line, {@code \r\n} is one separator, empty text
 * is zero lines).
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

import com.astroreen.jhin.plugin.ui.screens.RunSummaryBuilder;
import com.astroreen.jhin.plugin.ui.screens.RunSummaryBuilder.FileStat;
import com.astroreen.jhin.plugin.ui.screens.RunSummaryBuilder.Kind;
import java.util.Map;
import org.junit.jupiter.api.Test;

class RunSummaryBuilderTest {

    // --- the write rule ----------------------------------------------------

    @Test
    void twoWritesToTwoPathsProduceTwoAddedRowsInFirstSeenOrder() {
        RunSummaryBuilder summary = new RunSummaryBuilder();
        summary.record("write", Map.of(
                "path", "src/A.java", "content", "one\ntwo\nthree"));
        summary.record("write", Map.of(
                "path", "src/B.java", "content", "alpha\nbeta\n"));

        assertThat(summary.files()).containsExactly(
                new FileStat("src/A.java", 3, 0, Kind.ADDED),
                new FileStat("src/B.java", 2, 0, Kind.ADDED));
        assertThat(summary.isEmpty()).isFalse();
    }

    @Test
    void aSecondWriteOnOnePathIsModifiedWithTheFirstContentAsTheBeforeImage() {
        RunSummaryBuilder summary = new RunSummaryBuilder();
        summary.record("write", Map.of(
                "path", "src/A.java", "content", "one\ntwo\nthree"));
        summary.record("write", Map.of(
                "path", "src/A.java", "content", "four\n"));

        assertThat(summary.files()).containsExactly(
                new FileStat("src/A.java", 4, 3, Kind.MODIFIED));
    }

    @Test
    void anEmptyContentCountsZeroLines() {
        RunSummaryBuilder summary = new RunSummaryBuilder();
        summary.record("write", Map.of("path", "empty.txt", "content", ""));

        assertThat(summary.files()).containsExactly(
                new FileStat("empty.txt", 0, 0, Kind.ADDED));
    }

    // --- the edit rule -----------------------------------------------------

    @Test
    void aWriteFollowedByAnEditIsModifiedWithTheSummedDeltas() {
        RunSummaryBuilder summary = new RunSummaryBuilder();
        summary.record("write", Map.of(
                "path", "src/A.java", "content", "one\ntwo\nthree"));
        summary.record("edit", Map.of(
                "path", "src/A.java",
                "oldString", "two\n",
                "newString", "2\n3\n"));

        assertThat(summary.files()).containsExactly(
                new FileStat("src/A.java", 5, 1, Kind.MODIFIED));
    }

    @Test
    void anEditOnlyPathIsAlwaysModified() {
        RunSummaryBuilder summary = new RunSummaryBuilder();
        summary.record("edit", Map.of(
                "path", "src/A.java",
                "oldString", "one\ntwo\n",
                "newString", "uno\n"));

        assertThat(summary.files()).containsExactly(
                new FileStat("src/A.java", 1, 2, Kind.MODIFIED));
    }

    @Test
    void aReplaceAllEditStillCountsOneReplacement() {
        RunSummaryBuilder summary = new RunSummaryBuilder();
        summary.record("edit", Map.of(
                "path", "src/A.java",
                "oldString", "x\n",
                "newString", "y\n",
                "replaceAll", true));

        assertThat(summary.files()).containsExactly(
                new FileStat("src/A.java", 1, 1, Kind.MODIFIED));
    }

    // --- the ignored events ------------------------------------------------

    @Test
    void anUnknownToolNameIsIgnored() {
        RunSummaryBuilder summary = new RunSummaryBuilder();
        summary.record("read", Map.of("path", "src/A.java", "content", "x\n"));
        summary.record("shell", Map.of("command", "ls"));
        summary.record(null, Map.of("path", "src/A.java", "content", "x\n"));

        assertThat(summary.files()).isEmpty();
        assertThat(summary.isEmpty()).isTrue();
    }

    @Test
    void malformedPayloadsAreIgnoredWithoutThrowing() {
        RunSummaryBuilder summary = new RunSummaryBuilder();

        assertThatCode(() -> {
            summary.record("write", null);
            summary.record("write", Map.of("content", "x\n"));
            summary.record("write", Map.of("path", "  ", "content", "x\n"));
            summary.record("write", Map.of("path", "src/A.java", "content", 42));
            summary.record("write", Map.of("path", "src/A.java"));
            summary.record("edit", Map.of("path", "src/A.java", "oldString", "x\n"));
            summary.record("edit", Map.of("path", "src/A.java", "newString", "x\n"));
            summary.record("edit", Map.of(
                    "path", "src/A.java", "oldString", 1, "newString", "x\n"));
            summary.record("edit", Map.of("path", 7, "oldString", "x", "newString", "y"));
        }).doesNotThrowAnyException();

        assertThat(summary.files()).isEmpty();
    }

    @Test
    void isEmptyIsTrueBeforeAndAfterIgnoredEventsAndFalseAfterARealOne() {
        RunSummaryBuilder summary = new RunSummaryBuilder();
        assertThat(summary.isEmpty()).isTrue();

        summary.record("read", Map.of("path", "src/A.java"));
        summary.record("write", Map.of("path", "  ", "content", "x\n"));
        assertThat(summary.isEmpty()).isTrue();

        summary.record("write", Map.of("path", "src/A.java", "content", "x\n"));
        assertThat(summary.isEmpty()).isFalse();
    }

    // --- the reserved delete mark -----------------------------------------

    @Test
    void recordDeleteMarksTheRowDeletedAndIgnoresBlankPaths() {
        RunSummaryBuilder summary = new RunSummaryBuilder();
        summary.record("write", Map.of("path", "src/A.java", "content", "one\ntwo\n"));
        summary.recordDelete("src/A.java");
        summary.recordDelete("  ");
        summary.recordDelete(null);
        summary.recordDelete("src/Gone.java");

        assertThat(summary.files()).containsExactly(
                new FileStat("src/A.java", 2, 0, Kind.DELETED),
                new FileStat("src/Gone.java", 0, 0, Kind.DELETED));
    }

    // --- the line-count rule -----------------------------------------------

    @Test
    void theLineCountRuleMirrorsSplitLines() {
        RunSummaryBuilder summary = new RunSummaryBuilder();
        summary.record("write", Map.of("path", "trailing.txt", "content", "a\nb\n"));
        summary.record("write", Map.of("path", "crlf.txt", "content", "a\r\nb\r\n"));
        summary.record("write", Map.of("path", "bare-cr.txt", "content", "a\rb"));
        summary.record("write", Map.of("path", "gaps.txt", "content", "a\n\n\nb"));

        assertThat(summary.files()).containsExactly(
                new FileStat("trailing.txt", 2, 0, Kind.ADDED),
                new FileStat("crlf.txt", 2, 0, Kind.ADDED),
                new FileStat("bare-cr.txt", 2, 0, Kind.ADDED),
                new FileStat("gaps.txt", 4, 0, Kind.ADDED));
    }
}
