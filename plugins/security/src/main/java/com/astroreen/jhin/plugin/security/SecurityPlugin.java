/**
 * Entry point of the security plugin: migrates the schema and publishes the
 * account directory, the enrollment service and the device service to the
 * cross-plugin service registry.
 *
 * <p>Routes and filters (bearer authentication, rate-limited enrollment, TLS)
 * arrive in later tasks; this plugin already provides the whole account model
 * they build on. No passwords, no JWT, no OAuth — just accounts, single-use
 * enrollment codes and revocable device tokens stored as SHA-256 digests.
 */
package com.astroreen.jhin.plugin.security;

import com.astroreen.jhin.plugin.security.api.AccountDirectory;
import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;
import java.time.Clock;

public final class SecurityPlugin implements JhinPlugin {

    /**
     * Applies the schema migrations and publishes the account directory, the
     * enrollment service and the device service, then registers the admin CLI
     * commands.
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
        ctx.log().info("security plugin started: accounts, enrollment and devices published, cli commands registered");
    }
}
