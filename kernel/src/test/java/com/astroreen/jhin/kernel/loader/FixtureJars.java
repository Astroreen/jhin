package com.astroreen.jhin.kernel.loader;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;
import java.util.stream.Stream;
import javax.tools.JavaCompiler;
import javax.tools.ToolProvider;

/**
 * Test-only builder of fixture jars: compiles the given sources in memory
 * with the JDK compiler and packs the resulting class entries plus the plain
 * resources into a jar under one work directory. No external binaries
 * involved. The compiler resolves imports against the running test class path,
 * so fixture sources may implement the SDK contracts.
 */
final class FixtureJars {

    private static final JavaCompiler COMPILER = ToolProvider.getSystemJavaCompiler();

    private final Path work;

    /** Names of every built jar, kept for evidence listings. */
    private final List<String> built = new ArrayList<>();

    FixtureJars(Path work) {
        this.work = work;
    }

    /**
     * Descriptions of every built jar, in build order.
     *
     * @return one line per jar
     */
    List<String> built() {
        return List.copyOf(built);
    }

    /**
     * Source of one marker class: a public class with a static {@code marker()}
     * returning the marker text.
     *
     * @param pkg        the package name
     * @param simpleName the class name
     * @param marker     the text returned by {@code marker()}
     * @return the compilation unit
     */
    static String classSource(String pkg, String simpleName, String marker) {
        return "package " + pkg + ";\n"
                + "public class " + simpleName + " {\n"
                + "    public static String marker() { return \"" + marker + "\"; }\n"
                + "}\n";
    }

    /**
     * Builds one jar without sources and without resources.
     *
     * @param name the fixture name, also the jar base name
     * @return the jar file
     * @throws IOException when the jar cannot be written
     */
    Path emptyJar(String name) throws IOException {
        return jarOf(name, Map.of(), Map.of());
    }

    /**
     * Builds one fixture jar: compiles the given sources and packs the
     * resulting class entries plus the plain resources into a jar under the
     * work dir.
     *
     * @param name      the fixture name, also the jar base name
     * @param sources   fully qualified class name to compilation unit
     * @param resources jar entry path to its text content
     * @return the jar file
     * @throws IOException when the jar cannot be written
     */
    Path jarOf(String name, Map<String, String> sources, Map<String, String> resources)
            throws IOException {
        Path srcDir = work.resolve(name + "-src");
        Path clsDir = work.resolve(name + "-classes");
        List<String> args = new ArrayList<>(List.of("-d", clsDir.toString(),
                "-classpath", System.getProperty("java.class.path")));
        for (String fqcn : new TreeSet<>(sources.keySet())) {
            Path file = srcDir.resolve(fqcn.replace('.', '/') + ".java");
            Files.createDirectories(file.getParent());
            Files.writeString(file, sources.get(fqcn));
            args.add(file.toString());
        }
        if (!sources.isEmpty()) {
            int exit = COMPILER.run(null, null,
                    Files.newOutputStream(work.resolve(name + "-javac.txt")),
                    args.toArray(String[]::new));
            assertThat(exit).as("javac exit for " + name).isZero();
        }
        Path jar = work.resolve(name + ".jar");
        try (JarOutputStream out = new JarOutputStream(Files.newOutputStream(jar))) {
            if (Files.isDirectory(clsDir)) {
                try (Stream<Path> walk = Files.walk(clsDir)) {
                    for (Path entry : walk.filter(Files::isRegularFile).sorted().toList()) {
                        out.putNextEntry(new JarEntry(
                                clsDir.relativize(entry).toString().replace(java.io.File.separatorChar, '/')));
                        out.write(Files.readAllBytes(entry));
                        out.closeEntry();
                    }
                }
            }
            for (String path : new TreeSet<>(resources.keySet())) {
                out.putNextEntry(new JarEntry(path));
                out.write(resources.get(path).getBytes(StandardCharsets.UTF_8));
                out.closeEntry();
            }
        }
        built.add(name + ".jar classes=" + new TreeSet<>(sources.keySet())
                + " resources=" + new TreeSet<>(resources.keySet()));
        return jar;
    }
}
