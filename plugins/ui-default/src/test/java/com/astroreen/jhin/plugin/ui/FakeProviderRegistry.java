/**
 * {@link com.astroreen.jhin.plugin.llm.api.ProviderRegistry} fake for screen
 * and action tests: an in-memory provider list with the recorded formats, no
 * model minting.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.llm.api.ProviderConfig;
import com.astroreen.jhin.plugin.llm.api.ProviderRecord;
import com.astroreen.jhin.plugin.llm.api.ProviderRegistry;
import dev.langchain4j.model.chat.ChatModel;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicLong;

final class FakeProviderRegistry implements ProviderRegistry {

    private final List<String> formats;
    private final List<ProviderRecord> records = new ArrayList<>();
    private final AtomicLong sequence = new AtomicLong();

    FakeProviderRegistry(List<String> formats) {
        this.formats = List.copyOf(formats);
    }

    @Override
    public ProviderRecord create(String format, ProviderConfig cfg) {
        return create(LOCAL_ACCOUNT, format, cfg);
    }

    @Override
    public ProviderRecord create(String accountId, String format, ProviderConfig cfg) {
        if (!formats.contains(format)) {
            throw new IllegalArgumentException("unknown format: " + format);
        }
        ProviderRecord record = new ProviderRecord(
                "p-" + sequence.incrementAndGet(), accountId, format,
                cfg.model(), cfg.baseUrl(), System.currentTimeMillis());
        records.add(record);
        return record;
    }

    @Override
    public List<ProviderRecord> list(String accountId) {
        return records.stream().filter(r -> r.accountId().equals(accountId)).toList();
    }

    @Override
    public Optional<ProviderRecord> get(String accountId, String id) {
        return list(accountId).stream().filter(r -> r.id().equals(id)).findFirst();
    }

    @Override
    public boolean delete(String accountId, String id) {
        return records.removeIf(r -> r.accountId().equals(accountId) && r.id().equals(id));
    }

    @Override
    public List<String> formats() {
        return formats;
    }

    @Override
    public ChatModel modelFor(String accountId, String providerId) {
        throw new UnsupportedOperationException("not under test");
    }
}
