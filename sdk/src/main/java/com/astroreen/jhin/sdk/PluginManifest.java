/**
 * Declarative identity of one plugin, parsed from its {@code jhin-plugin.json}.
 *
 * <p>Read by the kernel at plugin load before any class of the plugin runs;
 * also handed to the plugin itself through {@link PluginContext#manifest()}.
 * Every file carries the same fields; see {@link #validate(PluginManifest)} for
 * the load-time rules.
 */
package com.astroreen.jhin.sdk;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

public record PluginManifest(
        String id,              // reverse-dns-ish, [a-z0-9.\-]{3,64}, unique
        String version,         // semver x.y.z
        int apiVersion,         // must equal ApiVersion.CURRENT
        String name,
        String description,
        String mainClass,       // FQCN implementing JhinPlugin
        List<String> exports,   // package names visible to dependants
        List<Requirement> requires) {

    /**
     * One dependency on another plugin, declared by a plugin author and
     * resolved by the kernel before the depending plugin starts.
     *
     * @param id            id of the plugin that must be loaded
     * @param versionRange  acceptable versions; must match the versionRange
     *                      grammar ({@link VersionRange#parse(String)})
     * @param optional      {@code true} when the dependency may be missing at
     *                      load time
     */
    public record Requirement(String id, String versionRange, boolean optional) {}

    private static final Pattern ID_PATTERN = Pattern.compile("^[a-z0-9][a-z0-9.\\-]{2,63}$");
    private static final Pattern SEMVER_PATTERN = Pattern.compile("^\\d+\\.\\d+\\.\\d+$");
    private static final Pattern QUALIFIED_NAME_SEGMENT = Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]*");

    /**
     * Checks a manifest for load-time problems. Called by the kernel for every
     * {@code jhin-plugin.json} before the main class is instantiated. Never
     * throws: all defects are returned as problem strings; an empty list means
     * the manifest is loadable.
     *
     * <p>All problems are collected, not just the first one:
     * <ul>
     *   <li>{@code id} matches {@code ^[a-z0-9][a-z0-9.\-]{2,63}$}</li>
     *   <li>{@code version} matches {@code ^\d+\.\d+\.\d+$}</li>
     *   <li>{@code apiVersion} equals {@link ApiVersion#CURRENT}</li>
     *   <li>{@code mainClass} is a qualified Java class name and every
     *       {@code exports} entry is a qualified Java package name</li>
     *   <li>every {@code requires[].versionRange} matches the versionRange
     *       grammar ({@link VersionRange#parse(String)})</li>
     * </ul>
     *
     * <p>{@code null} {@code exports} or {@code requires} lists are treated as
     * empty.
     *
     * @param manifest the manifest to check
     * @return human-readable problems; empty when the manifest is loadable
     */
    public static List<String> validate(PluginManifest manifest) {
        List<String> problems = new ArrayList<>();
        if (manifest == null) {
            problems.add("manifest must not be null");
            return List.copyOf(problems);
        }
        if (manifest.id() == null || manifest.id().isBlank()) {
            problems.add("id must not be blank");
        } else if (!ID_PATTERN.matcher(manifest.id()).matches()) {
            problems.add("id '" + manifest.id() + "' does not match ^[a-z0-9][a-z0-9.\\-]{2,63}$");
        }
        if (manifest.version() == null || manifest.version().isBlank()) {
            problems.add("version must not be blank");
        } else if (!SEMVER_PATTERN.matcher(manifest.version()).matches()) {
            problems.add("version '" + manifest.version() + "' does not match ^\\d+\\.\\d+\\.\\d+$");
        }
        if (manifest.apiVersion() != ApiVersion.CURRENT) {
            problems.add("apiVersion " + manifest.apiVersion()
                    + " does not equal ApiVersion.CURRENT (" + ApiVersion.CURRENT + ")");
        }
        if (manifest.mainClass() == null || manifest.mainClass().isBlank()) {
            problems.add("mainClass must not be blank");
        } else if (!isQualifiedJavaName(manifest.mainClass())) {
            problems.add("mainClass '" + manifest.mainClass() + "' is not a qualified Java class name");
        }
        if (manifest.exports() != null) {
            for (int i = 0; i < manifest.exports().size(); i++) {
                String pkg = manifest.exports().get(i);
                if (pkg == null || !isQualifiedJavaName(pkg)) {
                    problems.add("exports[" + i + "] '" + pkg + "' is not a qualified Java package name");
                }
            }
        }
        if (manifest.requires() != null) {
            for (int i = 0; i < manifest.requires().size(); i++) {
                Requirement requirement = manifest.requires().get(i);
                if (requirement == null) {
                    problems.add("requires[" + i + "] must not be null");
                    continue;
                }
                try {
                    VersionRange.parse(requirement.versionRange());
                } catch (PluginException e) {
                    problems.add("requires[" + i + "].versionRange is invalid: " + e.getMessage());
                }
            }
        }
        return List.copyOf(problems);
    }

    private static boolean isQualifiedJavaName(String name) {
        String[] segments = name.split("\\.", -1);
        for (String segment : segments) {
            if (!QUALIFIED_NAME_SEGMENT.matcher(segment).matches()) {
                return false;
            }
        }
        return true;
    }
}
