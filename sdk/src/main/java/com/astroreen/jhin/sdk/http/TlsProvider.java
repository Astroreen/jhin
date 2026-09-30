/**
 * TLS material for the HTTPS listener.
 *
 * <p>Implemented by a plugin (typically a security plugin holding a generated
 * or uploaded certificate) and registered through
 * {@link HttpRegistry#tls(TlsProvider)}. The kernel reads it once at server
 * startup to configure HTTPS; when no provider is registered the server speaks
 * plain HTTP.
 */
package com.astroreen.jhin.sdk.http;

public interface TlsProvider {

    /**
     * The key store holding the server certificate and private key. Called
     * once by the kernel at server startup.
     *
     * @return a loaded {@link java.security.KeyStore}
     */
    java.security.KeyStore keyStore();

    /**
     * The password of the key store. Called once by the kernel at server
     * startup.
     *
     * @return the key store password
     */
    char[] keyStorePassword();
}
