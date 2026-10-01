/**
 * Server-side capability tailoring of UI nodes (D-22, applied at the source).
 *
 * <p>Two degradations, both applied before a node tree is written into a
 * payload:
 * <ul>
 *   <li>without the {@code sse} capability a {@code stream_view} node becomes a
 *       {@code list} carrying a server-side snapshot of the stream (the
 *       summaries of the tail of the session the topic points at, or the
 *       view's {@code empty} text when the stream is empty);</li>
 *   <li>inline directives embedded in node props (a button action, a submit
 *       action) are removed when the client cannot honour them — the same rule
 *       {@code Directives.filter} applies to directive lists.</li>
 * </ul>
 * Nested nodes are tailored recursively; universal props ({@code id},
 * {@code visible}, {@code padding}, {@code flex}, {@code when}) survive the
 * {@code stream_view} replacement so patches addressed at the id still land.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.http.ClientInfo;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class CapabilityTailor {

    /** Topic prefix of the session stream endpoint this plugin serves. */
    private static final String STREAM_TOPIC_PREFIX = "/ui/stream/session/";

    /** How many snapshot lines a degraded stream view keeps. */
    private static final int SNAPSHOT_LIMIT = 20;

    private final EventLog events;

    CapabilityTailor(EventLog events) {
        this.events = events;
    }

    /**
     * Returns the tailored copy of one node tree.
     *
     * @param node   the authored node
     * @param client the parsed {@code X-Jhin-Client} header
     * @return the node as the client can honour it
     */
    UiNode tailor(UiNode node, ClientInfo client) {
        if ("stream_view".equals(node.type()) && !client.supports("sse")) {
            return snapshotList(node);
        }
        Map<String, Object> props = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : node.props().entrySet()) {
            Object value = tailorValue(entry.getValue(), client);
            if (value != SKIP) {
                props.put(entry.getKey(), value);
            }
        }
        List<Object> children = new ArrayList<>();
        for (Object child : node.children()) {
            children.add(child instanceof UiNode inner ? tailor(inner, client) : child);
        }
        return new UiNode(node.type(), props, children);
    }

    /** Marker for a prop value that must not be written at all. */
    private static final Object SKIP = new Object();

    private Object tailorValue(Object value, ClientInfo client) {
        if (value instanceof UiNode node) {
            return tailor(node, client);
        }
        if (value instanceof List<?> list) {
            List<Object> kept = new ArrayList<>();
            for (Object entry : list) {
                Object tailored = tailorValue(entry, client);
                if (tailored != SKIP) {
                    kept.add(tailored);
                }
            }
            return kept;
        }
        if (value instanceof Map<?, ?> map && map.containsKey("op")) {
            @SuppressWarnings("unchecked")
            Map<String, Object> directive = (Map<String, Object>) map;
            return Directives.dropped(directive, client) ? SKIP : value;
        }
        return value;
    }

    /**
     * The {@code list} snapshot replacing a stream view: the universal props
     * survive, the items are the summaries of the session tail the topic names.
     */
    private UiNode snapshotList(UiNode streamView) {
        Map<String, Object> props = streamView.props();
        Map<String, Object> listProps = new LinkedHashMap<>();
        for (String universal : new String[] {"id", "visible", "padding", "flex", "when"}) {
            if (props.containsKey(universal)) {
                listProps.put(universal, props.get(universal));
            }
        }
        int limit = SNAPSHOT_LIMIT;
        Object itemLimit = props.get("itemLimit");
        if (itemLimit instanceof Number number) {
            limit = number.intValue();
        }
        List<Object> items = EventFrames.snapshotItems(recordsOf(props.get("topic")), limit);
        if (items.isEmpty() && props.get("empty") != null) {
            items = List.of(String.valueOf(props.get("empty")));
        }
        listProps.put("items", items);
        return new UiNode("list", listProps, List.of());
    }

    /**
     * The events of the session a stream topic names; the empty list when the
     * topic does not name one of this plugin's session streams.
     */
    private List<EventRecord> recordsOf(Object topic) {
        if (!(topic instanceof String path) || !path.startsWith(STREAM_TOPIC_PREFIX)) {
            return List.of();
        }
        String sessionId = path.substring(STREAM_TOPIC_PREFIX.length());
        if (sessionId.isBlank()) {
            return List.of();
        }
        return events.list(sessionId, 0);
    }
}
