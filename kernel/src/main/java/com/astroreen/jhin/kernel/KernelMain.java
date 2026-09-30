/**
 * Entry point of the kernel: resolves the home layout and boots the
 * application context that carries the web server.
 *
 * <p>The wiring here is deliberately minimal so the full boot sequence can
 * grow in place: the HTTP registry is created first, filled with the kernel
 * fallbacks of {@link KernelRoutes}, and handed to Spring as a pre-built
 * singleton. The web listener starts on the {@code kernel.address} and
 * {@code kernel.port} defaults ({@code 0.0.0.0} / {@code 8443}) until the
 * configuration-aware boot sequence replaces these literals.
 */
package com.astroreen.jhin.kernel;

import com.astroreen.jhin.kernel.config.JhinHome;
import com.astroreen.jhin.kernel.http.HttpRegistryImpl;
import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.servlet.autoconfigure.MultipartAutoConfiguration;
import org.springframework.boot.webmvc.autoconfigure.DispatcherServletAutoConfiguration;
import org.springframework.boot.webmvc.autoconfigure.error.ErrorMvcAutoConfiguration;
import org.springframework.context.annotation.Bean;

@SpringBootApplication(exclude = {
        DispatcherServletAutoConfiguration.class,
        ErrorMvcAutoConfiguration.class,
        MultipartAutoConfiguration.class
})
public class KernelMain {

    /**
     * Resolves the home layout and starts the web server. Called by the JVM.
     *
     * @param args command-line arguments, unused for the server path
     */
    public static void main(String[] args) {
        JhinHome.resolve();
        SpringApplication application = new SpringApplication(KernelMain.class);
        application.setDefaultProperties(Map.of(
                "server.address", "0.0.0.0",
                "server.port", "8443"));
        application.run(args);
    }

    /**
     * The HTTP registry, created before the web wiring and filled with the
     * kernel fallbacks. Later boot steps register plugin routes and filters
     * into the same instance before the listener binds.
     *
     * @return the registry singleton
     */
    @Bean
    public HttpRegistryImpl httpRegistry() {
        HttpRegistryImpl registry = new HttpRegistryImpl();
        KernelRoutes.install(registry);
        return registry;
    }
}
