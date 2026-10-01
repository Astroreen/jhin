/**
 * The {@code delete-provider} action: removes one stored LLM provider with
 * the semantics of {@code DELETE /providers/{id}} and refreshes the providers
 * screen afterwards. The stored api key is destroyed with the row.
 *
 * <p>Registered only while the LLM plugin is loaded and published its
 * {@code ProviderRegistry}.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.llm.api.ProviderRegistry;
import com.astroreen.jhin.sdk.http.HttpRequest;
import java.util.List;
import java.util.Map;
import java.util.Optional;

final class DeleteProviderAction {

    private final ProviderRegistry providers;

    DeleteProviderAction(ProviderRegistry providers) {
        this.providers = providers;
    }

    /**
     * Deletes the provider named by the payload.
     *
     * @param req     the request that carried the action
     * @param payload the merged payload: {@code id}
     * @return {@code [toast, refresh]} on deletion, one error toast otherwise
     */
    List<Map<String, Object>> handle(HttpRequest req, Map<String, Object> payload) {
        String id = ActionSupport.text(payload, "id");
        if (id == null) {
            return ActionSupport.error("A provider id is required.");
        }
        Optional<String> account = ActionSupport.account(req);
        try {
            boolean deleted = providers.delete(
                    account.orElse(ProviderRegistry.LOCAL_ACCOUNT), id);
            return deleted
                    ? List.of(Directives.toast("Provider deleted."), Directives.refresh())
                    : ActionSupport.error("Provider not found: " + id);
        } catch (RuntimeException e) {
            return ActionSupport.error(messageOf(e));
        }
    }

    private static String messageOf(Throwable t) {
        String message = t.getMessage();
        return (message == null || message.isBlank()) ? t.getClass().getSimpleName() : message;
    }
}
