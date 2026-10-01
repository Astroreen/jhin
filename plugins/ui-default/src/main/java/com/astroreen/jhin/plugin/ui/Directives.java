/**
 * The 16 client directives of the SDUI contract and the capability filter that
 * degrades them at the source (D-22).
 *
 * <p>Every factory returns one directive as a JSON-ready map with its
 * {@code op} discriminator; an ordered list of them is what an action response
 * ({@code {"client":[…]}}) or a stream frame carries. {@link #filter(List,
 * ClientInfo)} drops the directives the requesting client cannot honour:
 * {@code openUrl} without the {@code open_url} capability, {@code setToken} and
 * {@code clearToken} without {@code secure_storage}, {@code setServerUrl}
 * without {@code multi_profile}. The same decision ({@link #dropped}) is used
 * when a directive is embedded inline in a node prop (for example a button
 * action): the prop is removed from the node instead of being emitted and
 * ignored by the client.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.sdk.http.ClientInfo;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class Directives {

    private Directives() {
    }

    /** {@code navigate}(screen): pushes a screen onto the navigation stack. */
    static Map<String, Object> navigate(String screen) {
        return op("navigate", "screen", screen);
    }

    /** {@code back}: pops the navigation stack. */
    static Map<String, Object> back() {
        return op("back");
    }

    /** {@code replace}(screen): replaces the current screen. */
    static Map<String, Object> replace(String screen) {
        return op("replace", "screen", screen);
    }

    /** {@code refresh}: re-fetches the current screen. */
    static Map<String, Object> refresh() {
        return op("refresh");
    }

    /** {@code reloadBootstrap}: drops the client cache and re-runs bootstrap. */
    static Map<String, Object> reloadBootstrap() {
        return op("reloadBootstrap");
    }

    /** {@code setToken}(value): stores the bearer token for this profile. */
    static Map<String, Object> setToken(String value) {
        return op("setToken", "value", value);
    }

    /** {@code clearToken}: drops the stored bearer token. */
    static Map<String, Object> clearToken() {
        return op("clearToken");
    }

    /** {@code setServerUrl}(value): rewrites the active profile URL (D-9). */
    static Map<String, Object> setServerUrl(String value) {
        return op("setServerUrl", "value", value);
    }

    /** {@code openProfiles}: opens the client-owned server profile surface. */
    static Map<String, Object> openProfiles() {
        return op("openProfiles");
    }

    /** {@code toast}(text): shows a transient message. */
    static Map<String, Object> toast(String text) {
        return toast(text, null);
    }

    /** {@code toast}(text, style): shows a transient message with a style. */
    static Map<String, Object> toast(String text, String style) {
        Map<String, Object> toast = op("toast", "text", text);
        if (style != null) {
            toast.put("style", style);
        }
        return toast;
    }

    /** {@code dialog}(node): opens a dialog rendering the given node. */
    static Map<String, Object> dialog(Map<String, Object> node) {
        return op("dialog", "node", node);
    }

    /** {@code dismissDialog}: closes the open dialog. */
    static Map<String, Object> dismissDialog() {
        return op("dismissDialog");
    }

    /** {@code setState}(id, value): sets one local UiState field. */
    static Map<String, Object> setState(String id, Object value) {
        Map<String, Object> setState = op("setState", "id", id);
        setState.put("value", value);
        return setState;
    }

    /** {@code patch}(id, props): updates props of one rendered node in place. */
    static Map<String, Object> patch(String id, Map<String, Object> props) {
        Map<String, Object> patch = op("patch", "id", id);
        patch.put("props", props);
        return patch;
    }

    /** {@code setScreen}(id, node): replaces the node of a known screen id. */
    static Map<String, Object> setScreen(String id, Map<String, Object> node) {
        Map<String, Object> setScreen = op("setScreen", "id", id);
        setScreen.put("node", node);
        return setScreen;
    }

    /** {@code openUrl}(value): opens a URL in the client's browser surface. */
    static Map<String, Object> openUrl(String value) {
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
    static List<Map<String, Object>> filter(List<Map<String, Object>> ops, ClientInfo client) {
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
    static boolean dropped(Map<String, Object> directive, ClientInfo client) {
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
