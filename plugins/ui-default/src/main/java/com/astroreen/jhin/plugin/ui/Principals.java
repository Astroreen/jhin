/**
 * Account extraction from the request principal a security filter leaves on
 * the request.
 *
 * <p>The UI plugin does not depend on the security plugin, so the principal
 * arrives as an opaque {@link Object} under the well-known attribute key and
 * its account id is read defensively: a {@link String} principal is already
 * the account id, anything else must expose a public {@code accountId()}
 * accessor (invoked reflectively across plugin class-loaders). When the
 * attribute is absent there is no security plugin and every store call is
 * unscoped (the implicit account {@code local}). When the attribute is present
 * but unusable the request fails instead of silently falling back to unscoped
 * access.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.http.HttpRequest;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.Optional;

final class Principals {

    /** Attribute key under which a security filter stores the principal. */
    static final String PRINCIPAL_ATTRIBUTE = "jhin.security.principal";

    private Principals() {
    }

    /**
     * Resolves the account id the request is scoped to. Called by the route
     * handlers before every store call.
     *
     * @param req the current request
     * @return the account id, or empty when no principal is present (unscoped)
     * @throws PluginException when the principal is present but carries no
     *                         usable account id
     */
    static Optional<String> accountId(HttpRequest req) {
        Optional<Object> principal = req.attribute(PRINCIPAL_ATTRIBUTE);
        if (principal.isEmpty()) {
            return Optional.empty();
        }
        return Optional.of(extract(principal.get()));
    }

    /**
     * Whether the request carries a principal with a usable account id. Called
     * by the bootstrap route to pick the entry screen; an unusable principal
     * counts as unauthenticated there instead of failing the whole payload.
     *
     * @param req the current request
     * @return {@code true} when a usable principal is present
     */
    static boolean present(HttpRequest req) {
        try {
            return accountId(req).isPresent();
        } catch (PluginException e) {
            return false;
        }
    }

    private static String extract(Object principal) {
        Object value = (principal instanceof String) ? principal : invokeAccountId(principal);
        if (value == null) {
            throw new PluginException("principal carries no account id");
        }
        String accountId = String.valueOf(value);
        if (accountId.isBlank()) {
            throw new PluginException("principal carries a blank account id");
        }
        return accountId;
    }

    private static Object invokeAccountId(Object principal) {
        try {
            Method accessor = principal.getClass().getMethod("accountId");
            return accessor.invoke(principal);
        } catch (NoSuchMethodException | IllegalAccessException e) {
            throw new PluginException("principal does not expose a public accountId() accessor", e);
        } catch (InvocationTargetException e) {
            throw new PluginException("principal accountId() accessor failed", e.getCause());
        }
    }
}
