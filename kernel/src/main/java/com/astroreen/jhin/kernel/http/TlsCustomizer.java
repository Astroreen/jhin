/**
 * Turns the registered TLS material into an HTTPS listener.
 *
 * <p>Runs once at startup, before the web server binds. When a plugin supplied
 * TLS material through the registry (first registration wins there), the
 * listener is switched to HTTPS and configured from the material's key store;
 * when nothing was supplied the listener keeps plain HTTP. Nothing else about
 * the listener is touched.
 */
package com.astroreen.jhin.kernel.http;

import java.security.KeyStore;
import java.util.Objects;
import org.springframework.boot.ssl.DefaultSslBundleRegistry;
import org.springframework.boot.ssl.SslBundle;
import org.springframework.boot.ssl.SslStoreBundle;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.Ssl;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.stereotype.Component;

@Component
public final class TlsCustomizer implements WebServerFactoryCustomizer<TomcatServletWebServerFactory> {

    /** Name under which the TLS material is registered with the web server. */
    private static final String BUNDLE_NAME = "jhin";

    private final HttpRegistryImpl registry;

    /**
     * Creates the customizer over the registry holding the TLS slot.
     *
     * @param registry the registry to read the accepted TLS material from
     */
    public TlsCustomizer(HttpRegistryImpl registry) {
        this.registry = Objects.requireNonNull(registry, "registry");
    }

    /**
     * Enables HTTPS on the factory when TLS material was accepted, leaving
     * plain HTTP otherwise. Called once at startup by the web server factory
     * post-processor.
     *
     * @param factory the web server factory to customize
     */
    @Override
    public void customize(TomcatServletWebServerFactory factory) {
        registry.acceptedTls().ifPresent(entry -> {
            KeyStore keyStore = entry.source().keyStore();
            char[] password = entry.source().keyStorePassword();
            String secret = (password == null) ? null : new String(password);
            SslStoreBundle stores = SslStoreBundle.of(keyStore, secret, null);
            Ssl ssl = Ssl.forBundle(BUNDLE_NAME);
            ssl.setEnabled(true);
            factory.setSsl(ssl);
            factory.setSslBundles(new DefaultSslBundleRegistry(BUNDLE_NAME, SslBundle.of(stores)));
        });
    }
}
