/**
 * Entry point of the kernel: dispatches the command-line verb and drives the
 * server path.
 *
 * <p>{@code cli} as the first argument selects the command-line path: the
 * full boot sequence of {@link KernelBoot} minus the web listener, one
 * dispatched command, and the exit code of its handler. Every other
 * invocation is the server path: the same boot followed by the web listener.
 * A boot failure on either path is reported as one {@code fatal:} line on the
 * error stream and exits with 1.
 *
 * <p>The Spring wiring below hands the web server the registries the boot
 * sequence filled: while a boot runs they are served as the pre-built
 * singletons, and outside the server path (tests) fresh empty ones are
 * created instead. The listener address and port come from the kernel
 * configuration and not from literals, so the defaults live in one place.
 */
package com.astroreen.jhin.kernel;

import com.astroreen.jhin.kernel.cli.CliDispatcher;
import com.astroreen.jhin.kernel.http.HttpRegistryImpl;
import java.lang.reflect.InvocationTargetException;
import java.util.Arrays;
import java.util.List;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.servlet.autoconfigure.MultipartAutoConfiguration;
import org.springframework.boot.webmvc.autoconfigure.DispatcherServletAutoConfiguration;
import org.springframework.boot.webmvc.autoconfigure.error.ErrorMvcAutoConfiguration;
import org.springframework.context.annotation.Bean;

@SpringBootApplication(exclude = {
        DispatcherServletAutoConfiguration.class,
        ErrorMvcAutoConfiguration.class,
        MultipartAutoConfiguration.class
})
public class KernelMain {

    /** The first-argument verb selecting the command-line path. */
    private static final String CLI_VERB = "cli";

    /**
     * Dispatches between the two paths and turns any boot failure into one
     * fatal line. Called by the JVM.
     *
     * @param args command-line arguments; {@code cli} selects the
     *             command-line path, everything else the server path
     */
    public static void main(String[] args) {
        try {
            if (args.length > 0 && CLI_VERB.equals(args[0])) {
                System.exit(runCli(Arrays.copyOfRange(args, 1, args.length)));
            }
            runServer(args);
        } catch (Throwable failure) {
            System.err.println("fatal: " + describe(failure));
            System.exit(1);
        }
    }

    /**
     * The command-line path: boot everything except the web listener, run the
     * on-started hooks, dispatch one command and close the boot again.
     *
     * @param args the arguments after the {@code cli} verb
     * @return the process exit code
     */
    private static int runCli(String[] args) {
        KernelBoot boot = KernelBoot.open();
        try {
            boot.runStartedHooks();
            return CliDispatcher.dispatch(boot.commands(), List.of(args), System.out, System.err);
        } finally {
            boot.close();
        }
    }

    /**
     * The server path: the full boot sequence including the web listener.
     *
     * @param args command-line arguments passed on to the web server
     */
    private static void runServer(String[] args) {
        KernelBoot.open().serve(args);
    }

    /**
     * The HTTP registry: the pre-built one of the running boot, filled with
     * the kernel fallbacks and the plugin registrations, or a fresh empty one
     * with the fallbacks while no boot runs.
     *
     * @return the registry singleton
     */
    @Bean
    public HttpRegistryImpl httpRegistry() {
        KernelBoot boot = KernelBoot.active();
        if (boot != null) {
            return boot.http();
        }
        HttpRegistryImpl registry = new HttpRegistryImpl();
        KernelRoutes.install(registry);
        return registry;
    }

    /**
     * The detail of a boot failure: the deepest cause's text, or its class
     * name when it carries none.
     */
    private static String describe(Throwable failure) {
        Throwable cause = failure;
        while (cause instanceof InvocationTargetException && cause.getCause() != null) {
            cause = cause.getCause();
        }
        String text = cause.getMessage();
        return (text == null || text.isBlank()) ? cause.getClass().getName() : text;
    }
}
