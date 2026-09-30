/**
 * Provider registry behaviour: the create → list → get → delete lifecycle
 * with a fake factory, account scoping, the live factory discovery and the
 * typed unknown-format error whose message names the requested format and
 * lists the available ones.
 */
package com.astroreen.jhin.plugin.llm;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import com.astroreen.jhin.plugin.llm.api.ProviderConfig;
import com.astroreen.jhin.plugin.llm.api.ProviderException;
import com.astroreen.jhin.plugin.llm.api.ProviderRecord;
import com.astroreen.jhin.plugin.llm.api.ProviderRegistry;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ProviderRegistryTest {

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private FakeLlmProviderFactory fake;
    private ProviderRegistryImpl registry;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        db.migrate(Migrations.all());
        fake = new FakeLlmProviderFactory("fake");
        registry = new ProviderRegistryImpl(db, () -> List.of(fake));
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void createListGetDeleteLifecycle() {
        ProviderRecord created = registry.create("fake",
                new ProviderConfig("sk-test-key", "m1", "https://llm.example"));

        assertThat(created.id()).isNotBlank();
        assertThat(created.accountId()).isEqualTo(ProviderRegistry.LOCAL_ACCOUNT);
        assertThat(created.format()).isEqualTo("fake");
        assertThat(created.model()).isEqualTo("m1");
        assertThat(created.baseUrl()).isEqualTo("https://llm.example");
        assertThat(created.createdAt()).isPositive();

        List<ProviderRecord> listed = registry.list(ProviderRegistry.LOCAL_ACCOUNT);
        assertThat(listed).hasSize(1);
        assertThat(listed.get(0).id()).isEqualTo(created.id());

        Optional<ProviderRecord> fetched =
                registry.get(ProviderRegistry.LOCAL_ACCOUNT, created.id());
        assertThat(fetched).isPresent();
        assertThat(fetched.get()).isEqualTo(created);

        assertThat(registry.delete(ProviderRegistry.LOCAL_ACCOUNT, created.id())).isTrue();
        assertThat(registry.list(ProviderRegistry.LOCAL_ACCOUNT)).isEmpty();
        assertThat(registry.get(ProviderRegistry.LOCAL_ACCOUNT, created.id())).isEmpty();
        assertThat(registry.delete(ProviderRegistry.LOCAL_ACCOUNT, created.id())).isFalse();
    }

    @Test
    void createValidatesConfigThroughTheFactory() {
        ProviderConfig cfg = new ProviderConfig("sk-test-key", "m1", null);
        registry.create("fake", cfg);

        assertThat(fake.created()).hasSize(1);
        assertThat(fake.created().get(0)).isEqualTo(cfg);
    }

    @Test
    void unknownFormatThrowsNamedErrorListingAvailableFormats() {
        Throwable thrown = catchThrowable(() -> registry.create("anthropic",
                new ProviderConfig("sk-test-key", "m1", null)));

        assertThat(thrown).isInstanceOf(ProviderException.class);
        ProviderException e = (ProviderException) thrown;
        assertThat(e.code()).isEqualTo("unknown_format");
        assertThat(e.httpStatus()).isEqualTo(400);
        assertThat(e.getMessage()).isEqualTo("no factory for 'anthropic'; available: [fake]");
    }

    @Test
    void formatsAreSortedAndDiscoveredLive() {
        assertThat(registry.formats()).containsExactly("fake");

        FakeLlmProviderFactory second = new FakeLlmProviderFactory("anthropic");
        ProviderRegistryImpl live = new ProviderRegistryImpl(db, () -> List.of(fake, second));
        assertThat(live.formats()).containsExactly("anthropic", "fake");
    }

    @Test
    void accountsAreIsolated() {
        ProviderRecord mine = registry.create("alice", "fake",
                new ProviderConfig("sk-alice", "m1", null));
        registry.create("bob", "fake", new ProviderConfig("sk-bob", "m1", null));

        assertThat(registry.list("alice")).hasSize(1);
        assertThat(registry.list("alice").get(0).id()).isEqualTo(mine.id());
        assertThat(registry.list("bob")).hasSize(1);
        assertThat(registry.get("alice", registry.list("bob").get(0).id())).isEmpty();
        assertThat(registry.delete("alice", registry.list("bob").get(0).id())).isFalse();
    }
}