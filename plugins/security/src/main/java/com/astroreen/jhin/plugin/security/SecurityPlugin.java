/**
 * Entry point of the security plugin: migrates the schema and publishes the
 * account directory, the enrollment service and the device service to the
 * cross-plugin service registry, then contributes the HTTP surface — bearer
 * authentication, the rate-limited enrollment route and the generated TLS
 * material — plus the admin CLI commands.
 *
 * <p>HTTP contributions (all registered before the listener starts):
 * filter {@code jhin.security.enroll-rate} on {@code /enroll} (order 50),
 * route {@code POST /enroll}, filter {@code jhin.security.bearer} on every
 * path (order 100) and the {@link TlsProvider} that switches the server to
 * HTTPS. No passwords, no JWT, no OAuth — just accounts, single-use
 * enrollment codes and revocable device tokens stored as SHA-256 digests.
 */
package com.astroreen.jhin.plugin.security;

import com.astroreen.jhin.plugin.security.api.AccountDirectory;
import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.http.FilterSpec;
import com.astroreen.jhin.sdk.http.RouteSpec;
import java.time.Clock;

public final class SecurityPlugin implements JhinPlugin {

    /**
     * Applies the schema migrations and publishes the account directory, the
     * enrollment service and the device service, then registers the admin CLI
     * commands and the HTTP contributions: the enrollment rate limit, the
     * enrollment route, bearer authentication and the generated TLS material.
     *
     * @param ctx this plugin's context, valid for the whole plugin lifetime
     */
    @Override
    public void start(PluginContext ctx) {
        ctx.db().migrate(Migrations.all());
        Clock clock = Clock.systemUTC();
        AccountServiceImpl accounts = new AccountServiceImpl(ctx.db(), clock);
        EnrollmentServiceImpl enrollment = new EnrollmentServiceImpl(ctx.db(), clock);
        DeviceServiceImpl devices = new DeviceServiceImpl(ctx.db(), clock);
        ctx.services().publish(AccountDirectory.class, accounts);
        ctx.services().publish(EnrollmentServiceImpl.class, enrollment);
        ctx.services().publish(DeviceServiceImpl.class, devices);
        new SecurityCli(accounts, enrollment, devices).register(ctx.cli());
        ctx.http().filter(new FilterSpec(RateLimitFilter.ID, "/enroll",
                RateLimitFilter.ORDER, new RateLimitFilter(clock)));
        ctx.http().route(new RouteSpec("POST", EnrollRoute.PATH,
                new EnrollRoute(enrollment)::handle));
        ctx.http().filter(new FilterSpec(BearerFilter.ID, "/",
                BearerFilter.ORDER, new BearerFilter(devices, clock)));
        ctx.http().tls(new TlsKeyStoreGenerator(ctx.kernel().home()).loadOrCreate());
        ctx.log().info("security plugin started: accounts, enrollment and devices published,"
                + " cli commands, bearer filter, enroll route and tls registered");
    }
}
