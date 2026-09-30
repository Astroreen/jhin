package com.astroreen.jhin.kernel.services;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import com.astroreen.jhin.sdk.PluginException;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;

class ServiceRegistryImplTest {

    private interface Greeter {
        String greet();
    }

    private static final class Alpha implements Greeter {
        @Override
        public String greet() {
            return "alpha";
        }
    }

    private static final class Beta implements Greeter {
        @Override
        public String greet() {
            return "beta";
        }
    }

    private static final class Gamma implements Greeter {
        @Override
        public String greet() {
            return "gamma";
        }
    }

    private final ServiceRegistryImpl registry = new ServiceRegistryImpl();

    @Test
    void findAllKeepsPublicationOrderAndFindReturnsTheFirst() {
        registry.attributedTo("demo.one", () -> registry.publish(Greeter.class, new Alpha()));
        registry.attributedTo("demo.two", () -> registry.publish(Greeter.class, "two", new Beta()));
        registry.attributedTo("demo.three",
                () -> registry.publish(Greeter.class, "three", new Gamma()));

        List<Greeter> all = registry.findAll(Greeter.class);
        assertThat(all).extracting(Greeter::greet).containsExactly("alpha", "beta", "gamma");

        Optional<Greeter> first = registry.find(Greeter.class);
        assertThat(first).isPresent();
        assertThat(first.orElseThrow().greet()).isEqualTo("alpha");
    }

    @Test
    void findRespectsQualifiers() {
        registry.attributedTo("demo.one", () -> registry.publish(Greeter.class, new Alpha()));
        registry.attributedTo("demo.two", () -> registry.publish(Greeter.class, "alt", new Beta()));

        assertThat(registry.find(Greeter.class)).containsInstanceOf(Alpha.class);
        assertThat(registry.find(Greeter.class, "alt")).containsInstanceOf(Beta.class);
        assertThat(registry.find(Greeter.class, "missing")).isEmpty();
        assertThat(registry.findAll(Greeter.class)).hasSize(2);
    }

    @Test
    void lookupsAreLiveAndFindAllIsASnapshot() {
        assertThat(registry.find(Greeter.class)).isEmpty();
        assertThat(registry.findAll(Greeter.class)).isEmpty();

        registry.attributedTo("demo.one", () -> registry.publish(Greeter.class, new Alpha()));
        List<Greeter> before = registry.findAll(Greeter.class);
        registry.attributedTo("demo.two", () -> registry.publish(Greeter.class, "alt", new Beta()));

        assertThat(registry.find(Greeter.class)).containsInstanceOf(Alpha.class);
        assertThat(before).hasSize(1);
        assertThat(registry.findAll(Greeter.class)).extracting(Greeter::greet)
                .containsExactly("alpha", "beta");
    }

    @Test
    void duplicatePublicationThrowsNamingBothPlugins() {
        registry.attributedTo("demo.one", () -> registry.publish(Greeter.class, new Alpha()));
        Throwable thrown = catchThrowable(() -> registry
                .attributedTo("demo.two", () -> registry.publish(Greeter.class, new Beta())));

        assertThat(thrown).isInstanceOf(PluginException.class);
        String text = String.valueOf(thrown);
        System.out.println("duplicate-error: " + text);
        assertThat(text).contains("demo.one").contains("demo.two").contains(Greeter.class.getName());
    }

    @Test
    void duplicateNamedQualifierThrowsNamingBothPlugins() {
        registry.attributedTo("demo.one",
                () -> registry.publish(Greeter.class, "alt", new Alpha()));
        Throwable thrown = catchThrowable(() -> registry
                .attributedTo("demo.three", () -> registry.publish(Greeter.class, "alt", new Gamma())));

        assertThat(thrown).isInstanceOf(PluginException.class);
        String text = String.valueOf(thrown);
        System.out.println("duplicate-error-alt: " + text);
        assertThat(text).contains("demo.one").contains("demo.three").contains("#alt");
    }

    @Test
    void publishersByPluginRecordsAttribution() {
        registry.attributedTo("demo.one", () -> registry.publish(Greeter.class, new Alpha()));
        registry.attributedTo("demo.two", () -> registry.publish(Greeter.class, "two", new Beta()));
        registry.attributedTo("demo.one",
                () -> registry.publish(Greeter.class, "three", new Gamma()));

        Map<String, List<String>> publishers = registry.publishersByPlugin();
        assertThat(publishers).containsOnlyKeys("demo.one", "demo.two");
        assertThat(publishers.get("demo.one")).containsExactly(
                Greeter.class.getName(), Greeter.class.getName() + "#three");
        assertThat(publishers.get("demo.two")).containsExactly(Greeter.class.getName() + "#two");
    }

    @Test
    void unattributedPublicationIsAttributedToTheHost() {
        registry.publish(Greeter.class, new Alpha());
        assertThat(registry.publishersByPlugin())
                .containsOnlyKeys(ServiceRegistryImpl.HOST_PUBLISHER);
    }
}
