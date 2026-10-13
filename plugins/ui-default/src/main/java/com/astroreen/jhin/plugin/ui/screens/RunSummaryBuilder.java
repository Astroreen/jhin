/**
 * The run's changed-files summary (T310): a pure, side-effect-free
 * accumulator that folds the run's file-tool {@code tool_use} payloads into
 * an ordered list of changed files with per-file line stats and a change
 * kind.
 *
 * <p><b>Changed files come from run events, never git</b> (the plan's D-6
 * ruling): the summary is built from the {@code write} and {@code edit}
 * payloads of the run's tool calls, so it works before {@code jhin.git}
 * exists and never touches the working tree. The rows appear in first-seen
 * order and the stats are simple sums of the per-event deltas.
 *
 * <p><b>The two producers</b> (the tools-builtin payloads): {@code write}
 * carries {@code path} and {@code content} (the full new file content),
 * {@code edit} carries {@code path}, {@code oldString} and {@code newString}
 * (all strings; {@code replaceAll} is an optional boolean and is ignored for
 * stats). A missing or blank {@code path} or a non-string content field
 * makes the whole event invalid: it is ignored silently and never throws.
 * Any other tool name is ignored silently as well.
 *
 * <p><b>The event rules.</b> The first event for a path opens the row with
 * kind {@code ADDED}: a {@code write} adds the line count of its
 * {@code content} to {@code add} (and {@code 0} to {@code del}), an
 * {@code edit} contributes its deltas but still opens the row as
 * {@code ADDED} only through {@code write} — an edit-only path is always
 * {@code MODIFIED}, because the tool errors on missing files. A later event
 * for the same path reclassifies the row as {@code MODIFIED} and
 * accumulates: {@code edit} adds the line count of {@code oldString} to
 * {@code del} and that of {@code newString} to {@code add}; {@code write}
 * treats the already-recorded content as the before-image — its line count
 * goes to {@code del}, the line count of the new content to {@code add}.
 *
 * <p><b>Line counting</b> mirrors the {@code splitLines} rule of
 * {@code jhin.tools-builtin}'s {@code FileToolSupport} exactly (copied into
 * a private helper — the rule is duplicated on purpose, never called across
 * plugins): one line per {@code \n} or {@code \r} ({@code \r\n} is a single
 * separator), the segment after the last separator only when non-empty —
 * so a trailing newline does not add an empty line and empty text is zero
 * lines.
 *
 * <p><b>Approximations.</b> A {@code replaceAll} edit counts as ONE
 * replacement: the match count lives in the {@code tool_result}, not in the
 * {@code tool_use} payload this accumulator sees. The before-image of a
 * later {@code write} is the content of the previous {@code write} to the
 * path (edits carry no full content and do not rewrite the recorded image);
 * a {@code write} to a path only edited before counts {@code 0} deletions.
 *
 * <p><b>Threading.</b> The builder is thread-confined and not thread-safe:
 * {@code EventFrames} feeds it single-threaded while it folds the run's
 * events, and {@link #files()} snapshots the current rows for rendering.
 */
