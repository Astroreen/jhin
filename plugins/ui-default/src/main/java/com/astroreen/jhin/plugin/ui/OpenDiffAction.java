/**
 * The {@code open-diff} action (T310): the {@code Open diff} button of the
 * run's changed-files summary. The payload carries the fixed fields
 * {@code sessionId} and {@code path}; the handler replays the session's
 * recorded {@code write}/{@code edit} {@code tool_use} payloads for that path
 * into {@code diff_view} hunks and patches the right-panel diff node with
 * them — server-authored hunks from run events, never git (the plan's D-6
 * ruling) and never a client-side diff. A hunk is the recorded delta of one
 * tool call ({@code oldString} vs {@code newString} for {@code edit}, the
 * full {@code content} as an all-add hunk for {@code write}), so the view
 * stays honest about being a replay of the run, not a working-tree diff.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.ui.screens.ChatScreen;
import com.astroreen.jhin.plugin.ui.screens.RightPanelBuilder;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.json.Json;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class OpenDiffAction {

    /** The tools-builtin name of the file-writing tool. */
    private static final String TOOL_WRITE = "write";

    /** The tools-builtin name of the file-editing tool. */
    private static final String TOOL_EDIT = "edit";

    private final EventLog events;

    OpenDiffAction(EventLog events) {
        this.events = events;
    }

    /**
     * Patches the right-panel diff view with the recorded hunks of one file.
     *
     * @param req     the request that carried the action (unused)
     * @param payload the merged payload: {@code sessionId} and {@code path}
     * @return the patch directive plus a toast, or the error toast when the
     *         payload is incomplete or the path has no recorded changes
     */
    List<Map<String, Object>> handle(
            @SuppressWarnings("unused") HttpRequest req,
            Map<String, Object> payload) {
        String sessionId = ActionSupport.text(payload, "sessionId");
        String path = ActionSupport.text(payload, "path");
        if (sessionId == null || path == null) {
            return ActionSupport.error("open-diff needs a sessionId and a path.");
        }
        List<Map<String, Object>> hunks = hunks(sessionId, path);
        if (hunks.isEmpty()) {
            return ActionSupport.error("No recorded changes for " + path + ".");
        }
        Map<String, Object> content = new LinkedHashMap<>();
        content.put("file", path);
        content.put("stats", Map.of("additions", additions(hunks),
                "deletions", deletions(hunks)));
        content.put("hunks", hunks);
        return List.of(
                Directives.setState(ChatScreen.STATE_RIGHT_PANEL, true),
                Directives.setState(RightPanelBuilder.STATE_DIFF_FILE, path),
                // The diff_view primitive is decorative until the T311 diff
                // engine (docs/sdui.md section 2.6), so the node carries the
                // demo marker while its hunks are the real recorded ones.
                Directives.patch(RightPanelBuilder.DIFF_VIEW_ID,
                        RightPanelBuilder.diffViewNode(content, true)),
                Directives.toast("Opened diff for " + path + "."));
    }

    /** The recorded hunks of one path, one hunk per matching tool call. */
    private List<Map<String, Object>> hunks(String sessionId, String path) {
        List<Map<String, Object>> hunks = new ArrayList<>();
        for (EventRecord record : events.list(sessionId, 0)) {
            if (record.type() != EventType.TOOL_USE) {
                continue;
            }
            Map<String, Object> event = parse(record.payload());
            String name = event.get("name") instanceof String tool ? tool : null;
            Map<String, Object> args = objectOf(event.get("arguments"));
            if (args == null || !path.equals(args.get("path"))) {
                continue;
            }
            if (TOOL_EDIT.equals(name)) {
                hunks.add(hunk(linesOf(args.get("oldString")), linesOf(args.get("newString"))));
            } else if (TOOL_WRITE.equals(name)) {
                hunks.add(hunk(List.of(), linesOf(args.get("content"))));
            }
        }
        return hunks;
    }

    /** One hunk of the recorded delta: the before lines deleted, the after lines added. */
    private static Map<String, Object> hunk(List<String> before, List<String> after) {
        List<Map<String, Object>> lines = new ArrayList<>();
        int oldNo = 1;
        for (String line : before) {
            lines.add(Map.of("kind", "del", "oldNo", oldNo++, "text", line));
        }
        int newNo = 1;
        for (String line : after) {
            lines.add(Map.of("kind", "add", "newNo", newNo++, "text", line));
        }
        String header = "@@ -" + (before.isEmpty() ? 0 : 1) + "," + before.size()
                + " +" + (after.isEmpty() ? 0 : 1) + "," + after.size() + " @@";
        return Map.of("header", header, "lines", lines);
    }

    /** The total added lines across the hunks. */
    private static int additions(List<Map<String, Object>> hunks) {
        return count(hunks, "add");
    }

    /** The total deleted lines across the hunks. */
    private static int deletions(List<Map<String, Object>> hunks) {
        return count(hunks, "del");
    }

    private static int count(List<Map<String, Object>> hunks, String kind) {
        int total = 0;
        for (Map<String, Object> hunk : hunks) {
            for (Object line : listOf(hunk.get("lines"))) {
                if (line instanceof Map<?, ?> row && kind.equals(row.get("kind"))) {
                    total++;
                }
            }
        }
        return total;
    }

    /** The split-lines rule of {@code jhin.tools-builtin}: {@code \n} or {@code \r} separators. */
    private static List<String> linesOf(Object value) {
        if (!(value instanceof String text) || text.isEmpty()) {
            return List.of();
        }
        List<String> lines = new ArrayList<>();
        int start = 0;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '\n' || c == '\r') {
                lines.add(text.substring(start, i));
                if (c == '\r' && i + 1 < text.length() && text.charAt(i + 1) == '\n') {
                    i++;
                }
                start = i + 1;
            }
        }
        if (start < text.length()) {
            lines.add(text.substring(start));
        }
        return lines;
    }

    /** Parses a payload JSON object; blank or malformed text yields the empty map. */
    private static Map<String, Object> parse(String payloadJson) {
        if (payloadJson == null || payloadJson.isBlank()) {
            return Map.of();
        }
        try {
            return Json.readMap(payloadJson);
        } catch (RuntimeException e) {
            return Map.of();
        }
    }

    /** The object form of a payload field: maps pass through, JSON text is parsed. */
    private static Map<String, Object> objectOf(Object value) {
        if (value instanceof Map<?, ?> map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> typed = (Map<String, Object>) map;
            return typed;
        }
        if (value instanceof String text && !text.isBlank()) {
            try {
                return Json.readMap(text);
            } catch (RuntimeException e) {
                return Map.of();
            }
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> listOf(Object value) {
        return (value instanceof List<?> list) ? (List<Object>) list : List.of();
    }
}
