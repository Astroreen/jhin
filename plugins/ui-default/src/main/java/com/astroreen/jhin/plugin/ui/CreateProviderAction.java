/**
 * The {@code create-provider} action: stores one LLM provider for the caller
 * with the semantics of {@code POST /providers} and refreshes the providers
 * screen afterwards. The format must match a registered factory; the api key
 * travels to the registry and never comes back.
 *
 * <p>Registered only while the LLM plugin is loaded and published its
 * {@code ProviderRegistry}.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.llm.api.ProviderConfig;
import com.astroreen.jhin.plugin.llm.api.ProviderRegistry;
import com.astroreen.jhin.sdk.http.HttpRequest;
import java.util.List;
import java.util.Map;
import java.util.Optional;

final class CreateProviderAction {

    private final ProviderRegistry providers;

    CreateProviderAction(ProviderRegistry providers) {
        this.providers = providers;
    }

    /**
     * Creates the provider named by the payload.
     *
     * @param req     the request that carried the action
     * @param payload the merged payload: {@code format}, {@code model},
     *                optional {@code apiKey} and {@code baseUrl}
     * @return {@code [toast, refresh]} on success, one error toast otherwise
     */
    List<Map<String, Object>> handle(HttpRequest req, Map<String, Object> payload) {
        String format = ActionSupport.text(payload, "format");
        String model = ActionSupport.text(payload, "model");
        if (format == null || model == null) {
            return ActionSupport.error("A format and a model are required.");
        }
        String apiKey = ActionSupport.text(payload, "apiKey");
        String baseUrl = ActionSupport.text(payload, "baseUrl");
        Optional<String> account = ActionSupport.account(req);
        try {
            providers.create(account.orElse(ProviderRegistry.LOCAL_ACCOUNT), format,
                    new ProviderConfig(apiKey, model, baseUrl));
            return List.of(Directives.toast("Provider created."), Directives.refresh());
        } catch (RuntimeException e) {
            return ActionSupport.error(messageOf(e));
        }
    }

    private static String messageOf(Throwable t) {
        String message = t.getMessage();
        return (message == null || message.isBlank()) ? t.getClass().getSimpleName() : message;
    }
}
