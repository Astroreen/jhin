/**
 * Entry point of the llm-builtin plugin: publishes the three built-in
 * {@link LlmProviderFactory} implementations (formats {@code anthropic},
 * {@code openai} and {@code gemini}) to the cross-plugin service registry and
 * nothing else.
 *
 * <p>Each factory is published under its format as the service qualifier:
 * several implementations of one type must coexist, and a duplicate
 * {@code (type, qualifier)} publication is refused by the registry. The
 * provider registry of {@code jhin.llm} discovers the instances live through
 * {@code services().findAll(LlmProviderFactory.class)}, so
 * {@code GET /providers/formats} lists the three formats while this jar is
 * installed.
 *
 * <p>This whole jar is removable: delete it and restart (the kernel deletion
 * memory keeps it gone) and {@code GET /providers/formats} returns
 * {@code []} — no built-in factory remains, only those other plugin jars
 * publish.
 *
 * <p>QA helper: when the {@code qa} configuration flag is on (environment
 * variable {@code JHIN_LLM_BUILTIN_QA}, strictly {@code true}/{@code false})
 * a fourth factory — the deterministic {@code mock} format of
 * {@link MockFactory} — is published so a QA run can exercise the whole
 * message flow without a network endpoint. Off by default.
 */
package com.astroreen.jhin.plugin.llm.builtin;

import com.astroreen.jhin.plugin.llm.api.LlmProviderFactory;
import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;

public final class LlmBuiltinPlugin implements JhinPlugin {

    /**
     * Publishes the three built-in provider factories to the cross-plugin
     * service registry, each under its format as the service qualifier, plus
     * the {@code mock} factory while the {@code qa} flag is on.
     *
     * @param ctx this plugin's context, valid for the whole plugin lifetime
     */
    @Override
    public void start(PluginContext ctx) {
        ctx.services().publish(LlmProviderFactory.class,
                AnthropicFactory.FORMAT, new AnthropicFactory());
        ctx.services().publish(LlmProviderFactory.class,
                OpenAiFactory.FORMAT, new OpenAiFactory());
        ctx.services().publish(LlmProviderFactory.class,
                GeminiFactory.FORMAT, new GeminiFactory());
        if (ctx.config().getBool("qa", false)) {
            ctx.services().publish(LlmProviderFactory.class,
                    MockFactory.FORMAT, new MockFactory());
            ctx.log().warn("QA helper enabled (JHIN_LLM_BUILTIN_QA):"
                    + " the mock provider factory is registered");
        }
    }
}
