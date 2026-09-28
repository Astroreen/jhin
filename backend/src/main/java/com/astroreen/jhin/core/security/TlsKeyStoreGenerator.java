package com.astroreen.jhin.core.security;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.Base64;
import java.util.Date;
import java.util.HexFormat;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x500.X500NameBuilder;
import org.bouncycastle.asn1.x500.style.BCStyle;
import org.bouncycastle.asn1.x509.Extension;
import org.bouncycastle.asn1.x509.GeneralName;
import org.bouncycastle.asn1.x509.GeneralNames;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.bouncycastle.operator.ContentSigner;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Генерация самоподписанного TLS-ключевого материала при первом старте hub.
 *
 * <p>Ключи и пароль никогда не покидают каталог {@code ${jhin.home}/keystore/}: PKCS12-стор
 * {@code server.p12} и файл пароля {@code server.p12.password} создаются с правами 0600. При
 * последующих стартах готовый стор загружается без регенерации (отпечаток сертификата стабилен).
 * Битая пара (стор без пароля, нечитаемый стор) — регенерация обоих файлов с WARN-логом.
 */
public final class TlsKeyStoreGenerator {

    private static final Logger log = LoggerFactory.getLogger(TlsKeyStoreGenerator.class);

    private static final String KEY_ALIAS = "server";
    private static final String KEYSTORE_TYPE = "PKCS12";
    private static final int KEY_SIZE = 2048;
    private static final long VALIDITY_MILLIS = 3650L * 24 * 60 * 60 * 1000;

    private TlsKeyStoreGenerator() {}

    /** Результат generate-or-load: путь к стору, пароль, SHA-256-отпечаток и сертификат. */
    public record GeneratedTls(Path keystorePath, String storePassword, String fingerprint, X509Certificate cert) {}

    /**
     * Генерирует keystore при первом старте, иначе загружает существующий.
     *
     * <p>Логирует INFO {@code TLS fingerprint (SHA-256): <fingerprint>} в обоих случаях. Пароль
     * в логи не попадает. Ошибки генерации/загрузки — {@link IllegalStateException}.
     */
    public static GeneratedTls generateOrLoad(Path jhinHome) {
        Path keystoreDir = jhinHome.resolve("keystore");
        Path p12 = keystoreDir.resolve(KEY_ALIAS + ".p12");
        Path passwordFile = keystoreDir.resolve(KEY_ALIAS + ".p12.password");
        if (Files.exists(p12) && Files.exists(passwordFile)) {
            try {
                return load(p12, passwordFile);
            } catch (Exception e) {
                log.warn("TLS keystore unreadable, regenerating both files: {}", e.toString());
            }
        } else if (Files.exists(p12) || Files.exists(passwordFile)) {
            log.warn(
                    "TLS keystore half-present ({}), regenerating both files",
                    Files.exists(p12) ? "password file missing" : "keystore missing");
        }
        try {
            return generate(keystoreDir, p12, passwordFile);
        } catch (Exception e) {
            throw new IllegalStateException("TLS keystore generation failed", e);
        }
    }

    private static GeneratedTls load(Path p12, Path passwordFile) throws Exception {
        String password = Files.readString(passwordFile, StandardCharsets.UTF_8).trim();
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_TYPE);
        try (InputStream in = Files.newInputStream(p12)) {
            keyStore.load(in, password.toCharArray());
        }
        Certificate[] chain = keyStore.getCertificateChain(KEY_ALIAS);
        if (chain == null || chain.length == 0 || !(chain[0] instanceof X509Certificate cert)) {
            throw new IllegalStateException("keystore entry '" + KEY_ALIAS + "' missing");
        }
        String fingerprint = fingerprint(cert);
        log.info("Loaded TLS keystore {}", p12);
        log.info("TLS fingerprint (SHA-256): {}", fingerprint);
        return new GeneratedTls(p12, password, fingerprint, cert);
    }

    private static GeneratedTls generate(Path keystoreDir, Path p12, Path passwordFile) throws Exception {
        Files.createDirectories(keystoreDir);
        SecureRandom random = new SecureRandom();

        KeyPairGenerator keyPairGenerator = KeyPairGenerator.getInstance("RSA");
        keyPairGenerator.initialize(KEY_SIZE, random);
        KeyPair keyPair = keyPairGenerator.generateKeyPair();

        X509Certificate cert = selfSignedCertificate(keyPair, random);
        String password = randomPassword(random);

        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_TYPE);
        keyStore.load(null, null);
        keyStore.setKeyEntry(KEY_ALIAS, keyPair.getPrivate(), password.toCharArray(), new Certificate[] {cert});
        try (OutputStream out = Files.newOutputStream(p12)) {
            keyStore.store(out, password.toCharArray());
        }
        restrictPermissions(p12);
        Files.writeString(passwordFile, password, StandardCharsets.UTF_8);
        restrictPermissions(passwordFile);

        String fingerprint = fingerprint(cert);
        log.info("Generated self-signed TLS keystore {}", p12);
        log.info("TLS fingerprint (SHA-256): {}", fingerprint);
        return new GeneratedTls(p12, password, fingerprint, cert);
    }

    private static X509Certificate selfSignedCertificate(KeyPair keyPair, SecureRandom random) throws Exception {
        String cn = resolveHostname();
        X500NameBuilder nameBuilder = new X500NameBuilder(BCStyle.INSTANCE);
        nameBuilder.addRDN(BCStyle.CN, cn);
        X500Name name = nameBuilder.build();

        Date notBefore = new Date(System.currentTimeMillis() - 24L * 60 * 60 * 1000);
        Date notAfter = new Date(System.currentTimeMillis() + VALIDITY_MILLIS);
        BigInteger serial = new BigInteger(160, random);

        JcaX509v3CertificateBuilder builder =
                new JcaX509v3CertificateBuilder(name, serial, notBefore, notAfter, name, keyPair.getPublic());
        builder.addExtension(Extension.subjectAlternativeName, false, subjectAlternativeNames(cn));

        BouncyCastleProvider provider = new BouncyCastleProvider();
        ContentSigner signer =
                new JcaContentSignerBuilder("SHA256WithRSA").setProvider(provider).build(keyPair.getPrivate());
        return new JcaX509CertificateConverter().setProvider(provider).getCertificate(builder.build(signer));
    }

    private static GeneralNames subjectAlternativeNames(String cn) {
        return new GeneralNames(new GeneralName[] {
            new GeneralName(GeneralName.dNSName, cn),
            new GeneralName(GeneralName.dNSName, "localhost"),
            new GeneralName(GeneralName.iPAddress, "127.0.0.1"),
            new GeneralName(GeneralName.iPAddress, "::1"),
        });
    }

    private static String resolveHostname() {
        try {
            String hostname = InetAddress.getLocalHost().getHostName();
            return (hostname == null || hostname.isBlank()) ? "localhost" : hostname;
        } catch (Exception e) {
            return "localhost";
        }
    }

    private static String randomPassword(SecureRandom random) {
        byte[] raw = new byte[24];
        random.nextBytes(raw);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
    }

    /** SHA-256 от DER-кодировки сертификата: 32 байта, hex UPPERCASE парами через {@code :}. */
    private static String fingerprint(X509Certificate cert) throws Exception {
        byte[] der = cert.getEncoded();
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(der);
            return HexFormat.of().withUpperCase().withDelimiter(":").formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    private static void restrictPermissions(Path file) throws IOException {
        try {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException e) {
            // non-POSIX (Windows) — права не выставляем
        }
    }
}
