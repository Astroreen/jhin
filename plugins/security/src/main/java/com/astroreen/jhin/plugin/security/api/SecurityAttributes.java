/**
 * The well-known request attribute keys of the security plugin.
 *
 * <p>Other plugins read these keys from the HTTP request to learn who is
 * calling; they never depend on this plugin's classes directly.
 */
package com.astroreen.jhin.plugin.security.api;

public final class SecurityAttributes {

    /**
     * Request attribute key under which a security filter stores the caller's
     * {@link Principal} after a successful bearer-token check.
     *
     * <p>Cross-plugin contract: consumers treat the attribute value as opaque.
     * A {@link String} value is already the account id; any other value must
     * expose a public {@code accountId()} accessor (invoked reflectively across
     * plugin class loaders). {@link Principal} satisfies that contract. When
     * the attribute is absent the request is unscoped (no security plugin).
     */
    public static final String PRINCIPAL = "jhin.security.principal";

    private SecurityAttributes() {
    }
}
