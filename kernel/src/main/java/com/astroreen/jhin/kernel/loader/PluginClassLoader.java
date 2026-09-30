/**
 * Class loader of a single plugin. Implements the five-step lookup order of
 * the plugin contract and nothing else ever falls through to the kernel
 * loader, so a plugin can never reach kernel internals.
 *
 * <p>Lookup order for a class name:
 * <ol>
 *   <li>already loaded through this loader → return it;</li>
 *   <li>a name under one of the shared prefixes → the kernel loader;</li>
 *   <li>a package exported by a direct or transitive dependency → the loaders
 *       of those dependencies, consulted in topological order;</li>
 *   <li>this plugin's own jar;</li>
 *   <li>otherwise a {@link ClassNotFoundException} whose text names the
 *       plugin, the class and every package name the plugin can see.</li>
 * </ol>
 * A package matches an export when it equals the export or is one of its
 * sub-packages. Resources follow the same order: shared prefixes go to the
 * kernel loader, a resource whose package some dependency exports comes from
 * the dependency jars (own entries only, in topological order) and only then
 * from the plugin's own jar. When several dependencies export the same
 * package the ambiguity is logged and the first match in topological order
 * wins. {@link #close()} is idempotent.
 */
package com.astroreen.jhin.kernel.loader;

import java.io.IOException;
import java.net.URL;
import java.net.URLClassLoader;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.atomic.AtomicBoolean;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class PluginClassLoader extends URLClassLoader {

    private static final Logger log = LoggerFactory.getLogger(PluginClassLoader.class);

    /**
     * Class-name prefixes shared between the plugin and the kernel loader:
     * the plugin contract and the class-path libraries a plugin must share
     * with the host.
     */
    private static final List<String> SHARED_PREFIXES = List.of(
            "com.astroreen.jhin.sdk.",
            "java.",
            "javax.",
            "jakarta.",
            "org.slf4j.",
            "com.fasterxml.jackson.");

    /** Path form of {@link #SHARED_PREFIXES} for resource lookups. */
    private static final List<String> SHARED_RESOURCE_PREFIXES = List.of(
            "com/astroreen/jhin/sdk/",
            "java/",
            "javax/",
            "jakarta/",
            "org/slf4j/",
            "com/fasterxml/jackson/");

    static {
        registerAsParallelCapable();
    }

    private final String pluginId;
    private final List<String> exports;
    private final List<PluginClassLoader> visible;
    private final AtomicBoolean closed = new AtomicBoolean();

    /**
     * Creates a loader for one plugin jar.
     *
     * @param pluginId     the plugin id, used in failure text
     * @param urls         the plugin jar
     * @param kernelLoader the kernel loader; shared prefixes delegate here
     * @param exports      packages this plugin exposes to its dependants
     * @param deps         direct dependencies in topological order; the
     *                     transitive ones are pulled in automatically
     */
    public PluginClassLoader(String pluginId, URL[] urls, ClassLoader kernelLoader,
            Collection<String> exports, List<PluginClassLoader> deps) {
        super(urls, Objects.requireNonNull(kernelLoader, "kernelLoader"));
        this.pluginId = Objects.requireNonNull(pluginId, "pluginId");
        this.exports = List.copyOf(exports == null ? List.of() : exports);
        this.visible = flatten(deps == null ? List.of() : deps);
    }

    /**
     * @return the plugin id
     */
    public String pluginId() {
        return pluginId;
    }

    /**
     * @return the packages this plugin exposes to its dependants
     */
    public List<String> exports() {
        return exports;
    }

    @Override
    protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
        synchronized (getClassLoadingLock(name)) {
            Class<?> type = findLoadedClass(name);
            if (type == null) {
                type = search(name);
            }
            if (resolve) {
                resolveClass(type);
            }
            return type;
        }
    }

    @Override
    public URL getResource(String name) {
        if (isSharedResource(name)) {
            return kernelLoader().getResource(name);
        }
        for (PluginClassLoader dep : matchingExporters(resourcePackage(name))) {
            URL found = dep.findResource(name);
            if (found != null) {
                return found;
            }
        }
        return findResource(name);
    }

    @Override
    public Enumeration<URL> getResources(String name) throws IOException {
        if (isSharedResource(name)) {
            return kernelLoader().getResources(name);
        }
        List<URL> all = new ArrayList<>();
        for (PluginClassLoader dep : matchingExporters(resourcePackage(name))) {
            all.addAll(Collections.list(dep.findResources(name)));
        }
        all.addAll(Collections.list(findResources(name)));
        return Collections.enumeration(all);
    }

    @Override
    public void close() throws IOException {
        if (closed.compareAndSet(false, true)) {
            super.close();
        }
    }

    /**
     * Runs the delegation steps 2-4 of the lookup order for one class name.
     */
    private Class<?> search(String name) throws ClassNotFoundException {
        if (isSharedClass(name)) {
            return kernelLoader().loadClass(name);
        }
        for (PluginClassLoader dep : matchingExporters(packageName(name))) {
            try {
                return dep.loadClass(name, false);
            } catch (ClassNotFoundException absent) {
                // first match wins only among the loaders that see the name
            }
        }
        try {
            return findClass(name);
        } catch (ClassNotFoundException absent) {
            throw new ClassNotFoundException(cannotSee(name));
        }
    }

    /**
     * Dependency loaders whose exports cover the given package, in
     * topological order. A package claimed by several of them is ambiguous:
     * the ambiguity is logged once per lookup and the first match wins.
     */
    private List<PluginClassLoader> matchingExporters(String pkg) {
        List<PluginClassLoader> matched = new ArrayList<>();
        for (PluginClassLoader dep : visible) {
            if (dep.exportsPackage(pkg)) {
                matched.add(dep);
            }
        }
        if (matched.size() > 1) {
            List<String> ids = new ArrayList<>();
            for (PluginClassLoader dep : matched) {
                ids.add(dep.pluginId);
            }
            log.warn("package {} is exported by multiple dependencies: {}; "
                    + "first match in topological order wins", pkg, String.join(", ", ids));
        }
        return matched;
    }

    /**
     * @return {@code true} when the plugin exposes the given package, either
     *         directly or as a sub-package of one of its exports
     */
    private boolean exportsPackage(String pkg) {
        for (String export : exports) {
            if (pkg.equals(export) || pkg.startsWith(export + ".")) {
                return true;
            }
        }
        return false;
    }

    /**
     * Builds the failure text of a name this plugin cannot see: the plugin,
     * the class and the sorted union of every package the dependencies export
     * (or {@code (none)} when nothing is visible).
     */
    private String cannotSee(String name) {
        Set<String> visibleExports = new TreeSet<>();
        for (PluginClassLoader dep : visible) {
            visibleExports.addAll(dep.exports);
        }
        return "plugin " + pluginId + " cannot see " + name + "; visible exports: "
                + (visibleExports.isEmpty() ? "(none)" : String.join(", ", visibleExports));
    }

    private ClassLoader kernelLoader() {
        return getParent();
    }

    /**
     * Flattens direct dependencies (already in topological order) with their
     * transitive ones into one stable topological list: every dependency
     * brings its own dependencies first, then itself.
     */
    private static List<PluginClassLoader> flatten(List<PluginClassLoader> direct) {
        Set<PluginClassLoader> ordered = new LinkedHashSet<>();
        for (PluginClassLoader dep : direct) {
            ordered.addAll(dep.visible);
            ordered.add(dep);
        }
        return List.copyOf(ordered);
    }

    private static boolean isSharedClass(String name) {
        for (String prefix : SHARED_PREFIXES) {
            if (name.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    private static boolean isSharedResource(String path) {
        for (String prefix : SHARED_RESOURCE_PREFIXES) {
            if (path.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    private static String packageName(String className) {
        int cut = className.lastIndexOf('.');
        return cut < 0 ? "" : className.substring(0, cut);
    }

    private static String resourcePackage(String path) {
        int cut = path.lastIndexOf('/');
        return cut < 0 ? "" : path.substring(0, cut).replace('/', '.');
    }
}
