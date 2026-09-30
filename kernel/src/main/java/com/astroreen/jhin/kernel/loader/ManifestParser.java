/**
 * Turns one raw {@code jhin-plugin.json} text into a validated
 * {@link PluginManifest}, and resolves duplicate plugin ids across jars.
 *
 * <p>Parsing never throws for bad input: every defect comes back as a
 * human-readable reason that names the offending field, so the caller can skip
 * exactly one jar and keep loading the rest. The contract level is enforced
 * here with the canonical reason {@code plugin <id> targets api <n>, kernel
 * provides <m>}.
 */
package com.astroreen.jhin.kernel.loader;

import com.astroreen.jhin.sdk.ApiVersion;
import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.PluginManifest;
import com.astroreen.jhin.sdk.VersionRange;
import com.astroreen.jhin.sdk.json.Json;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class ManifestParser {

    private static final Logger log = LoggerFactory.getLogger(ManifestParser.class);

    /**
     * Outcome of parsing one manifest text: either a manifest or the reason it
     * was rejected, never both.
     *
     * @param manifest      the parsed manifest, or {@code null} when rejected
     * @param failureReason why the text was rejected, or {@code null} when accepted
     */
    public record Result(PluginManifest manifest, String failureReason) {

        /**
         * @return {@code true} when a manifest was produced
         */
        public boolean accepted() {
            return manifest != null;
        }
    }

    /**
     * One accepted manifest together with the jar it was read from.
     *
     * @param jar      the jar the manifest came from
     * @param manifest the parsed and validated manifest
     */
    public record Candidate(Path jar, PluginManifest manifest) {}

    /**
     * Parses and validates one manifest text. The contract level is checked
     * first and rejected with the canonical reason; the remaining field rules
     * come from {@link PluginManifest#validate(PluginManifest)}.
     *
     * @param manifestJson the raw {@code jhin-plugin.json} text
     * @return the parse outcome; {@link Result#accepted()} tells them apart
     */
    public Result parse(String manifestJson) {
        PluginManifest manifest;
        try {
            manifest = Json.read(manifestJson, PluginManifest.class);
        } catch (PluginException e) {
            return new Result(null, "jhin-plugin.json is not valid JSON: " + e.getMessage());
        }
        if (manifest == null) {
            return new Result(null, "jhin-plugin.json is empty");
        }
        if (manifest.apiVersion() != ApiVersion.CURRENT) {
            return new Result(null, "plugin " + manifest.id() + " targets api " + manifest.apiVersion()
                    + ", kernel provides " + ApiVersion.CURRENT);
        }
        List<String> problems = PluginManifest.validate(manifest);
        if (!problems.isEmpty()) {
            return new Result(null, String.join("; ", problems));
        }
        return new Result(manifest, null);
    }

    /**
     * Parses every scanned jar and resolves duplicate ids: when two jars carry
     * the same id, the higher semantic version wins (numeric comparison, so
     * {@code 1.10.0} beats {@code 1.2.0}) and both jar names are logged. A tie
     * keeps the first jar in scan order. Rejected jars are logged and dropped.
     *
     * @param scanned the jars to parse, in scan order
     * @return the surviving candidates, one per distinct id, in scan order
     */
    public List<Candidate> parseAll(List<PluginScanner.ScannedJar> scanned) {
        Map<String, Candidate> byId = new LinkedHashMap<>();
        for (PluginScanner.ScannedJar entry : scanned) {
            Result result = parse(entry.manifestJson());
            if (!result.accepted()) {
                log.error("skipping {}: {}", entry.jar(), result.failureReason());
                continue;
            }
            PluginManifest manifest = result.manifest();
            Candidate previous = byId.get(manifest.id());
            if (previous == null) {
                byId.put(manifest.id(), new Candidate(entry.jar(), manifest));
                continue;
            }
            Candidate kept = previous;
            Candidate dropped = new Candidate(entry.jar(), manifest);
            if (compareVersions(manifest.version(), previous.manifest().version()) > 0) {
                kept = dropped;
                dropped = previous;
                byId.put(manifest.id(), kept);
            }
            log.warn("duplicate plugin id {} in {} and {}; keeping {}",
                    manifest.id(), kept.jar(), dropped.jar(), kept.jar());
        }
        return List.copyOf(byId.values());
    }

    /**
     * Compares two {@code major.minor.patch} versions numerically, the same
     * way {@link VersionRange} compares them.
     *
     * @param a the left version
     * @param b the right version
     * @return negative, zero or positive as {@code a} sorts before, with or
     *         after {@code b}
     */
    private static int compareVersions(String a, String b) {
        String[] left = a.split("\\.");
        String[] right = b.split("\\.");
        for (int i = 0; i < 3; i++) {
            int cmp = Long.compare(Long.parseLong(left[i]), Long.parseLong(right[i]));
            if (cmp != 0) {
                return cmp;
            }
        }
        return 0;
    }
}