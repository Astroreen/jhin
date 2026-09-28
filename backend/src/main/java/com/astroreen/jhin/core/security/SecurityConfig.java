package com.astroreen.jhin.core.security;

import com.astroreen.jhin.core.accounts.DeviceService;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

/**
 * Stateless bearer-цепочка без сессий, CSRF, formLogin и httpBasic. Анонимно открыты
 * {@code POST /enroll} и {@code GET /health} (плюс OPTIONS — клиентам без CORS), всё
 * остальное — authenticated. Порядок фильтров: {@link EnrollRateLimitFilter} →
 * {@link BearerTokenFilter} → UsernamePasswordAuthenticationFilter. Ошибки — JSON:
 * 401 {@code {"error":"unauthorized"}}, 403 {@code {"error":"forbidden"}}.
 */
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http, DeviceService deviceService)
            throws Exception {
        BearerTokenFilter bearerTokenFilter = new BearerTokenFilter(deviceService);
        http.csrf(csrf -> csrf.disable())
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .formLogin(formLogin -> formLogin.disable())
                .httpBasic(httpBasic -> httpBasic.disable())
                .logout(logout -> logout.disable())
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers(HttpMethod.POST, "/enroll").permitAll()
                        .requestMatchers(HttpMethod.GET, "/health").permitAll()
                        .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
                        .anyRequest().authenticated())
                .exceptionHandling(exceptions -> exceptions
                        .authenticationEntryPoint(
                                (request, response, authException) -> writeJsonError(response, 401, "{\"error\":\"unauthorized\"}"))
                        .accessDeniedHandler(
                                (request, response, accessDeniedException) -> writeJsonError(response, 403, "{\"error\":\"forbidden\"}")))
                .addFilterBefore(bearerTokenFilter, UsernamePasswordAuthenticationFilter.class)
                .addFilterBefore(new EnrollRateLimitFilter(), BearerTokenFilter.class);
        return http.build();
    }

    private static void writeJsonError(HttpServletResponse response, int status, String body) throws IOException {
        response.setStatus(status);
        response.setContentType("application/json");
        response.getWriter().write(body);
    }
}
