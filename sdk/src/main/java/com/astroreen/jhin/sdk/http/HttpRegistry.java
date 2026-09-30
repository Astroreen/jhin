/**
 * Plugin-facing HTTP extension point: routes, filters and TLS.
 *
 * <p>Obtained from {@link com.astroreen.jhin.sdk.PluginContext#http()} and
 * called during {@link com.astroreen.jhin.sdk.JhinPlugin#start}, before the
 * HTTP server starts; nothing may be registered after the server is listening.
 * The kernel tags every registration with the owning plugin id and runs
 * registered filters in ascending {@link FilterSpec#order()}, ties broken by
 * plugin id (see {@link FilterSpec}).
 */
package com.astroreen.jhin.sdk.http;

public interface HttpRegistry {

    /**
     * Registers an HTTP route. Called by a plugin during
     * {@link com.astroreen.jhin.sdk.JhinPlugin#start} for every endpoint it
     * serves; the kernel matches incoming requests against the route table
     * built from these registrations and dispatches to the spec's handler.
     *
     * @param spec the route to register
     */
    void route(RouteSpec spec);

    /**
     * Registers a request filter. Called by a plugin during
     * {@link com.astroreen.jhin.sdk.JhinPlugin#start}; the kernel runs the
     * registered filters around every request whose path matches the filter's
     * {@link FilterSpec#pathPrefix()}, in ascending {@link FilterSpec#order()}
     * with ties broken by plugin id.
     *
     * @param spec the filter to register
     */
    void filter(FilterSpec spec);

    /**
     * Supplies TLS material for the HTTPS listener. First-wins: ignored if
     * another plugin already supplied TLS. Called by a plugin (typically a
     * security plugin) during {@link com.astroreen.jhin.sdk.JhinPlugin#start};
     * the kernel reads the accepted provider once at server startup and
     * configures HTTPS from it.
     *
     * @param provider the TLS material to use
     */
    void tls(TlsProvider provider);
}
