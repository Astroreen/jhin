/**
 * Server-side capability tailoring of UI nodes and the api/schema negotiation
 * arithmetic (docs/sdui.md section 6, D-22), applied at the source.
 *
 * <p>Four independent degradations, all applied before a node tree is
 * written into a payload:
 * <ul>
 *   <li>without the {@code sse} capability a {@code stream_view} node becomes a
 *       {@code list} carrying a server-side snapshot of the stream (the
 *       summaries of the tail of the session the topic points at, or the
 *       view's {@code empty} text when the stream is empty) — unchanged from
 *       level 1, independent of the negotiated contract level;</li>
 *   <li>inline directives embedded in node props (a button action, a submit
 *       action) are removed when the client cannot honour them — the same
 *       rule {@code Directives.filter} applies to directive lists;</li>
 *   <li>below the negotiated level 3, the level-3 primitives degrade per the
 *       docs/sdui.md section 6 table ({@code split} to a {@code column},
 *       {@code hover_card} to its trigger, {@code toast_stack} to a
 *       {@code column} of texts, {@code kbd} to a {@code text},
 *       {@code scroll_fade} to a {@code scroll}, {@code diff_view} to a
 *       {@code code_block}) and the level-3 universal props
 *       {@code glass}/{@code glassTint}/{@code statusPulse} are stripped
 *       ({@code demo} and the {@code safeArea} group survive as inert
 *       markers);</li>
 *   <li>below the negotiated level 2, every level-2-only primitive degrades
 *       to its level-1 equivalent per the docs/sdui.md section 6 downgrade
 *       table, applied after the level-3 step.</li>
 * </ul>
 * Nested nodes are tailored recursively; universal props ({@code id},
 * {@code visible}, {@code padding}, {@code flex}, {@code when}) survive every
 * replacement so patches addressed at the id still land.
 *
 * <p>{@link #negotiatedApi(ClientInfo)} implements the {@code min(client api,
 * server api)} rule the whole bootstrap payload follows (docs/sdui.md section
 * 6); {@link #isLevel2(ClientInfo)} is the convenience predicate
 * {@link BootstrapRoute} uses to decide whether to emit the level-2-only
 * top-level fields ({@code contract}, {@code tokens}, {@code density},
 * {@code keymap}) at all.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.ApiVersion;
import com.astroreen.jhin.sdk.http.ClientInfo;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

final class CapabilityTailor {

    /** Topic prefix of the session stream endpoint this plugin serves. */
    private static final String STREAM_TOPIC_PREFIX = "/ui/stream/session/";

    /** How many snapshot lines a degraded stream view keeps. */
    private static final int SNAPSHOT_LIMIT = 20;

    /** The universal props that survive every structural replacement. */
    private static final List<String> UNIVERSAL_PROP_KEYS =
            List.of("id", "visible", "padding", "flex", "when");

    /** Default fill color for a degraded {@code avatar -> figure} when none was set. */
    private static final String DEFAULT_FIGURE_COLOR = "#7E57C2";

    /** Default diameter (px) for a degraded {@code avatar -> figure} without a size. */
    private static final int DEFAULT_AVATAR_SIZE = 40;

    /**
     * The level-2 -> level-1 primitive downgrade table (docs/sdui.md section
     * 6). A type absent from this map is emitted unchanged below level 2.
     */
    private static final Map<String, String> DOWNGRADE_TYPES = Map.ofEntries(
            Map.entry("shell", "container"),
            Map.entry("row", "container"),
            Map.entry("list_row", "card"),
            Map.entry("chip", "text"),
            Map.entry("badge", "text"),
            Map.entry("sheet", "card"),
            Map.entry("dialog", "card"),
            Map.entry("code_block", "text"),
            Map.entry("tabs", "nav"),
            Map.entry("skeleton", "progress"),
            Map.entry("avatar", "figure"),
            Map.entry("menu", "list"),
            Map.entry("tree", "list"),
            Map.entry("rich_text", "text"));

    /**
     * The level-3 -> level-2 primitive downgrade table (docs/sdui.md section
     * 6); {@code hover_card} is not in it because its downgrade replaces the
     * node instead of renaming it. A type absent from this map is emitted
     * unchanged below level 3.
     */
    private static final Map<String, String> DOWNGRADE_LEVEL3_TYPES = Map.ofEntries(
            Map.entry("split", "column"),
            Map.entry("toast_stack", "column"),
            Map.entry("kbd", "text"),
            Map.entry("scroll_fade", "scroll"),
            Map.entry("diff_view", "code_block"));

    /**
     * The level-3 universal props a level-2 client cannot honour; stripped
     * from every node below level 3. {@code demo} and the {@code safeArea}
     * group are deliberately kept — both are inert markers.
     */
    private static final Set<String> LEVEL3_STRIPPED_PROPS = Set.of("glass", "glassTint", "statusPulse");

    /** The universal props carried onto a {@code hover_card} trigger. */
    private static final List<String> UNIVERSAL_PLUS_TOOLTIP =
            List.of("id", "visible", "padding", "flex", "when", "tooltip");

    private final EventLog events;

    CapabilityTailor(EventLog events) {
        this.events = events;
    }

    /**
     * The contract level the server replies at: {@code min(client api,
     * server api)} (docs/sdui.md section 6). {@link ClientInfo#api()} is
     * already lenient (never below 1), so this is never below 1 either, and
     * it is capped at the level this server speaks
     * ({@link ApiVersion#SDUI_CONTRACT}) so a client declaring a future
     * level still gets a payload this server actually implements.
     *
     * @param client the parsed {@code X-Jhin-Client} header
     * @return the negotiated contract level
     */
    int negotiatedApi(ClientInfo client) {
        return Math.min(client.api(), ApiVersion.SDUI_CONTRACT);
    }

    /**
     * Whether the negotiated level includes the level-2 payload shape
     * ({@code contract}/{@code tokens}/{@code density}/{@code keymap} and the
     * level-2 primitive catalog).
     *
     * @param client the parsed {@code X-Jhin-Client} header
     * @return {@code true} when {@link #negotiatedApi(ClientInfo)} is at least 2
     */
    boolean isLevel2(ClientInfo client) {
        return negotiatedApi(client) >= 2;
    }

    /**
     * Returns the tailored copy of one node tree.
     *
     * @param node   the authored node
     * @param client the parsed {@code X-Jhin-Client} header
     * @return the node as the client can honour it
     */
    UiNode tailor(UiNode node, ClientInfo client) {
        int level = negotiatedApi(client);
        UiNode working = node;
        if (level < 3) {
            working = downgradeLevel3(working);
        }
        if (level < 2) {
            working = downgrade(working);
        }
        if ("stream_view".equals(working.type()) && !client.supports("sse")) {
            return snapshotList(working);
        }
        boolean stripLevel3 = level < 3;
        Map<String, Object> props = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : working.props().entrySet()) {
            if (stripLevel3 && LEVEL3_STRIPPED_PROPS.contains(entry.getKey())) {
                continue;
            }
            Object value = tailorValue(entry.getValue(), client);
            if (value != SKIP) {
                props.put(entry.getKey(), value);
            }
        }
        List<Object> children = new ArrayList<>();
        for (Object child : working.children()) {
            children.add(child instanceof UiNode inner ? tailor(inner, client) : child);
        }
        return new UiNode(working.type(), props, children);
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
        if (value instanceof Map<?, ?> map && map.get("client") instanceof List<?>) {
            // The inline directive composite of a decorative control (the
            // plan section 4.4 shape): tailor the embedded list the same way
            // a response directive list is tailored; empty results drop the
            // whole prop.
            List<Object> kept = new ArrayList<>();
            for (Object entry : (List<?>) map.get("client")) {
                Object tailored = tailorValue(entry, client);
                if (tailored != SKIP) {
                    kept.add(tailored);
                }
            }
            if (kept.isEmpty()) {
                return SKIP;
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> composite = new LinkedHashMap<>((Map<String, Object>) map);
            composite.put("client", kept);
            return composite;
        }
        return value;
    }

    // ------------------------------------------------------------------
    // Level-3 -> level-2 primitive downgrade (docs/sdui.md section 6)
    // ------------------------------------------------------------------

    /**
     * Degrades one level-3-only primitive to its level-2 equivalent: the
     * {@link #DOWNGRADE_LEVEL3_TYPES} rename table plus the two special
     * shapes — {@code hover_card} is replaced by its trigger node and
     * {@code toast_stack} folds its items into a column of texts. A type
     * outside the table is returned unchanged. Recursion into children
     * happens in {@link #tailor} right after this call runs — this method
     * only rewrites the node it is given, never its descendants directly.
     *
     * @param node the node as authored (level-3 shape)
     * @return the node a level-2 client can render; the same instance when
     *         the type is not level-3-only
     */
    private static UiNode downgradeLevel3(UiNode node) {
        if ("hover_card".equals(node.type())) {
            return hoverCardTrigger(node);
        }
        String degraded = DOWNGRADE_LEVEL3_TYPES.get(node.type());
        if (degraded == null) {
            return node;
        }
        Map<String, Object> props = new LinkedHashMap<>(node.props());
        List<Object> children = new ArrayList<>(node.children());
        switch (node.type()) {
            case "split" -> {
                Object first = props.remove("first");
                Object second = props.remove("second");
                Map<String, Object> universal = universalProps(props);
                props.clear();
                props.putAll(universal);
                for (Object pane : new Object[] {first, second}) {
                    if (pane != null) {
                        children.add(pane);
                    }
                }
            }
            case "toast_stack" -> {
                Object items = props.remove("items");
                props.remove("direction");
                Map<String, Object> universal = universalProps(props);
                props.clear();
                props.putAll(universal);
                children.addAll(toastTexts(items));
            }
            case "kbd" -> {
                Object chord = props.remove("chord");
                Map<String, Object> universal = universalProps(props);
                props.clear();
                props.putAll(universal);
                props.put("text", chord == null ? "" : String.valueOf(chord));
                props.put("style", "mono");
            }
            case "scroll_fade" -> {
                Object child = props.remove("child");
                props.remove("edge");
                props.remove("height");
                props.remove("mode");
                Map<String, Object> universal = universalProps(props);
                props.clear();
                props.putAll(universal);
                if (child != null) {
                    children.add(child);
                }
            }
            case "diff_view" -> {
                Object file = props.remove("file");
                Object hunks = props.remove("hunks");
                props.remove("view");
                props.remove("colorScheme");
                props.remove("stats");
                props.put("code", diffCode(file, hunks));
            }
            default -> {
                // type-only downgrade, no prop translation needed
            }
        }
        return new UiNode(degraded, props, children);
    }

    /**
     * The {@code hover_card} downgrade: the node is replaced by its
     * {@code trigger} node with the universal props (including
     * {@code tooltip}) merged onto it — the trigger's own props win — and
     * the card content is dropped. Without a trigger the card degrades to an
     * empty {@code column} carrying the universal props (nothing to show).
     */
    private static UiNode hoverCardTrigger(UiNode node) {
        Map<String, Object> carried = new LinkedHashMap<>();
        for (String key : UNIVERSAL_PLUS_TOOLTIP) {
            if (node.props().containsKey(key)) {
                carried.put(key, node.props().get(key));
            }
        }
        Object trigger = node.props().get("trigger");
        if (trigger instanceof UiNode inner) {
            Map<String, Object> merged = new LinkedHashMap<>(inner.props());
            carried.forEach(merged::putIfAbsent);
            return new UiNode(inner.type(), merged, inner.children());
        }
        if (trigger instanceof String text && !text.isBlank()) {
            return new UiNode("text", carried, List.of(text));
        }
        return new UiNode("column", carried, List.of());
    }

    /** One plain {@code text} node per {@code toast_stack} item (lossy, visible). */
    private static List<Object> toastTexts(Object items) {
        List<Object> texts = new ArrayList<>();
        if (items instanceof List<?> list) {
            for (Object item : list) {
                if (item instanceof Map<?, ?> map && map.get("text") != null) {
                    texts.add(textNode(String.valueOf(map.get("text"))));
                } else if (item instanceof String text) {
                    texts.add(textNode(text));
                }
            }
        }
        return texts;
    }

    /**
     * The {@code code} text of a degraded {@code diff_view}: the file name,
     * then one hunk header per line.
     */
    private static String diffCode(Object file, Object hunks) {
        StringBuilder code = new StringBuilder();
        if (file != null) {
            code.append(file);
        }
        if (hunks instanceof List<?> list) {
            for (Object hunk : list) {
                if (hunk instanceof Map<?, ?> map && map.get("header") != null) {
                    if (code.length() > 0) {
                        code.append('\n');
                    }
                    code.append(map.get("header"));
                }
            }
        }
        return code.toString();
    }

    // ------------------------------------------------------------------
    // Level-2 -> level-1 primitive downgrade (docs/sdui.md section 6)
    // ------------------------------------------------------------------

    /**
     * Degrades one level-2-only primitive to its level-1 equivalent (the
     * {@link #DOWNGRADE_TYPES} table); a type outside the table is returned
     * unchanged. Recursion into children happens in {@link #tailor} right
     * after this call runs — this method only rewrites the node it is given,
     * never its descendants directly.
     *
     * @param node the node as authored (level-2 shape)
     * @return the node a level-1 client can render; the same instance when
     *         the type is not in the downgrade table
     */
    private UiNode downgrade(UiNode node) {
        String degraded = DOWNGRADE_TYPES.get(node.type());
        if (degraded == null) {
            return node;
        }
        Map<String, Object> props = new LinkedHashMap<>(node.props());
        List<Object> children = new ArrayList<>(node.children());
        switch (node.type()) {
            case "row" -> props.put("direction", "row");
            case "code_block" -> {
                Object code = props.remove("code");
                props.remove("language");
                props.remove("wrap");
                props.remove("copyable");
                props.remove("maxLines");
                props.put("text", code == null ? "" : String.valueOf(code));
                props.put("style", "mono");
            }
            case "tabs" -> props.put("kind", "tabs");
            case "avatar" -> {
                Object size = props.remove("size");
                props.remove("image");
                props.remove("initials");
                props.remove("icon");
                Object dimension = size == null ? DEFAULT_AVATAR_SIZE : size;
                props.put("shape", "circle");
                props.put("width", dimension);
                props.put("height", dimension);
                props.putIfAbsent("color", DEFAULT_FIGURE_COLOR);
            }
            case "chip" -> {
                Object label = props.remove("label");
                props.remove("icon");
                props.remove("avatar");
                props.remove("selected");
                props.remove("onDeleted");
                props.remove("variant");
                props.put("text", label == null ? "" : String.valueOf(label));
            }
            case "badge" -> {
                Object label = props.remove("label");
                Object count = props.remove("count");
                Object dot = props.remove("dot");
                props.remove("max");
                String text = label != null ? String.valueOf(label)
                        : count != null ? String.valueOf(count)
                        : Boolean.TRUE.equals(dot) ? "\u2022" : "";
                props.put("text", text);
            }
            case "rich_text" -> {
                Object spans = props.remove("spans");
                props.put("text", joinSpans(spans));
            }
            case "sheet" -> {
                Object title = props.remove("title");
                Object body = props.remove("body");
                Object footer = props.remove("footer");
                props.remove("height");
                props.remove("dismissible");
                addTitleAndParts(props, children, title, body, footer);
            }
            case "dialog" -> {
                Object title = props.remove("title");
                Object content = props.remove("content");
                Object actions = props.remove("actions");
                addTitleAndParts(props, children, title, content);
                if (actions instanceof List<?> actionList) {
                    children.addAll(actionList);
                }
            }
            case "list_row" -> {
                Object title = props.remove("title");
                Object subtitle = props.remove("subtitle");
                props.remove("leading");
                props.remove("trailing");
                props.remove("badge");
                props.remove("action");
                props.remove("selected");
                props.remove("onLongPress");
                props.remove("dragHandle");
                addTitleAndParts(props, children, title, subtitle);
            }
            case "shell" -> {
                Object topbar = props.remove("topbar");
                Object topbarCompact = props.remove("topbarCompact");
                Object header = props.remove("header");
                Object pageHeader = props.remove("pageHeader");
                Object sidebar = props.remove("sidebar");
                Object body = props.remove("body");
                Object detail = props.remove("detail");
                Object terminal = props.remove("terminal");
                Object rail = props.remove("rail");
                Map<String, Object> universal = universalProps(props);
                props.clear();
                props.putAll(universal);
                props.put("direction", "column");
                for (Object part : new Object[] {topbar, topbarCompact, header, pageHeader,
                        sidebar, body, detail, terminal, rail}) {
                    if (part != null) {
                        children.add(part);
                    }
                }
            }
            case "menu", "tree" -> {
                Object items = props.get("items");
                Map<String, Object> universal = universalProps(props);
                props.clear();
                props.putAll(universal);
                props.put("items", flattenLabels(items));
            }
            case "skeleton" -> {
                Object variant = props.get("variant");
                Map<String, Object> universal = universalProps(props);
                props.clear();
                props.putAll(universal);
                props.put("kind", "circle".equals(variant) ? "circular" : "linear");
            }
            default -> {
                // type-only downgrade, no prop translation needed
            }
        }
        return new UiNode(degraded, props, children);
    }

    /** The subset of {@code props} that is universal and must survive a rewrite. */
    private static Map<String, Object> universalProps(Map<String, Object> props) {
        Map<String, Object> kept = new LinkedHashMap<>();
        for (String key : UNIVERSAL_PROP_KEYS) {
            if (props.containsKey(key)) {
                kept.put(key, props.get(key));
            }
        }
        return kept;
    }

    /**
     * Folds a string-or-node {@code title} plus any number of further
     * string-or-node parts into the degraded node: a plain-string title
     * becomes the {@code title} prop (the degrade targets — {@code card} —
     * all accept a string title), a node title is pushed to the front of
     * {@code children} instead; every further non-null part is appended to
     * {@code children}, coerced to a {@code text} node when it is a plain
     * string.
     */
    private static void addTitleAndParts(Map<String, Object> props, List<Object> children,
                                          Object title, Object... parts) {
        if (title instanceof UiNode titleNode) {
            children.add(titleNode);
        } else if (title != null) {
            props.put("title", String.valueOf(title));
        }
        for (Object part : parts) {
            if (part == null) {
                continue;
            }
            children.add(part instanceof UiNode partNode ? partNode : textNode(String.valueOf(part)));
        }
    }

    private static UiNode textNode(String text) {
        return new UiNode("text", Map.of("text", text), List.of());
    }

    /** Concatenates every {@code rich_text} span's {@code text} in order. */
    private static String joinSpans(Object spansValue) {
        StringBuilder joined = new StringBuilder();
        if (spansValue instanceof List<?> spans) {
            for (Object span : spans) {
                Object text = null;
                if (span instanceof Map<?, ?> map) {
                    text = map.get("text");
                } else if (span instanceof UiNode node) {
                    text = node.props().get("text");
                }
                if (text != null) {
                    joined.append(text);
                }
            }
        }
        return joined.toString();
    }

    /** Flattens a {@code menu}/{@code tree} item array into its labels (lossy, visible). */
    private static List<Object> flattenLabels(Object items) {
        List<Object> labels = new ArrayList<>();
        if (items instanceof List<?> list) {
            for (Object item : list) {
                if (item instanceof Map<?, ?> map && map.get("label") != null) {
                    labels.add(String.valueOf(map.get("label")));
                } else if (item instanceof String label) {
                    labels.add(label);
                }
            }
        }
        return labels;
    }

    // ------------------------------------------------------------------
    // Capability-based stream_view degrade (unchanged from level 1)
    // ------------------------------------------------------------------

    /**
     * The {@code list} snapshot replacing a stream view: the universal props
     * survive, the items are the summaries of the session tail the topic names.
     */
    private UiNode snapshotList(UiNode streamView) {
        Map<String, Object> props = streamView.props();
        Map<String, Object> listProps = universalProps(props);
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
        long fromSeq = 0;
        int query = sessionId.indexOf('?');
        if (query >= 0) {
            fromSeq = parseFromSeq(sessionId.substring(query + 1));
            sessionId = sessionId.substring(0, query);
        }
        if (sessionId.isBlank()) {
            return List.of();
        }
        return events.list(sessionId, fromSeq);
    }

    /** The {@code fromSeq} value of a topic query string ({@code 0} default). */
    private static long parseFromSeq(String query) {
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq > 0 && "fromSeq".equals(pair.substring(0, eq))) {
                try {
                    return Long.parseLong(pair.substring(eq + 1));
                } catch (NumberFormatException e) {
                    return 0;
                }
            }
        }
        return 0;
    }
}
