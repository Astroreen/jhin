/**
 * The five stream frame shapes of the streams contract (docs/sdui.md
 * section 5): {@code node}, {@code patch}, {@code replace}, {@code remove}
 * and {@code client}. One frame is one JSON object carrying exactly one
 * shape key, and every HTML-carrying shape carries the level-4
 * {@code {id, html}} envelope — never a node tree or merged props.
 *
 * <p><b>Shape semantics (section 5):</b>
 * <ul>
 *   <li>{@code node} — append the rendered fragment to the stream view; the
 *       envelope {@code id} is the item identity (a re-delivered id replaces
 *       that item in place) and {@code html} is the full element;</li>
 *   <li>{@code patch} — innerHTML swap of {@code #<id>}: the element, its id
 *       and its attributes survive, only its content is replaced, so
 *       {@code html} is the <em>inner</em> markup of the target;</li>
 *   <li>{@code replace} — outerHTML swap: {@code html} is the full element
 *       that replaces the target — the fallback for a change that is not
 *       expressible as inner content;</li>
 *   <li>{@code remove} — drop the item; the id stays tombstoned;</li>
 *   <li>{@code client} — the inline directive list (the
 *       {@code Directives} vocabulary).</li>
 * </ul>
 *
 * <p>The shape-key literals live here, in the frame vocabulary, so the
 * translation unit ({@link EventFrames}) and the stream transport
 * ({@link StreamRoute}) stay free of wire-key strings.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlRenderer;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class StreamFrames {

    private StreamFrames() {
    }

    /**
     * The {@code {node:{id,html}}} frame: an appended stream item.
     *
     * @param row the row node; its {@code id} prop is the item identity
     * @return the frame
     */
    static Map<String, Object> node(UiNode row) {
        Map<String, Object> item = new LinkedHashMap<>();
        Object id = row.props().get("id");
        if (id != null) {
            item.put("id", String.valueOf(id));
        }
        item.put("html", HtmlRenderer.renderFragment(row));
        return wrap("node", item);
    }

    /**
     * The {@code {patch:{id,html}}} frame: the inner-HTML swap of one
     * target element.
     *
     * @param id        the target element id
     * @param innerHtml the new inner markup of the target (section 5: a
     *                  patch replaces the content, never the element)
     * @return the frame
     */
    static Map<String, Object> patch(String id, String innerHtml) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("id", id);
        item.put("html", innerHtml == null ? "" : innerHtml);
        return wrap("patch", item);
    }

    /**
     * The {@code {replace:{id,html}}} frame: the outer-HTML swap of one
     * target element.
     *
     * @param id  the target element id
     * @param row the full replacement element
     * @return the frame
     */
    static Map<String, Object> replace(String id, UiNode row) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("id", id);
        item.put("html", HtmlRenderer.renderFragment(row));
        return wrap("replace", item);
    }

    /**
     * The {@code {remove:"id"}} frame: drops the item and tombstones its id.
     *
     * @param id the item id
     * @return the frame
     */
    static Map<String, Object> remove(String id) {
        return wrap("remove", id);
    }

    /**
     * The {@code {client:[…]}} frame: the inline directive list the client
     * runs locally (the {@link Directives} vocabulary, section 3).
     *
     * @param ops the directives, in order
     * @return the frame
     */
    static Map<String, Object> client(List<Map<String, Object>> ops) {
        return wrap("client", ops);
    }

    /** The one-key frame envelope of section 5. */
    private static Map<String, Object> wrap(String shape, Object payload) {
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put(shape, payload);
        return frame;
    }
}
