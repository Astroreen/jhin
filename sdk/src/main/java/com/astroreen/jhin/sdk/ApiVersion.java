/**
 * The contract level constants of the host.
 *
 * <p>{@link #CURRENT} is the single contract level plugins compile against:
 * read by the kernel to answer {@link KernelInfo#apiVersion()} and copied by
 * plugin authors into {@link PluginManifest#apiVersion()}. A manifest whose
 * {@code apiVersion} is not {@link #CURRENT} is rejected at load time by
 * {@link PluginManifest#validate(PluginManifest)}.
 *
 * <p>The other constants describe wire and client-state levels that travel
 * beside the plugin contract: {@link #SDUI_CONTRACT} is the server-driven-UI
 * wire contract level the server speaks (the client advertises the level it
 * can parse in {@code X-Jhin-Client: api=…}, the server replies at the
 * minimum of the two); {@link #CLIENT_SCHEMA} is the current persisted-client
 * state schema version (the client advertises its on-disk schema in
 * {@code X-Jhin-Client: schema=…}; see docs/updates.md). Neither is used for
 * manifest validation.
 */
package com.astroreen.jhin.sdk;

public final class ApiVersion {

    /**
     * The one supported plugin contract level, bumped on every breaking SDK
     * change. Compared against {@link PluginManifest#apiVersion()} by the
     * kernel when a plugin is loaded.
     */
    public static final int CURRENT = 1;

    /**
     * The server-driven-UI wire contract level the server speaks (level 3:
     * the 68-primitive catalog and the level-3 universal props of
     * docs/sdui.md section 2.5). The client advertises the level it can parse
     * ({@code X-Jhin-Client: api=…}); the server replies at the minimum of
     * the two levels and never emits fields the negotiated level does not
     * define (docs/sdui.md section 6).
     */
    public static final int SDUI_CONTRACT = 3;

    /**
     * The lowest wire level the negotiation still tailors product content
     * for: a level-2 client (the previous contract level) receives the
     * level-3 → level-2 downgrade of docs/sdui.md section 6. Below it the
     * payload keeps the level-1 compatibility shape (docs/sdui.md Appendix
     * A) instead of the {@code contract} block.
     */
    public static final int SDUI_CONTRACT_MIN = 2;

    /**
     * The current persisted-client state schema version (4). The client
     * advertises the schema its on-disk data was written at
     * ({@code X-Jhin-Client: schema=…}); the bootstrap {@code contract}
     * carries the server's {@code minSchema} expectation (docs/updates.md).
     */
    public static final int CLIENT_SCHEMA = 4;

    /**
     * The lowest persisted-client schema the server accepts: a client whose
     * declared schema is lower gets the {@code version_gate} entry
     * (docs/sdui.md section 6, docs/updates.md section 3 rule 6).
     */
    public static final int CLIENT_SCHEMA_MIN = 3;

    private ApiVersion() {}
}
