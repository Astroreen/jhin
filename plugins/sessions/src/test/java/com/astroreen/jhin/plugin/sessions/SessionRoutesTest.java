/**
 * CRUD route behaviour: create validation (the offending field is named),
 * the list/get/patch/delete lifecycle with {@code 404 not_found} on an unknown
 * id and account scoping through the request principal (string principal,
 * {@code accountId()} accessor principal and absent principal).
 */
package com.astroreen.jhin.plugin.sessions;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SessionRoutesTest {

    /** Principal exposing an account id through a public accessor. */
    record AccountPrincipal(String accountId) {}

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private SessionStore store;
    private SessionRoutes routes;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        db.migrate(Migrations.all());
        store = new SessionStoreImpl(db);
        routes = new SessionRoutes(store);
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void createPersistsRequiredAndOptionalFields() {
        HttpResponse response = routes.create(request("POST", "/sessions", null,
                "{\"title\":\"demo\",\"workdir\":\"/tmp/demo\",\"model\":\"m1\",\"providerId\":\"p1\"}"));

        assertThat(response.status()).isEqualTo(201);
        Session session = Json.read(response.body(), Session.class);
        assertThat(session.id()).isNotBlank();
        assertThat(session.accountId()).isEqualTo(SessionStore.LOCAL_ACCOUNT);
        assertThat(session.title()).isEqualTo("demo");
        assertThat(session.workdir()).isEqualTo("/tmp/demo");
        assertThat(session.model()).isEqualTo("m1");
        assertThat(session.providerId()).isEqualTo("p1");
    }

    @Test
    void createNamesWorkdirWhenMissingOrBlank() {
        HttpResponse empty = routes.create(request("POST", "/sessions", null, "{}"));
        assertThat(empty.status()).isEqualTo(400);
        assertThat(new String(empty.body())).contains("workdir");

        HttpResponse blank = routes.create(request("POST", "/sessions", null,
                "{\"title\":\"demo\",\"workdir\":\" \"}"));
        assertThat(blank.status()).isEqualTo(400);
        assertThat(new String(blank.body())).contains("workdir");

        HttpResponse missing = routes.create(request("POST", "/sessions", null, "{\"title\":\"demo\"}"));
        assertThat(missing.status()).isEqualTo(400);
        assertThat(new String(missing.body())).contains("workdir");
    }

    @Test
    void createNamesOffendingFieldOnMalformedBody() {
        HttpResponse wrongType = routes.create(request("POST", "/sessions", null,
                "{\"title\":5,\"workdir\":\"/tmp\"}"));
        assertThat(wrongType.status()).isEqualTo(400);
        assertThat(new String(wrongType.body())).contains("title");

        HttpResponse blankTitle = routes.create(request("POST", "/sessions", null,
                "{\"title\":\"\",\"workdir\":\"/tmp\"}"));
        assertThat(blankTitle.status()).isEqualTo(400);
        assertThat(new String(blankTitle.body())).contains("title");

        HttpResponse invalidJson = routes.create(request("POST", "/sessions", null, "{"));
        assertThat(invalidJson.status()).isEqualTo(400);
        assertThat(new String(invalidJson.body())).contains("invalid_request");
    }

    @Test
    void listGetPatchDeleteLifecycle() {
        HttpResponse created = routes.create(request("POST", "/sessions", null,
                "{\"title\":\"demo\",\"workdir\":\"/tmp/demo\"}"));
        Session session = Json.read(created.body(), Session.class);
        HttpRequest byId = request("GET", "/sessions/" + session.id(), Map.of("id", session.id()), "");

        HttpResponse list = routes.list(request("GET", "/sessions", null, ""));
        assertThat(list.status()).isEqualTo(200);
        assertThat(Json.read(list.body(), Session[].class)).hasSize(1);

        HttpResponse fetched = routes.get(byId);
        assertThat(fetched.status()).isEqualTo(200);

        HttpResponse patched = routes.patch(request("PATCH", "/sessions/" + session.id(),
                Map.of("id", session.id()), "{\"title\":\"renamed\",\"status\":\"archived\"}"));
        assertThat(patched.status()).isEqualTo(200);
        Session updated = Json.read(patched.body(), Session.class);
        assertThat(updated.title()).isEqualTo("renamed");
        assertThat(updated.workdir()).isEqualTo("/tmp/demo");
        assertThat(updated.status()).isEqualTo("archived");

        HttpResponse deleted = routes.delete(byId);
        assertThat(deleted.status()).isEqualTo(204);

        HttpResponse gone = routes.get(byId);
        assertThat(gone.status()).isEqualTo(404);
        assertThat(new String(gone.body())).contains("not_found");
        assertThat(routes.delete(byId).status()).isEqualTo(404);
    }

    @Test
    void patchUnknownSessionIs404AndMalformedFieldIs400() {
        HttpResponse unknown = routes.patch(request("PATCH", "/sessions/nope", Map.of("id", "nope"),
                "{\"title\":\"x\"}"));
        assertThat(unknown.status()).isEqualTo(404);
        assertThat(new String(unknown.body())).contains("not_found");

        HttpResponse created = routes.create(request("POST", "/sessions", null,
                "{\"title\":\"demo\",\"workdir\":\"/tmp/demo\"}"));
        Session session = Json.read(created.body(), Session.class);
        HttpResponse badField = routes.patch(request("PATCH", "/sessions/" + session.id(),
                Map.of("id", session.id()), "{\"workdir\":7}"));
        assertThat(badField.status()).isEqualTo(400);
        assertThat(new String(badField.body())).contains("workdir");
    }

    @Test
    void principalScopesEveryCallByAccountId() {
        HttpResponse created = routes.create(requestWithPrincipal("POST", "/sessions", null,
                "{\"title\":\"alice\",\"workdir\":\"/tmp/a\"}", "alice"));
        Session session = Json.read(created.body(), Session.class);
        assertThat(session.accountId()).isEqualTo("alice");

        HttpResponse forBob = routes.list(requestWithPrincipal("GET", "/sessions", null, "", "bob"));
        assertThat(Json.read(forBob.body(), Session[].class)).isEmpty();

        HttpResponse bobGet = routes.get(requestWithPrincipal("GET", "/sessions/" + session.id(),
                Map.of("id", session.id()), "", "bob"));
        assertThat(bobGet.status()).isEqualTo(404);

        HttpResponse forAlice = routes.list(requestWithPrincipal("GET", "/sessions", null, "", "alice"));
        assertThat(Json.read(forAlice.body(), Session[].class)).hasSize(1);

        HttpResponse unscoped = routes.list(request("GET", "/sessions", null, ""));
        assertThat(Json.read(unscoped.body(), Session[].class)).hasSize(1);
    }

    @Test
    void principalWithAccountIdAccessorIsScopedLikeAStringPrincipal() {
        HttpResponse created = routes.create(requestWithPrincipal("POST", "/sessions", null,
                "{\"title\":\"bob\",\"workdir\":\"/tmp/b\"}", new AccountPrincipal("bob")));
        Session session = Json.read(created.body(), Session.class);
        assertThat(session.accountId()).isEqualTo("bob");

        HttpResponse scoped = routes.get(requestWithPrincipal("GET", "/sessions/" + session.id(),
                Map.of("id", session.id()), "", new AccountPrincipal("bob")));
        assertThat(scoped.status()).isEqualTo(200);

        HttpResponse foreign = routes.get(requestWithPrincipal("GET", "/sessions/" + session.id(),
                Map.of("id", session.id()), "", new AccountPrincipal("alice")));
        assertThat(foreign.status()).isEqualTo(404);
    }

    private static FakeHttpRequest request(String method, String path, Map<String, String> params, String body) {
        return new FakeHttpRequest(method, path, params == null ? Map.of() : params, Map.of(), body);
    }

    private static FakeHttpRequest requestWithPrincipal(String method, String path,
                                                        Map<String, String> params, String body, Object principal) {
        FakeHttpRequest req = request(method, path, params, body);
        req.setAttribute(Principals.PRINCIPAL_ATTRIBUTE, principal);
        return req;
    }
}
