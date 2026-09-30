/**
 * Wires the servlet bridge into the embedded web server.
 *
 * <p>Registers the kernel servlet on {@code /*} with load-on-startup so every
 * request reaches the route table. The auto-configurations that would
 * otherwise claim the exchange — the dispatcher servlet, the error pages and
 * the multipart resolver — are excluded on the application class instead.
 */
package com.astroreen.jhin.kernel.http;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.web.servlet.ServletRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class WebConfig {

    /**
     * Registers the kernel servlet on {@code /*}. Called once at startup;
     * when the stream layer registered an {@link SseHandoff} bean it is
     * handed to the servlet, otherwise SSE-marked answers fail with a
     * {@code 500}.
     *
     * @param registry   the registry holding the routes and filters
     * @param sseHandoff the streaming seam, empty while the stream layer is absent
     * @return the servlet registration
     */
    @Bean
    public ServletRegistrationBean<JhinServlet> jhinServlet(HttpRegistryImpl registry,
            ObjectProvider<SseHandoff> sseHandoff) {
        JhinServlet servlet = new JhinServlet(registry, sseHandoff.getIfAvailable());
        ServletRegistrationBean<JhinServlet> registration = new ServletRegistrationBean<>(servlet, "/*");
        registration.setLoadOnStartup(1);
        return registration;
    }
}
