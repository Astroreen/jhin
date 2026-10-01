/**
 * Tests of {@link __PLUGIN_NAME__Plugin} against the recording
 * {@link FakePluginContext}: one happy case and one failure case per behavior.
 * Extend with the surfaces the plugin registers.
 */
package __PKG__;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.http.RouteSpec;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

final class __PLUGIN_NAME__PluginTest {

    @Test
    void startRegistersPingRouteAndPingAnswers200() throws Exception {
        FakePluginContext ctx = new FakePluginContext();
        new __PLUGIN_NAME__Plugin().start(ctx);

        RouteSpec route = ctx.routes().get(0);
        assertThat(route.method()).isEqualTo("GET");
        assertThat(route.path()).isEqualTo("/" + suffixOf("__PLUGIN_ID__") + "/ping");

        HttpResponse response = route.handler().handle(new FakeHttpRequest("GET", route.path()));
        assertThat(response.status()).isEqualTo(200);
        assertThat(new String(response.body(), StandardCharsets.UTF_8))
                .contains("\"plugin\":\"__PLUGIN_ID__\"");
    }

    @Test
    void blankNameIsRefusedWith400NamingTheProblem() throws Exception {
        FakePluginContext ctx = new FakePluginContext();
        new __PLUGIN_NAME__Plugin().start(ctx);

        HttpResponse response = ctx.routes().get(0).handler().handle(
                new FakeHttpRequest("GET", "/ping", Map.of("name", List.of(""))));
        assertThat(response.status()).isEqualTo(400);
        assertThat(new String(response.body(), StandardCharsets.UTF_8))
                .contains("invalid_name");
    }

    private static String suffixOf(String id) {
        int cut = id.indexOf('.');
        String suffix = (cut < 0 ? id : id.substring(cut + 1));
        return suffix.replace('.', '-');
    }
}