package com.astroreen.jhin.plugin.ui.screens;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class RunSummaryBuilder {

    /** The tools-builtin name of the file-writing tool. */
    private static final String TOOL_WRITE = "write";

    /** The tools-builtin name of the file-editing tool. */
    private static final String TOOL_EDIT = "edit";

    /** The per-path rows in first-seen order. */
    private final Map<String, Entry> entries = new LinkedHashMap<>();

    /**
     * Feeds one {@code tool_use} payload into the summary. A {@code write}
     * records the full new file content (and the previous one as the
     * deletions), an {@code edit} records the {@code oldString} /
     * {@code newString} line deltas; any other tool name, a {@code null}
     * payload, a missing or blank {@code path} or a non-string content
     * field is ignored silently.
     *
     * @param toolName the tool name ({@code write} or {@code edit})
     * @param input    the tool input payload, may be {@code null}
     */
    public void record(String toolName, Map<String, Object> input) {
        if (input == null) {
            return;
        }
        if (TOOL_WRITE.equals(toolName)) {
            recordWrite(input);
        } else if (TOOL_EDIT.equals(toolName)) {
            recordEdit(input);
        }
    }

    /**
     * Marks the row of a path as {@code Kind#DELETED}. Reserved: no tool
     * produces deletes today (tools-builtin has no delete tool), so no
     * {@code tool_use} event ever reaches this method — the stats of an
     * already-recorded row stay untouched, and an unknown path opens an
     * empty {@code DELETED} row.
     *
     * @param path the file path; missing or blank paths are ignored
     */
    public void recordDelete(String path) {
        if (path == null || path.isBlank()) {
            return;
        }
        Entry entry = entries.computeIfAbsent(path, Entry::new);
        entry.kind = Kind.DELETED;
    }

    /**
     * The accumulated rows in first-seen order, as immutable snapshots.
     *
     * @return the changed-files summary of the run so far
     */
    public List<FileStat> files() {
        List<FileStat> out = new ArrayList<>(entries.size());
        for (Entry entry : entries.values()) {
            out.add(new FileStat(entry.path, entry.add, entry.del, entry.kind));
        }
        return out;
    }

    /**
     * Whether no file event has been recorded yet.
     *
     * @return {@code true} when the summary is empty
     */
    public boolean isEmpty() {
        return entries.isEmpty();
    }

    /**
     * The kind of change a row reports.
     */
    public enum Kind {
        /** The file was created by the run (the first event was a write). */
        ADDED,
        /** The file already existed and the run changed it. */
        MODIFIED,
        /** The run deleted the file (reserved, see {@link #recordDelete}). */
        DELETED
    }

    /**
     * One changed-file row: the path, the added and deleted line counts and
     * the change kind.
     *
     * @param path the file path as recorded in the tool payload
     * @param add  the added line count (the sum of the per-event additions)
     * @param del  the deleted line count (the sum of the per-event deletions)
     * @param kind the change kind
     */
    public record FileStat(String path, int add, int del, Kind kind) {
    }

    // ------------------------------------------------------------------
    // the two producers
    // ------------------------------------------------------------------

    /**
     * The {@code write} rule: the first event for a path opens an
     * {@code ADDED} row counting the content lines as additions; a later
     * event reclassifies the row as {@code MODIFIED}, counts the previously
     * recorded content lines as deletions and the new content lines as
     * additions. The new content becomes the recorded before-image.
     */
    private void recordWrite(Map<String, Object> input) {
        String path = pathOf(input);
        if (path == null) {
            return;
        }
        if (!(input.get("content") instanceof String content)) {
            return;
        }
        Entry entry = entries.get(path);
        if (entry == null) {
            entry = new Entry(path);
            entry.kind = Kind.ADDED;
            entry.add = countLines(content);
            entry.content = content;
            entries.put(path, entry);
            return;
        }
        entry.kind = Kind.MODIFIED;
        if (entry.content != null) {
            entry.del += countLines(entry.content);
        }
        entry.add += countLines(content);
        entry.content = content;
    }

    /**
     * The {@code edit} rule: the row is always {@code MODIFIED} (the tool
     * errors on missing files), the {@code oldString} lines count as
     * deletions and the {@code newString} lines as additions — one
     * replacement per event, {@code replaceAll} or not. The recorded
     * content image is left untouched (an edit payload carries no full
     * content).
     */
    private void recordEdit(Map<String, Object> input) {
        String path = pathOf(input);
        if (path == null) {
            return;
        }
        if (!(input.get("oldString") instanceof String oldText)
                || !(input.get("newString") instanceof String newText)) {
            return;
        }
        Entry entry = entries.computeIfAbsent(path, Entry::new);
        entry.kind = Kind.MODIFIED;
        entry.del += countLines(oldText);
        entry.add += countLines(newText);
    }

    /** The {@code path} of a payload, {@code null} when missing or blank. */
    private static String pathOf(Map<String, Object> input) {
        if (!(input.get("path") instanceof String path) || path.isBlank()) {
            return null;
        }
        return path;
    }

    /**
     * The line count of a text under the {@code splitLines} rule of
     * tools-builtin's {@code FileToolSupport}, copied here verbatim in its
     * counting (one line per {@code \n} or {@code \r}, {@code \r\n} as a
     * single separator, the trailing segment only when non-empty) — the
     * rule is duplicated on purpose and never called across plugins.
     */
    private static int countLines(String text) {
        int lines = 0;
        int n = text.length();
        int start = 0;
        for (int i = 0; i < n; i++) {
            char c = text.charAt(i);
            if (c == '\n') {
                lines++;
                start = i + 1;
            } else if (c == '\r') {
                if (i + 1 < n && text.charAt(i + 1) == '\n') {
                    i++;
                }
                lines++;
                start = i + 1;
            }
        }
        if (start < n) {
            lines++;
        }
        return lines;
    }

    /** The mutable per-path accumulator behind the {@link FileStat} rows. */
    private static final class Entry {

        /** The file path of the row. */
        final String path;

        /** The accumulated added line count. */
        int add;

        /** The accumulated deleted line count. */
        int del;

        /** The change kind of the row. */
        Kind kind;

        /**
         * The content of the last {@code write} to the path — the
         * before-image of the next one; {@code null} when no content is
         * recorded (an edit-only path).
         */
        String content;

        Entry(String path) {
            this.path = path;
        }
    }
}
