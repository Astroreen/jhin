/**
 * Wires the stream layer into the application context.
 *
 * <p>Registers the stream registry as the singleton that answers the SDK
 * stream contract and the kernel's SSE hand-off seam; the web wiring looks
 * the hand-off up as a bean and installs it in the response writer.
 */
package com.astroreen.jhin.kernel.stream;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class StreamConfig {

    /**
     * The stream registry singleton. Called once at startup; it serves
     * publishing, subscribing and every SSE connection of this kernel.
     *
     * @return the registry
     */
    @Bean
    public StreamRegistryImpl streamRegistry() {
        return new StreamRegistryImpl();
    }
}
