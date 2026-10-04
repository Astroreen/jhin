/**
 * The {@code providers} screen: CRUD over the LLM provider registry, the
 * UI face of the {@code /providers} routes, rendered as {@code card} +
 * {@code list_row} + {@code form}.
 *
 * <p>The create form's format dropdown is populated from the registered
 * factory formats ({@code GET /providers/formats} semantics); each row shows
 * one stored provider with a delete button. The screen exists only while the
 * LLM plugin is loaded and published its {@code ProviderRegistry} — see the
 * registry in {@code com.astroreen.jhin.plugin.ui.Screens}.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.llm.api.ProviderRecord;
import com.astroreen.jhin.plugin.llm.api.ProviderRegistry;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.List;
import java.util.Map;
import java.util.Optional;

public final class ProvidersScreen {

    private ProvidersScreen() {
    }

    /**
     * Builds the providers screen of one caller.
     *
     * @param providers the provider registry to list from and write to
     * @param account   the caller's account id, empty when unscoped
     * @return the screen node
     */
    public static UiNode render(ProviderRegistry providers, Optional<String> account) {
        String accountId = account.orElse(ProviderRegistry.LOCAL_ACCOUNT);
        List<ProviderRecord> records = providers.list(accountId);
        Ui.DropdownBuilder format = Ui.dropdown("format");
        for (String name : providers.formats()) {
            format.item(name, name);
        }
        Ui.ContainerBuilder body = Ui.container()
                .direction("column")
                .gap(12)
                .padding(16)
                .child(Ui.text("Providers").style("h2").build())
                .child(Ui.card()
                        .title("Add provider")
                        .child(Ui.form()
                                .field(Ui.text("Format").style("caption").build())
                                .field(format.build())
                                .field(Ui.input("model").label("Model").required(true).build())
                                .field(Ui.input("apiKey").label("API key").obscure(true).build())
                                .field(Ui.input("baseUrl").label("Base URL")
                                        .placeholder("Provider default").build())
                                .submit("Add provider", ActionDescriptors.of("create-provider", null,
                                        List.of("format", "model", "apiKey", "baseUrl")))
                                .build())
                        .build());
        if (records.isEmpty()) {
            body.child(Ui.card()
                    .title("Configured")
                    .child(Ui.text("No providers configured.").style("caption").build())
                    .build());
        } else {
            Ui.ContainerBuilder rows = Ui.container().direction("column").gap(8);
            for (ProviderRecord record : records) {
                rows.child(Ui.listRow()
                        .title(record.format() + " — " + record.model())
                        .subtitle("id: " + record.id())
                        .trailing(Ui.button("Delete")
                                .style("danger")
                                .confirm("Delete this provider?")
                                .action(ActionDescriptors.of(
                                        "delete-provider", Map.of("id", record.id()), List.of()))
                                .build())
                        .build());
            }
            body.child(Ui.card()
                    .title("Configured")
                    .child(rows.build())
                    .build());
        }
        return Ui.screen().title("Providers").body(body.build()).build();
    }
}