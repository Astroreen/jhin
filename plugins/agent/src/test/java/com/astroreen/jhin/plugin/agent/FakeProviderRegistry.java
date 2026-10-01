/**
 * {@link com.astroreen.jhin.plugin.llm.api.ProviderRegistry} fake for agent
 * tests: {@code modelFor} hands out the scripted fake model and the CRUD
 * surface is not exercised by the agent.
 */
package com.astroreen.jhin.plugin.agent;

import com.astroreen.jhin.plugin.llm.api.ProviderConfig;
import com.astroreen.jhin.plugin.llm.api.ProviderRecord;
import com.astroreen.jhin.plugin.llm.api.ProviderRegistry;
import dev.langchain4j.model.chat.ChatModel;
import java.util.List;
import java.util.Optional;

final class FakeProviderRegistry implements ProviderRegistry {

    private final ChatModel model;

    FakeProviderRegistry(ChatModel model) {
        this.model = model;
    }

    @Override
    public ChatModel modelFor(String accountId, String providerId) {
        return model;
    }

    @Override
    public ProviderRecord create(String format, ProviderConfig cfg) {
        throw new UnsupportedOperationException();
    }

    @Override
    public ProviderRecord create(String accountId, String format, ProviderConfig cfg) {
        throw new UnsupportedOperationException();
    }

    @Override
    public List<ProviderRecord> list(String accountId) {
        return List.of();
    }

    @Override
    public Optional<ProviderRecord> get(String accountId, String id) {
        return Optional.empty();
    }

    @Override
    public boolean delete(String accountId, String id) {
        return false;
    }

    @Override
    public List<String> formats() {
        return List.of();
    }
}
