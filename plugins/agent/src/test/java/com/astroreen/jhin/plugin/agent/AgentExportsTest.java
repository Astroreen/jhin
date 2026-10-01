/**
 * Proves the export boundary of the agent plugin through the kernel's real
 * {@link PluginClassLoader}: the exported API package resolves for
 * dependants, while a class that reaches for a non-exported agent class fails
 * at runtime with the production {@link ClassNotFoundException} message
 * naming the plugin.
 *
 * <p>The scratch consumer is the compiled test helper
 * {@code com.scratch.ScratchTool}, which imports and extends the
 * non-exported entry point {@code AgentPlugin} and references
 * {@code AgentLoop} in a method signature (T33 references
 * {@code com.astroreen.jhin.plugin.agent.AgentLoop} the way the plan originally
 * named it); T33 extends this test with the direct {@code AgentLoop}
 * assertion. The expected failure text is the one {@code PluginClassLoader}
 * produces: {@code plugin <id> cannot see <class>; visible exports:
 * <packages>}.
 */
package com.astroreen.jhin.plugin.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowable;

import com.astroreen.jhin.kernel.loader.PluginClassLoader;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class AgentExportsTest {

    private static final String API_PACKAGE = "com.astroreen.jhin.plugin.agent.api";
    private static final String AGENT_PLUGIN_CLASS = "com.astroreen.jhin.plugin.agent.AgentPlugin";
    private static final String AGENT_LOOP_CLASS = "com.astroreen.jhin.plugin.agent.AgentLoop";
    private static final String SCRATCH_CLASS = "com.scratch.ScratchTool";
    private static final String CONSUMER_PLUGIN_ID = "jhin.scratch";

    /** The exact production message the kernel class loader throws. */
    private static final String EXPECTED_CNFE = "plugin " + CONSUMER_PLUGIN_ID
            + " cannot see " + AGENT_PLUGIN_CLASS
            + "; visible exports: " + API_PACKAGE;

    /** The same production message for the non-exported agent loop. */
    private static final String EXPECTED_CNFE_LOOP = "plugin " + CONSUMER_PLUGIN_ID
            + " cannot see " + AGENT_LOOP_CLASS
            + "; visible exports: " + API_PACKAGE;

    @TempDir
    static Path work;

    private PluginClassLoader agentLoader;
    private PluginClassLoader consumerLoader;

    @AfterEach
    void closeLoaders() throws IOException {
        if (consumerLoader != null) {
            consumerLoader.close();
        }
        if (agentLoader != null) {
            agentLoader.close();
        }
    }

    // (1) the exported api package crosses the plugin boundary and is shared
    @Test
    void exportedApiClassIsSharedAcrossTheBoundary() throws Exception {
        openLoaders();
        Class<?> viaAgent = agentLoader.loadClass(API_PACKAGE + ".ToolProvider");
        Class<?> viaConsumer = consumerLoader.loadClass(API_PACKAGE + ".ToolProvider");
        assertThat(viaConsumer).isSameAs(viaAgent);
        assertThat(viaConsumer.getClassLoader()).isSameAs(agentLoader);
    }

    // (2) the scratch consumer importing the non-exported entry point fails
    @Test
    void scratchConsumerImportingNonExportedClassFailsAtRuntime() throws Exception {
        openLoaders();
        Throwable ex = catchThrowable(() -> consumerLoader.loadClass(SCRATCH_CLASS));
        assertThat(ex).isInstanceOf(NoClassDefFoundError.class);
        assertThat(ex.getCause())
                .isInstanceOf(ClassNotFoundException.class)
                .hasMessage(EXPECTED_CNFE)
                .hasMessageContaining("plugin", CONSUMER_PLUGIN_ID, AGENT_PLUGIN_CLASS);
    }

    // (3) a direct lookup of the non-exported class throws the production CNFE
    @Test
    void nonExportedAgentClassThrowsTheProductionCnfe() throws Exception {
        openLoaders();
        assertThatThrownBy(() -> consumerLoader.loadClass(AGENT_PLUGIN_CLASS))
                .isInstanceOf(ClassNotFoundException.class)
                .hasMessage(EXPECTED_CNFE);
    }

    // (4) the same boundary for the agent loop the plan originally named
    @Test
    void nonExportedAgentLoopThrowsTheProductionCnfe() throws Exception {
        openLoaders();
        assertThatThrownBy(() -> consumerLoader.loadClass(AGENT_LOOP_CLASS))
                .isInstanceOf(ClassNotFoundException.class)
                .hasMessage(EXPECTED_CNFE_LOOP)
                .hasMessageContaining("plugin", CONSUMER_PLUGIN_ID, "AgentLoop");
    }

    /**
     * Builds the two loaders of the boundary under test: the agent plugin
     * (its own compiled classes, exports the api package) and the scratch
     * consumer (a fixture jar with one class, depends on the agent loader).
     */
    private void openLoaders() throws IOException {
        URL agentClasses = AgentPlugin.class.getProtectionDomain()
                .getCodeSource().getLocation();
        agentLoader = new PluginClassLoader("jhin.agent", new URL[] {agentClasses},
                getClass().getClassLoader(), List.of(API_PACKAGE), List.of());
        consumerLoader = new PluginClassLoader(CONSUMER_PLUGIN_ID,
                new URL[] {scratchJar().toUri().toURL()},
                getClass().getClassLoader(), List.of(), List.of(agentLoader));
    }

    /**
     * Packs the compiled scratch consumer helper into a fixture jar, the way
     * a dependant plugin jar would ship its own classes.
     */
    private static Path scratchJar() throws IOException {
        Path jar = work.resolve("scratch-consumer.jar");
        try (InputStream in = AgentExportsTest.class.getClassLoader()
                .getResourceAsStream("com/scratch/ScratchTool.class");
                JarOutputStream out = new JarOutputStream(Files.newOutputStream(jar))) {
            assertThat(in).as("compiled ScratchTool.class").isNotNull();
            out.putNextEntry(new JarEntry("com/scratch/ScratchTool.class"));
            out.write(in.readAllBytes());
            out.closeEntry();
        }
        return jar;
    }
}
