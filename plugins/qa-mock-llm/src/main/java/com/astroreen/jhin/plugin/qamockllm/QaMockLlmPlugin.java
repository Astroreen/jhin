/**
 * Entry point of the qa-mock-llm harness plugin: publishes the scripted mock
 * {@link com.astroreen.jhin.plugin.llm.api.LlmProviderFactory} (format
 * {@code mock}) to the cross-plugin service registry and nothing else.
 *
 * <p>The factory is published under its format as the service qualifier, the
 * T31 pattern: several implementations of one type must coexist, and a
 * duplicate {@code (type, qualifier)} publication is refused by the registry.
 * The provider registry of {@code jhin.llm} discovers the instance live
 * through {@code services().findAll(LlmProviderFactory.class)}, so
 * {@code POST /providers} with {@code "format":"mock"} resolves while this jar
 * is installed.
 *
 * <p>This whole jar is a QA harness and never ships in the release bundle:
 * it exists so an end-to-end run can observe {@code tool_use} /
 * {@code tool_result} and a file appearing in the session workdir without any
 * network endpoint. Keep {@code JHIN_LLM_BUILTIN_QA} unset when installing it,
 * or the echo mock of {@code jhin.llm-builtin} collides on the same
 * {@code mock} qualifier.
 */
package com.astroreen.jhin.plugin.qamockllm;

import com.astroreen.jhin.plugin.llm.api.LlmProviderFactory;
import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;

public final class QaMockLlmPlugin implements JhinPlugin {

    /**
     * Publishes the scripted mock provider factory to the cross-plugin
     * service registry under {@code mock} as the service qualifier.
     *
     * @param ctx this plugin's context, valid for the whole plugin lifetime
     */
    @Override
    public void start(PluginContext ctx) {
        ctx.services().publish(LlmProviderFactory.class,
                QaMockFactory.FORMAT, new QaMockFactory(ctx.log()));
        ctx.log().warn("qa-mock-llm is a QA harness (format mock);"
                + " never ship this jar in a release bundle");
    }
}
