/**
 * Generates and loads the HTTPS key material of the hub.
 *
 * <p>Created from {@link SecurityPlugin#start} with the installation root and
 * asked for a {@link com.astroreen.jhin.sdk.http.TlsProvider}, which the
 * kernel turns into an HTTPS listener. All material lives under
 * {@code JHIN_HOME/keystore/} (directory created {@code 0700}):
 *
 * <ul>
 *   <li>{@code jhin.p12} — a PKCS#12 key store holding one RSA-2048 key pair
 *       and its self-signed X.509 certificate (CN {@code jhin}, ten years of
 *       validity, SHA-256 signature). Generated on first start via
 *       BouncyCastle's {@code bcpkix} (bundled into the plugin jar); clients
 *       pin the certificate rather than trusting a CA chain.</li>
 *   <li>{@code jhin.p12.pass} — the key store password, 256 bits of
 *       {@link java.security.SecureRandom} entropy rendered as lowercase hex
 *       (via {@link Hashes#toHex(byte[])}), written {@code 0600} inside the
 *       {@code 0700} directory so it is never world-readable. A generated
 *       password beats a fixed one: the private key at rest is protected
 *       without a secret compiled into the jar.</li>
 * </ul>
 *
 * <p>Idempotent across restarts: when {@code jhin.p12} already exists the
 * generator loads it and its stored password instead of regenerating, so the
 * server certificate is stable. A key store without its password file is a
 * broken state (someone deleted one half) and fails with instructions to
 * remove the keystore directory and let the generator start over.
 */
package com.astroreen.jhin.plugin.security;

import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.http.TlsProvider;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Date;
import java.util.EnumSet;
import java.util.Set;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.operator.ContentSigner;
import org.bouncycastle.operator.OperatorCreationException;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;

final class TlsKeyStoreGenerator {

    /** File name of the PKCS#12 key store inside {@code JHIN_HOME/keystore}. */
    static final String KEYSTORE_NAME = "jhin.p12";

    /** File name of the stored key store password. */
    static final String PASSWORD_NAME = "jhin.p12.pass";

    /** Key alias inside the key store. */
    static final String KEY_ALIAS = "jhin";

    /** RSA key size of the generated server key. */
    static final int KEY_BITS = 2048;

    /** Certificate validity in days. */
    static final int VALIDITY_DAYS = 3650;

    /** Distinguished name of the self-signed certificate. */
    private static final String SUBJECT = "CN=jhin";

    /** Password entropy in bytes, rendered as hex. */
    private static final int PASSWORD_BYTES = 32;

    private final Path keystoreDir;
    private final Path keystoreFile;
    private final Path passwordFile;

    /**
     * Creates the generator over one installation root.
     *
     * @param home {@code JHIN_HOME}, the directory holding {@code keystore/}
     */
    TlsKeyStoreGenerator(Path home) {
        this.keystoreDir = home.resolve("keystore");
        this.keystoreFile = keystoreDir.resolve(KEYSTORE_NAME);
        this.passwordFile = keystoreDir.resolve(PASSWORD_NAME);
    }

    /**
     * Returns the TLS material of the installation: loads the existing key
     * store or generates a self-signed one on first call. Called once from
     * {@link SecurityPlugin#start}; every later call (later restarts) loads
     * the same store back.
     *
     * @return a provider handing the key store and its password to the kernel
     * @throws PluginException when the material cannot be generated or loaded
     */
    TlsProvider loadOrCreate() {
        try {
            Files.createDirectories(keystoreDir);
            restrict(keystoreDir, true);
            char[] password;
            if (Files.exists(keystoreFile)) {
                password = readPassword();
            } else {
                password = generatePassword();
                writePassword(password);
                writeKeyStore(password);
            }
            return new GeneratedTlsProvider(loadKeyStore(password), password);
        } catch (IOException | GeneralSecurityException | OperatorCreationException e) {
            throw new PluginException("failed to prepare the TLS key store at " + keystoreFile, e);
        }
    }

