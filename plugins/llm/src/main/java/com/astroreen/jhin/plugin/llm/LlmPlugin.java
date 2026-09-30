/**
 * Entry point of the llm plugin: migrates the provider schema, publishes the
 * {@link ProviderRegistry} to the cross-plugin service registry and registers
 * the provider CRUD routes.
 *
 * <p>This plugin owns the LangChain4j runtime: the manifest exports the
 * factory SPI package together with the LangChain4j packages
 * {@code dev.langchain4j.model.chat} and {@code dev.langchain4j.data.message},
 * which is the plugin-to-plugin class sharing mechanism — a plugin that
 * {@code requires jhin.llm} (for example {@code jhin.llm-builtin}) resolves
 * {@link com.astroreen.jhin.plugin.llm.api.LlmProviderFactory} and the
 * LangChain4j types from this plugin's class loader and publishes its factory
 * implementations through {@code services().publish}; the registry discovers
 * them live at call time.
 *
 * <p>Routes: {@code GET/POST /providers}, {@code GET/DELETE /providers/{id}}
 * and {@code GET /providers/formats} (see {@link ProviderRoutes}).
 */
package com.astroreen.jhin.plugin.llm;

import com.astroreen.jhin.plugin.llm.api.LlmProviderFactory;
import com.astroreen.jhin.plugin.llm.api.ProviderRegistry;
import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.http.RouteSpec;

public final class LlmPlugin implements JhinPlugin {

    /**
     * Applies the schema migrations, publishes the provider registry and
     * registers the provider routes.
     *
     * @param ctx this plugin's context, valid for the whole plugin lifetime
     */
    @Override
    public void start(PluginContext ctx) {
        ctx.db().migrate(Migrations.all());
        ProviderRegistry registry = new ProviderRegistryImpl(
                ctx.db(), () -> ctx.services().findAll(LlmProviderFactory.class));
        ctx.services().publish(ProviderRegistry.class, registry);
        ProviderRoutes routes = new ProviderRoutes(registry);
        ctx.http().route(new RouteSpec("GET", "/providers", routes::list));
        ctx.http().route(new RouteSpec("POST", "/providers", routes::create));
        ctx.http().route(new RouteSpec("GET", "/providers/formats", routes::formats));
        ctx.http().route(new RouteSpec("GET", "/providers/{id}", routes::get));
        ctx.http().route(new RouteSpec("DELETE", "/providers/{id}", routes::delete));
        ctx.log().info("llm plugin started: provider registry and routes published");
    }
}
