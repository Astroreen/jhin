/**
 * The 16 client directives of the SDUI contract and the capability filter that
 * degrades them at the source (D-22).
 *
 * <p>Every factory returns one directive as a JSON-ready map with its
 * {@code op} discriminator; an ordered list of them is what an action response
 * ({@code {"client":[…]}}) or a stream frame carries. Since contract level 4
 * (docs/sdui.md section 4) three ops carry an HTML fragment instead of a node
 * tree or merged props — {@code patch}, {@code setScreen} and {@code dialog}
 * — and their factories render the authored node through
 * {@link HtmlRenderer#renderFragment(UiNode)}; the other fourteen are
 * byte-identical to level 3. {@link #filter(List, ClientInfo)} drops the
 * directives the requesting client cannot honour: {@code openUrl} without the
 * {@code open_url} capability, {@code setToken} and {@code clearToken} without
 * {@code secure_storage}, {@code setServerUrl} without {@code multi_profile}.
 * The same decision ({@link #dropped}) is used when a directive is embedded
 * inline in a node prop (for example a button action): the prop is removed
 * from the node instead of being emitted and ignored by the client.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlRenderer;
import com.astroreen.jhin.sdk.http.ClientInfo;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class Directives {

    private Directives() {
    }

    /** {@code navigate}(screen): pushes a screen onto the navigation stack. */
    public static Map<String, Object> navigate(String screen) {
        return op("navigate", "screen", screen);
    }

    /** {@code back}: pops the navigation stack. */
    public static Map<String, Object> back() {
        return op("back");
    }

    /** {@code replace}(screen): replaces the current screen. */
    public static Map<String, Object> replace(String screen) {
        return op("replace", "screen", screen);
    }

    /** {@code refresh}: re-fetches the current screen. */
    public static Map<String, Object> refresh() {
        return op("refresh");
    }

    /** {@code reloadBootstrap}: drops the client cache and re-runs bootstrap. */
    public static Map<String, Object> reloadBootstrap() {
        return op("reloadBootstrap");
    }

    /** {@code setToken}(value): stores the bearer token for this profile. */
    public static Map<String, Object> setToken(String value) {
        return op("setToken", "value", value);
    }

    /** {@code clearToken}: drops the stored bearer token. */
    public static Map<String, Object> clearToken() {
        return op("clearToken");
    }

    /** {@code setServerUrl}(value): rewrites the active profile URL (D-9). */
    public static Map<String, Object> setServerUrl(String value) {
        return op("setServerUrl", "value", value);
    }

    /** {@code openProfiles}: opens the client-owned server profile surface. */
    public static Map<String, Object> openProfiles() {
        return op("openProfiles");
    }

    /** {@code toast}(text): shows a transient message. */
    public static Map<String, Object> toast(String text) {
        return toast(text, null);
    }

    /** {@code toast}(text, style): shows a transient message with a style. */
    public static Map<String, Object> toast(String text, String style) {
        Map<String, Object> toast = op("toast", "text", text);
        if (style != null) {
            toast.put("style", style);
        }
        return toast;
    }

    /**
     * {@code toast}(text, style, action, duration): the undo-notice toast
     * (T98) — the 5&nbsp;s undo pattern of the {@code toast_stack} item: the
     * notice text, the inline {@code action} the client renders as the
     * {@code Undo} button and the visible window in ms (the upstream window
     * is 5000, {@code showThreadUndoNotice.ts:104-112}). The client renders
     * an action-carrying toast through the undo-notice card look
     * ({@code SidebarThreadUndoNotice.tsx:17-26}: label + {@code Undo} +
     * close).
     *
     * @param text     the notice text (the upstream wording, e.g.
     *                 {@code "Settled 1 thread,"})
     * @param action   the inline action descriptor (the {@code undo} action)
     * @param duration the visible window in ms
     * @return the toast directive with the {@code action} and {@code
     *         duration} fields
     */
    public static Map<String, Object> toast(String text, Map<String, Object> action,
                                            Number duration) {
        Map<String, Object> toast = op("toast", "text", text);
        if (action != null) {
            toast.put("action", action);
        }
        if (duration != null) {
            toast.put("duration", duration);
        }
        return toast;
    }

    /**
     * {@code client}(ops): the inline directive composite of a decorative
     * control (docs/sdui.md section 3, the plan section 4.4 shape) — an
     * action prop whose {@code client} list the client runs entirely
     * locally, in order, with no server round-trip. This is what "buttons
     * that do nothing change contents" dispatches: {@code [setState, toast]}
     * and friends composed into one tap.
     *
     * @param ops the directive list to run client-side, in order
     * @return the composite action prop map
     */
    public static Map<String, Object> client(List<Map<String, Object>> ops) {
        Map<String, Object> composite = new LinkedHashMap<>();
        composite.put("client", List.copyOf(ops));
        return composite;
    }

    /**
     * {@code dialog}(html): opens a dialog rendering the given HTML fragment
     * (contract level 4: the fragment is the
     * {@link HtmlRenderer#renderFragment(UiNode)} of the authored dialog
     * node, never a node map).
     */
    public static Map<String, Object> dialog(String html) {
        return op("dialog", "html", html);
    }

    /**
     * {@code dialog}(html, kind): opens a dialog; {@code kind: "sheet"} opens
     * a bottom sheet (docs/sdui.md section 4).
     */
    public static Map<String, Object> dialog(String html, String kind) {
        Map<String, Object> dialog = dialog(html);
        if (kind != null) {
            dialog.put("kind", kind);
        }
        return dialog;
    }

    /** {@code dialog}(content): opens a dialog rendering the node's HTML fragment. */
    public static Map<String, Object> dialog(UiNode content) {
        return dialog(HtmlRenderer.renderFragment(content));
    }

    /** {@code dialog}(content, kind): the node fragment in a {@code kind} dialog. */
    public static Map<String, Object> dialog(UiNode content, String kind) {
        return dialog(HtmlRenderer.renderFragment(content), kind);
    }

    /** {@code dismissDialog}: closes the open dialog. */
    public static Map<String, Object> dismissDialog() {
        return op("dismissDialog");
    }

    /** {@code setState}(id, value): sets one local UiState field. */
    public static Map<String, Object> setState(String id, Object value) {
        Map<String, Object> setState = op("setState", "id", id);
        setState.put("value", value);
        return setState;
    }

    /**
     * {@code patch}(id, html): replaces the inner HTML of the rendered
     * element with that id, in place (docs/sdui.md section 9.5).
     */
    public static Map<String, Object> patch(String id, String html) {
        Map<String, Object> patch = op("patch", "id", id);
        patch.put("html", html);
        return patch;
    }

    /** {@code patch}(id, content): the node's HTML fragment as the swap content. */
    public static Map<String, Object> patch(String id, UiNode content) {
        return patch(id, HtmlRenderer.renderFragment(content));
    }

    /** {@code setScreen}(id, html): replaces the HTML of a known screen id. */
    public static Map<String, Object> setScreen(String id, String html) {
        Map<String, Object> setScreen = op("setScreen", "id", id);
        setScreen.put("html", html);
        return setScreen;
    }

    /** {@code setScreen}(id, content): the node's HTML fragment as the new screen. */
    public static Map<String, Object> setScreen(String id, UiNode content) {
        return setScreen(id, HtmlRenderer.renderFragment(content));
    }

    /** {@code openUrl}(value): opens a URL in the client's browser surface. */
    public static Map<String, Object> openUrl(String value) {
        return op("openUrl", "value", value);
    }

    /**
     * Drops the directives the client cannot honour from an ordered list.
     * Called on every action response and every {@code client} stream frame.
     *
     * @param ops    the directive list to filter
     * @param client the parsed {@code X-Jhin-Client} header
     * @return the surviving directives, in order
     */
    public static List<Map<String, Object>> filter(List<Map<String, Object>> ops, ClientInfo client) {
        List<Map<String, Object>> kept = new ArrayList<>();
        for (Map<String, Object> directive : ops) {
            if (!dropped(directive, client)) {
                kept.add(directive);
            }
        }
        return List.copyOf(kept);
    }

    /**
     * Whether one directive must be dropped for this client. Called by
     * {@link #filter} and by the node tailoring that strips inline directives
     * from node props.
     *
     * @param directive the directive map
     * @param client    the parsed {@code X-Jhin-Client} header
     * @return {@code true} when the client cannot honour the directive
     */
    public static boolean dropped(Map<String, Object> directive, ClientInfo client) {
        Object name = directive.get("op");
        return switch (String.valueOf(name)) {
            case "openUrl" -> !client.supports("open_url");
            case "setToken", "clearToken" -> !client.supports("secure_storage");
            case "setServerUrl" -> !client.supports("multi_profile");
            default -> false;
        };
    }

    /** Builds one directive map: {@code op} first, then the named fields. */
    private static Map<String, Object> op(String name) {
        Map<String, Object> directive = new LinkedHashMap<>();
        directive.put("op", name);
        return directive;
    }

    /** Builds one directive map with a single extra field. */
    private static Map<String, Object> op(String name, String key, Object value) {
        Map<String, Object> directive = op(name);
        directive.put(key, value);
        return directive;
    }
}
