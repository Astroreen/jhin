package com.astroreen.jhin.core.llm;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.core.accounts.AccountService;
import com.astroreen.jhin.core.db.DatabaseConfig;
import com.astroreen.jhin.core.db.MigrationRunner;
import com.astroreen.jhin.core.db.WriteQueue;
import com.astroreen.jhin.core.llm.ProviderRegistry.ProviderRecord;
import dev.langchain4j.model.chat.ChatModel;
import java.lang.reflect.Field;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;

class ProviderRegistryTest {

    @TempDir
    Path jhinHome;

    private WriteQueue writeQueue;
    private AccountService accounts;
    private ProviderRegistry registry;
    private String accountId;

    @BeforeEach
    void setUp() throws Exception {
        DataSource dataSource = DatabaseConfig.createDataSource(jhinHome);
        new MigrationRunner(dataSource).migrate();
        writeQueue = new WriteQueue();
        JdbcClient jdbcClient = JdbcClient.create(dataSource);
        accounts = new AccountService(jdbcClient, writeQueue);
        BuiltinFactories builtins = new BuiltinFactories();
        registry = new ProviderRegistry(
                jdbcClient,
                writeQueue,
                List.of(
                        builtins.anthropicLlmProviderFactory(),
                        builtins.openaiLlmProviderFactory(),
                        builtins.geminiLlmProviderFactory()));
        accountId = accounts.createAccount("alice");
    }

    @AfterEach
    void tearDown() {
        writeQueue.close();
    }

    @Test
    void createListFindRoundtrip() {
        ProviderRecord created = registry
                .create(
                        accountId,
                        "work",
                        "openai",
                        "sk-test-secret-value",
                        "gpt-x",
                        "https://api.example.com/v1",
                        false)
                .join();

        assertThat(created.id()).matches("[0-9a-f-]{36}");
        assertThat(created.accountId()).isEqualTo(accountId);
        assertThat(created.name()).isEqualTo("work");
        assertThat(created.format()).isEqualTo("openai");
        assertThat(created.model()).isEqualTo("gpt-x");
        assertThat(created.baseUrl()).isEqualTo("https://api.example.com/v1");
        assertThat(created.isDefault()).isFalse();

        List<String> fields = Arrays.stream(ProviderRecord.class.getDeclaredFields())
                .map(Field::getName)
                .toList();
        assertThat(fields).doesNotContain("apiKey");

        assertThat(registry.list(accountId)).containsExactly(created);
        assertThat(registry.find(accountId, created.id())).contains(created);
    }

    @Test
    void unknownFormatIsRejected() {
        assertThatThrownBy(() -> registry.create(
                        accountId, "work", "bogus", "sk-test-secret-value", "m", null, false))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("unknown format");
    }

    @Test
    void blankFieldsAreRejected() {
        assertThatThrownBy(() -> registry.create(
                        accountId, "work", "openai", " ", "m", null, false))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> registry.create(
                        accountId, " ", "openai", "sk-test-secret-value", "m", null, false))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> registry.create(
                        accountId, "work", "openai", "sk-test-secret-value", " ", null, false))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> registry.create(
                        accountId, "work", " ", "sk-test-secret-value", "m", null, false))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> registry.create(
                        accountId, null, "openai", "sk-test-secret-value", "m", null, false))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void defaultIsUniquePerAccount() {
        ProviderRecord first = registry
                .create(accountId, "first", "openai", "sk-test-secret-value", "m1", null, true)
                .join();

        assertThat(registry.defaultOf(accountId)).contains(first);

        ProviderRecord second = registry
                .create(accountId, "second", "anthropic", "sk-test-secret-value", "m2", null, true)
                .join();

        assertThat(registry.defaultOf(accountId)).contains(second);
        assertThat(registry.find(accountId, first.id())).hasValueSatisfying(previous -> assertThat(previous.isDefault())
                .isFalse());
        assertThat(registry.find(accountId, second.id())).hasValueSatisfying(current -> assertThat(current.isDefault())
                .isTrue());
        assertThat(registry.list(accountId))
                .filteredOn(ProviderRecord::isDefault)
                .hasSize(1);
    }

    @Test
    void accountsAreIsolated() {
        String otherAccountId = accounts.createAccount("bob");
        ProviderRecord other = registry
                .create(otherAccountId, "bobs", "openai", "sk-test-secret-value", "m", null, false)
                .join();

        assertThat(registry.find(accountId, other.id())).isEmpty();
        assertThat(registry.delete(accountId, other.id())).isFalse();
        assertThat(registry.list(accountId)).isEmpty();
        assertThat(registry.list(otherAccountId)).hasSize(1);
    }

    @Test
    void buildChatModelForOpenaiAndAnthropic() {
        ProviderRecord openai = registry
                .create(accountId, "work", "openai", "sk-test-secret-value", "gpt-x", null, false)
                .join();
        ProviderRecord anthropic = registry
                .create(accountId, "home", "anthropic", "sk-test-secret-value", "claude-x", null, false)
                .join();

        assertThat(registry.buildChatModel(openai)).isNotNull();
        assertThat(registry.buildChatModel(anthropic)).isNotNull();
    }

    @Test
    void registerSeamAddsCustomFormatFirstWins() {
        ChatModel firstModel = new ChatModel() {};
        ChatModel duplicateModel = new ChatModel() {};
        registry.register(mockFactory("mock", firstModel));
        registry.register(mockFactory("mock", duplicateModel));

        assertThat(registry.knownFormats()).contains("mock");

        ProviderRecord created = registry
                .create(accountId, "plugin", "mock", "sk-test-secret-value", "m", null, false)
                .join();
        assertThat(registry.buildChatModel(created)).isSameAs(firstModel);
    }

    @Test
    void knownFormatsCoverBuiltins() {
        Set<String> formats = registry.knownFormats();
        assertThat(formats).containsExactlyInAnyOrder("anthropic", "openai", "gemini");
    }

    private static LlmProviderFactory mockFactory(String format, ChatModel model) {
        return new LlmProviderFactory() {
            @Override
            public String format() {
                return format;
            }

            @Override
            public ChatModel create(ProviderConfig cfg) {
                return model;
            }
        };
    }
}
