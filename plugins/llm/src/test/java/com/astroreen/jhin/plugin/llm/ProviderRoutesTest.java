/**
 * CRUD route behaviour: create validation (the offending field is named),
 * the metadata-only response contract (the serialized field set equals the
 * {@link ProviderRecord} field set exactly and never contains the api key),
 * the {@code 404 not_found} lifecycle, the live {@code /providers/formats}
 * listing and account scoping through the request principal (string
 * principal, {@code accountId()} accessor principal and absent principal).
 */
package com.astroreen.jhin.plugin.llm;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.llm.api.ProviderRecord;
import com.astroreen.jhin.plugin.llm.api.ProviderRegistry;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.lang.reflect.RecordComponent;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ProviderRoutesTest {

    /** Principal exposing an account id through a public accessor. */
    record AccountPrincipal(String accountId) {}

    private static final String SECRET = "sk-super-secret-9f8e7d";

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private FakeLlmProviderFactory fake;
    private ProviderRoutes routes;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        db.migrate(Migrations.all());
        fake = new FakeLlmProviderFactory("fake");
        ProviderRegistry registry = new ProviderRegistryImpl(db, () -> List.of(fake));
        routes = new ProviderRoutes(registry);
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void postReturnsMetadataOnlyWithTheDocumentedFieldSet() {
        HttpResponse response = routes.create(request("POST", "/providers", null,
                "{\"format\":\"fake\",\"apiKey\":\"" + SECRET + "\",\"model\":\"m1\","
                        + "\"baseUrl\":\"https://llm.example\"}"));

        assertThat(response.status()).isEqualTo(201);
        Map<String, Object> body = Json.readMap(new String(response.body(), StandardCharsets.UTF_8));
        Set<String> dtoFields = Arrays.stream(ProviderRecord.class.getRecordComponents())
                .map(RecordComponent::getName)
                .collect(Collectors.toSet());
        assertThat(body.keySet()).isEqualTo(dtoFields);
        assertThat(body.keySet())
                .containsExactlyInAnyOrder("id", "accountId", "format", "model", "baseUrl", "createdAt");
        assertThat(body.get("accountId")).isEqualTo(ProviderRegistry.LOCAL_ACCOUNT);
        assertThat(body.get("format")).isEqualTo("fake");
        assertThat(body.get("model")).isEqualTo("m1");
        assertThat(body.get("baseUrl")).isEqualTo("https://llm.example");
    }

    @Test
    void postNamesTheMissingField() {
        HttpResponse missingFormat = routes.create(request("POST", "/providers", null,
                "{\"model\":\"m1\"}"));
        assertThat(missingFormat.status()).isEqualTo(400);
        assertThat(new String(missingFormat.body())).contains("format");

        HttpResponse missingModel = routes.create(request("POST", "/providers", null,
                "{\"format\":\"fake\"}"));
        assertThat(missingModel.status()).isEqualTo(400);
        assertThat(new String(missingModel.body())).contains("model");
    }

    @Test
    void postUnknownFormatIsA400ListingAvailableFormats() {
        HttpResponse response = routes.create(request("POST", "/providers", null,
                "{\"format\":\"anthropic\",\"model\":\"m1\"}"));

        assertThat(response.status()).isEqualTo(400);
        String body = new String(response.body(), StandardCharsets.UTF_8);
        assertThat(body).contains("\"error\":\"unknown_format\"");
        assertThat(body).contains("no factory for 'anthropic'; available: [fake]");
    }

    @Test
    void getAndDeleteUnknownIdAre404() {
        HttpRequest byId = request("GET", "/providers/nope", Map.of("id", "nope"), "");

        HttpResponse fetched = routes.get(byId);
        assertThat(fetched.status()).isEqualTo(404);
        assertThat(new String(fetched.body())).contains("not_found");

        HttpResponse deleted = routes.delete(byId);
        assertThat(deleted.status()).isEqualTo(404);
        assertThat(new String(deleted.body())).contains("not_found");
    }

    @Test
    void formatsListTheRegisteredFactories() {
        HttpResponse response = routes.formats(request("GET", "/providers/formats", null, ""));

        assertThat(response.status()).isEqualTo(200);
        assertThat(new String(response.body(), StandardCharsets.UTF_8)).isEqualTo("[\"fake\"]");
    }

    @Test
    void getNeverContainsTheApiKey() {
        HttpResponse created = routes.create(request("POST", "/providers", null,
                "{\"format\":\"fake\",\"apiKey\":\"" + SECRET + "\",\"model\":\"m1\"}"));
        ProviderRecord record = Json.read(created.body(), ProviderRecord.class);

        HttpResponse fetched = routes.get(
                request("GET", "/providers/" + record.id(), Map.of("id", record.id()), ""));

        assertThat(fetched.status()).isEqualTo(200);
        assertThat(new String(fetched.body(), StandardCharsets.UTF_8)).doesNotContain(SECRET);
    }

    @Test
    void principalScopesTheAccount() {
        HttpResponse created = routes.create(principalRequest("POST", "/providers",
                new AccountPrincipal("alice"),
                "{\"format\":\"fake\",\"apiKey\":\"" + SECRET + "\",\"model\":\"m1\"}"));
        ProviderRecord record = Json.read(created.body(), ProviderRecord.class);
        assertThat(record.accountId()).isEqualTo("alice");

        HttpResponse mine = routes.list(principalRequest("GET", "/providers", "alice", ""));
        assertThat(Json.read(mine.body(), ProviderRecord[].class)).hasSize(1);

        HttpResponse theirs = routes.list(request("GET", "/providers", null, ""));
        assertThat(Json.read(theirs.body(), ProviderRecord[].class)).isEmpty();

        HttpResponse accessorOwned = routes.get(principalRequest("GET", "/providers/" + record.id(),
                new AccountPrincipal("alice"), Map.of("id", record.id()), ""));
        assertThat(accessorOwned.status()).isEqualTo(200);

        HttpResponse foreign = routes.get(principalRequest("GET", "/providers/" + record.id(),
                new AccountPrincipal("bob"), Map.of("id", record.id()), ""));
        assertThat(foreign.status()).isEqualTo(404);
    }

    private static HttpRequest request(String method, String path,
                                       Map<String, String> pathParams, String body) {
        return new FakeHttpRequest(method, path, pathParams == null ? Map.of() : pathParams,
                Map.of(), body);
    }

    private static HttpRequest principalRequest(String method, String path,
                                                Object principal, String body) {
        return principalRequest(method, path, principal, Map.of(), body);
    }

    private static HttpRequest principalRequest(String method, String path, Object principal,
                                                Map<String, String> pathParams, String body) {
        FakeHttpRequest request = new FakeHttpRequest(method, path, pathParams, Map.of(), body);
        request.setAttribute(Principals.PRINCIPAL_ATTRIBUTE, principal);
        return request;
    }
}