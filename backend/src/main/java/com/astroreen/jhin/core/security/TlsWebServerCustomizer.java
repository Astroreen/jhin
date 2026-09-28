package com.astroreen.jhin.core.security;

import java.nio.file.Path;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.server.Ssl;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.boot.web.server.servlet.ConfigurableServletWebServerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/**
 * Поднимает HTTPS поверх самоподписанного keystore из {@link TlsKeyStoreGenerator}.
 *
 * <p>Порт не трогаем, если он уже задан через {@code server.port} (yml или {@code --server.port}):
 * защищаем конфиг от переопределения. Client-auth остаётся {@code none} (default {@link Ssl}).
 *
 * <p><b>Escape hatch:</b> {@code server.ssl.enabled: false} в конфиге отключает кастомизацию
 * целиком — сервер стартует по чистому HTTP. Свойство не задано — HTTPS включён.
 */
@Component
public class TlsWebServerCustomizer
        implements WebServerFactoryCustomizer<ConfigurableServletWebServerFactory>, Ordered {

    private static final int DEFAULT_HTTPS_PORT = 8443;

    private final Path jhinHome;
    private final boolean sslEnabled;
    private final Environment environment;

    public TlsWebServerCustomizer(
            @Value("${jhin.home}") String jhinHome,
            @Value("${server.ssl.enabled:true}") boolean sslEnabled,
            Environment environment) {
        this.jhinHome = Path.of(jhinHome);
        this.sslEnabled = sslEnabled;
        this.environment = environment;
    }

    /** Последним в цепочке customizer'ов — сгенерированный keystore перекрывает пустой {@code server.ssl.*}. */
    @Override
    public int getOrder() {
        return Ordered.LOWEST_PRECEDENCE;
    }

    @Override
    public void customize(ConfigurableServletWebServerFactory factory) {
        if (!sslEnabled) {
            return;
        }
        TlsKeyStoreGenerator.GeneratedTls tls = TlsKeyStoreGenerator.generateOrLoad(jhinHome);
        Ssl ssl = new Ssl();
        ssl.setKeyStore(tls.keystorePath().toUri().toString());
        ssl.setKeyStorePassword(tls.storePassword());
        ssl.setKeyStoreType("PKCS12");
        factory.setSsl(ssl);
        if (environment.getProperty("server.port") == null) {
            factory.setPort(DEFAULT_HTTPS_PORT);
        }
    }
}
