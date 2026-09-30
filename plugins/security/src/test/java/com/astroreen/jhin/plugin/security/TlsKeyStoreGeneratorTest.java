/**
 * TLS key store generator coverage: a missing key store is generated as a
 * PKCS#12 file with its password kept owner-only, an existing key store is
 * reloaded unchanged instead of regenerated, and the resulting provider hands
 * the kernel a non-null key store.
 */
package com.astroreen.jhin.plugin.security;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.sdk.http.TlsProvider;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.security.KeyStore;
import java.security.cert.X509Certificate;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class TlsKeyStoreGeneratorTest {

    @TempDir
    Path home;

    @Test
    void generatesKeyStoreWhenAbsent() throws Exception {
        Path keystoreFile = home.resolve("keystore").resolve(TlsKeyStoreGenerator.KEYSTORE_NAME);
        Path passwordFile = home.resolve("keystore").resolve(TlsKeyStoreGenerator.PASSWORD_NAME);
        assertThat(keystoreFile).doesNotExist();

        TlsProvider provider = new TlsKeyStoreGenerator(home).loadOrCreate();

        assertThat(keystoreFile).exists();
        assertThat(passwordFile).exists();
        assertThat(provider.keyStore()).isNotNull();
        KeyStore store = provider.keyStore();
        assertThat(store.containsAlias(TlsKeyStoreGenerator.KEY_ALIAS)).isTrue();
        assertThat(store.isKeyEntry(TlsKeyStoreGenerator.KEY_ALIAS)).isTrue();
        assertThat(store.getCertificate(TlsKeyStoreGenerator.KEY_ALIAS))
                .isInstanceOf(X509Certificate.class);
        assertOwnerOnly(home.resolve("keystore"), true);
        assertOwnerOnly(keystoreFile, false);
        assertOwnerOnly(passwordFile, false);
    }

    @Test
    void reloadsTheSameKeyStoreWhenPresent() throws Exception {
        TlsProvider first = new TlsKeyStoreGenerator(home).loadOrCreate();
        X509Certificate certificate = (X509Certificate) first.keyStore()
                .getCertificate(TlsKeyStoreGenerator.KEY_ALIAS);

        TlsProvider second = new TlsKeyStoreGenerator(home).loadOrCreate();

        X509Certificate reloaded = (X509Certificate) second.keyStore()
                .getCertificate(TlsKeyStoreGenerator.KEY_ALIAS);
        assertThat(reloaded.getSerialNumber()).isEqualTo(certificate.getSerialNumber());
        assertThat(second.keyStorePassword()).isEqualTo(first.keyStorePassword());
    }

    @Test
    void keyStoreIsNonNullOnEveryCall() {
        TlsKeyStoreGenerator generator = new TlsKeyStoreGenerator(home);

        assertThat(generator.loadOrCreate().keyStore()).isNotNull();
        assertThat(generator.loadOrCreate().keyStore()).isNotNull();
    }

    private static void assertOwnerOnly(Path path, boolean directory) throws Exception {
        Set<PosixFilePermission> permissions = Files.getPosixFilePermissions(path);
        Set<PosixFilePermission> allowed = directory
                ? Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE,
                        PosixFilePermission.OWNER_EXECUTE)
                : Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE);
        assertThat(permissions).isEqualTo(allowed);
    }
}