    /** Loads the key store from disk with the given password. */
    private KeyStore loadKeyStore(char[] password) throws IOException, GeneralSecurityException {
        KeyStore store = KeyStore.getInstance("PKCS12");
        try (InputStream in = Files.newInputStream(keystoreFile)) {
            store.load(in, password);
        }
        return store;
    }

    /**
     * Generates a fresh RSA-2048 key pair, wraps it in a self-signed X.509
     * certificate and writes the PKCS#12 key store. BouncyCastle builds the
     * certificate; key generation and signing run through the JVM's default
     * JCA providers.
     */
    private void writeKeyStore(char[] password)
            throws IOException, GeneralSecurityException, OperatorCreationException {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(KEY_BITS, new SecureRandom());
        KeyPair keyPair = generator.generateKeyPair();
        X500Name subject = new X500Name(SUBJECT);
        Instant now = Instant.now();
        JcaX509v3CertificateBuilder builder = new JcaX509v3CertificateBuilder(
                subject,
                new java.math.BigInteger(160, new SecureRandom()),
                Date.from(now.minus(1, ChronoUnit.DAYS)),
                Date.from(now.plus(VALIDITY_DAYS, ChronoUnit.DAYS)),
                subject,
                keyPair.getPublic());
        ContentSigner signer = new JcaContentSignerBuilder("SHA256WithRSA").build(keyPair.getPrivate());
        X509Certificate cert =
                new JcaX509CertificateConverter().getCertificate(builder.build(signer));
        KeyStore store = KeyStore.getInstance("PKCS12");
        store.load(null, password);
        store.setKeyEntry(KEY_ALIAS, keyPair.getPrivate(), password, new Certificate[]{cert});
        try (OutputStream out = Files.newOutputStream(keystoreFile)) {
            store.store(out, password);
        }
        restrict(keystoreFile, false);
    }

    /** Generates the key store password from fresh entropy. */
    private static char[] generatePassword() {
        byte[] entropy = new byte[PASSWORD_BYTES];
        new SecureRandom().nextBytes(entropy);
        return Hashes.toHex(entropy).toCharArray();
    }

    /** Writes the password file owner-readable only. */
    private void writePassword(char[] password) throws IOException {
        Files.writeString(passwordFile, new String(password), StandardCharsets.UTF_8);
        restrict(passwordFile, false);
    }

    /** Reads the stored password back. */
    private char[] readPassword() throws IOException {
        if (!Files.exists(passwordFile)) {
            throw new PluginException("key store password file is missing: " + passwordFile
                    + "; remove the " + keystoreDir + " directory to regenerate the TLS material");
        }
        return Files.readString(passwordFile, StandardCharsets.UTF_8).trim().toCharArray();
    }

    /**
     * Tightens POSIX permissions where the file system knows them: {@code 0700}
     * for the keystore directory, {@code 0600} for its files. Ignored on file
     * systems without POSIX attributes.
     */
    private static void restrict(Path path, boolean directory) throws IOException {
        Set<PosixFilePermission> permissions = directory
                ? EnumSet.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE,
                        PosixFilePermission.OWNER_EXECUTE)
                : EnumSet.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE);
        try {
            Files.setPosixFilePermissions(path, permissions);
        } catch (UnsupportedOperationException ignored) {
            // non-POSIX file system: nothing to tighten
        }
    }

    /**
     * The immutable TLS material handed to the kernel.
     *
     * <p>Components: {@code stores} — the loaded key store; {@code secret} —
     * its password, cloned on every read so callers cannot mutate the stored
     * copy.
     */
    private static final class GeneratedTlsProvider implements TlsProvider {

        private final KeyStore stores;
        private final char[] secret;

        GeneratedTlsProvider(KeyStore stores, char[] secret) {
            this.stores = stores;
            this.secret = secret.clone();
        }

        @Override
        public KeyStore keyStore() {
            return stores;
        }

        @Override
        public char[] keyStorePassword() {
            return secret.clone();
        }
    }
}
