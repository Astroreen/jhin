package com.astroreen.jhin.core.security;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.core.security.TlsKeyStoreGenerator.GeneratedTls;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.security.interfaces.RSAPublicKey;
import java.util.Collection;
import java.util.List;
import javax.naming.ldap.LdapName;
import javax.naming.ldap.Rdn;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class TlsKeyStoreGeneratorTest {

    private static final String FINGERPRINT_PATTERN = "^([0-9A-F]{2}:){31}[0-9A-F]{2}$";
    private static final int GENERAL_NAME_DNS_NAME = 2;

    @TempDir
    Path jhinHome;

    @Test
    void firstCallGeneratesKeystoreAndPasswordFileWithOwnerOnlyPermissions() throws Exception {
        GeneratedTls generated = TlsKeyStoreGenerator.generateOrLoad(jhinHome);

        Path p12 = jhinHome.resolve("keystore/server.p12");
        Path passwordFile = jhinHome.resolve("keystore/server.p12.password");
        assertThat(p12).exists();
        assertThat(passwordFile).exists();
        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(p12))).isEqualTo("rw-------");
        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(passwordFile))).isEqualTo("rw-------");
        assertThat(generated.keystorePath()).isEqualTo(p12);
        assertThat(generated.storePassword()).isNotBlank().hasSizeGreaterThanOrEqualTo(24);
    }

    @Test
    void generatedKeystoreLoadsWithServerAliasKeyEntryAndChain() throws Exception {
        GeneratedTls generated = TlsKeyStoreGenerator.generateOrLoad(jhinHome);

        KeyStore keyStore = KeyStore.getInstance("PKCS12");
        try (InputStream in = Files.newInputStream(generated.keystorePath())) {
            keyStore.load(in, generated.storePassword().toCharArray());
        }
        assertThat(keyStore.containsAlias("server")).isTrue();
        assertThat(keyStore.isKeyEntry("server")).isTrue();
        Certificate[] chain = keyStore.getCertificateChain("server");
        assertThat(chain).isNotNull().isNotEmpty();
        assertThat(chain[0]).isInstanceOf(X509Certificate.class);
    }

    @Test
    void certificateSubjectCommonNameSanAndFingerprintShape() throws Exception {
        GeneratedTls generated = TlsKeyStoreGenerator.generateOrLoad(jhinHome);

        X509Certificate cert = generated.cert();
        assertThat(commonName(cert.getSubjectX500Principal().getName())).isNotBlank();
        Collection<List<?>> sans = cert.getSubjectAlternativeNames();
        assertThat(sans).isNotNull();
        List<String> dnsNames = sans.stream()
                .filter(n -> ((Integer) n.get(0)) == GENERAL_NAME_DNS_NAME)
                .map(n -> (String) n.get(1))
                .toList();
        assertThat(dnsNames).contains("localhost");
        assertThat(generated.fingerprint()).matches(FINGERPRINT_PATTERN);
    }

    @Test
    void secondCallReusesExistingKeystoreWithSameFingerprint() throws Exception {
        GeneratedTls first = TlsKeyStoreGenerator.generateOrLoad(jhinHome);
        GeneratedTls second = TlsKeyStoreGenerator.generateOrLoad(jhinHome);

        assertThat(second.fingerprint()).isEqualTo(first.fingerprint());
        assertThat(second.storePassword()).isEqualTo(first.storePassword());
        assertThat(second.cert().getEncoded()).isEqualTo(first.cert().getEncoded());
    }

    @Test
    void missingPasswordFileTriggersRegeneration() throws Exception {
        TlsKeyStoreGenerator.generateOrLoad(jhinHome);
        Files.delete(jhinHome.resolve("keystore/server.p12.password"));

        GeneratedTls regenerated = TlsKeyStoreGenerator.generateOrLoad(jhinHome);

        Path p12 = jhinHome.resolve("keystore/server.p12");
        Path passwordFile = jhinHome.resolve("keystore/server.p12.password");
        assertThat(p12).exists();
        assertThat(passwordFile).exists();
        KeyStore keyStore = KeyStore.getInstance("PKCS12");
        try (InputStream in = Files.newInputStream(p12)) {
            keyStore.load(in, regenerated.storePassword().toCharArray());
        }
        assertThat(keyStore.containsAlias("server")).isTrue();
    }

    @Test
    void certificatePublicKeyIsRsa2048() throws Exception {
        GeneratedTls generated = TlsKeyStoreGenerator.generateOrLoad(jhinHome);

        assertThat(generated.cert().getPublicKey()).isInstanceOf(RSAPublicKey.class);
        RSAPublicKey publicKey = (RSAPublicKey) generated.cert().getPublicKey();
        assertThat(publicKey.getModulus().bitLength()).isEqualTo(2048);
    }

    private static String commonName(String dn) throws Exception {
        for (Rdn rdn : new LdapName(dn).getRdns()) {
            if ("CN".equalsIgnoreCase(rdn.getType())) {
                return rdn.getValue().toString();
            }
        }
        return "";
    }
}
