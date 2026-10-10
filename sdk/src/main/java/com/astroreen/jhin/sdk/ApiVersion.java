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
 * can parse in {@code X-Jhin-Client: api=…}; a client below
 * {@link #SDUI_CONTRACT_MIN} is refused with {@code 426 Upgrade Required}
 * instead of a tailored payload); {@link #CLIENT_SCHEMA} is the current
 * persisted-client state schema version (the client advertises its on-disk
 * schema in {@code X-Jhin-Client: schema=…}; see docs/updates.md). Neither is
 * used for manifest validation.
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
     * The server-driven-UI wire contract level the server speaks (level 4:
     * the HTML wire — the server renders the node tree to semantic HTML and
     * every UI-bearing payload carries {@code html} instead of a node tree,
     * docs/sdui.md section 1 and section 9). The client advertises the level
     * it can parse ({@code X-Jhin-Client: api=…}).
     */
    public static final int SDUI_CONTRACT = 4;

    /**
     * The lowest wire level the server still speaks. It equals
     * {@link #SDUI_CONTRACT}: level 4 is a big-bang cutover with no
     * compatibility path, so a client declaring a lower level (or sending no
     * {@code X-Jhin-Client} header at all) receives
     * {@code 426 Upgrade Required} with the {@code contract_upgrade} body
     * instead of a downgraded payload (docs/sdui.md section 6).
     */
    public static final int SDUI_CONTRACT_MIN = 4;

    /**
     * The current persisted-client state schema version (5, the web
     * runtime's local store). The client advertises the schema its stored
     * data was written at ({@code X-Jhin-Client: schema=…}); the bootstrap
     * {@code contract} carries the server's {@code minSchema} expectation
     * (docs/updates.md).
     */
    public static final int CLIENT_SCHEMA = 5;

    /**
     * The lowest persisted-client schema the server accepts: a client whose
     * declared schema is lower gets the {@code version_gate} entry
     * (docs/sdui.md section 6, docs/updates.md section 3 rule 6).
     */
    public static final int CLIENT_SCHEMA_MIN = 5;

    private ApiVersion() {}
}
