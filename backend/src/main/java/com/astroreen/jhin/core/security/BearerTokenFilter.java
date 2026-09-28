package com.astroreen.jhin.core.security;

import com.astroreen.jhin.core.accounts.DevicePrincipal;
import com.astroreen.jhin.core.accounts.DeviceService;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import java.util.Optional;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Stateless bearer-аутентификация device-токенами: без сессий, кук и JWT.
 *
 * <p>Заголовок {@code Authorization} отсутствует — запрос идёт дальше анонимным (public-роуты
 * открыты, защищённые отдаст 401 entry point). Заголовок есть, но схема/токен битые или
 * {@link DeviceService#lookup} пуст (неизвестный или отозванный) — сразу 401, плохие креды
 * не деградируют до анонимного доступа. Валидный токен — touch {@code last_seen/last_ip} и
 * {@link SecurityContext} с {@link DevicePrincipal} (ROLE_DEVICE); контроллеры достают
 * principal через {@link #currentDevice()}.
 */
public class BearerTokenFilter extends OncePerRequestFilter {

    public static final String AUTHORIZATION_HEADER = "Authorization";
    public static final String BEARER_PREFIX = "Bearer ";
    public static final String ROLE_DEVICE = "ROLE_DEVICE";

    private final DeviceService deviceService;

    public BearerTokenFilter(DeviceService deviceService) {
        this.deviceService = deviceService;
    }

    /** Устройство текущего запроса (пусто для анонимных запросов). */
    public static Optional<DevicePrincipal> currentDevice() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication != null && authentication.getPrincipal() instanceof DevicePrincipal device) {
            return Optional.of(device);
        }
        return Optional.empty();
    }

    @Override
    protected void doFilterInternal(
            HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {
        String header = request.getHeader(AUTHORIZATION_HEADER);
        if (header == null) {
            filterChain.doFilter(request, response);
            return;
        }
        Optional<DevicePrincipal> device = lookup(header);
        if (device.isEmpty()) {
            unauthorized(response);
            return;
        }
        DevicePrincipal principal = device.get();
        deviceService.touch(principal.id(), request.getRemoteAddr());
        SecurityContext context = SecurityContextHolder.createEmptyContext();
        context.setAuthentication(UsernamePasswordAuthenticationToken.authenticated(
                principal, null, List.of(new SimpleGrantedAuthority(ROLE_DEVICE))));
        SecurityContextHolder.setContext(context);
        filterChain.doFilter(request, response);
    }

    private Optional<DevicePrincipal> lookup(String header) {
        if (!header.regionMatches(true, 0, BEARER_PREFIX, 0, BEARER_PREFIX.length())) {
            return Optional.empty();
        }
        String token = header.substring(BEARER_PREFIX.length()).strip();
        return token.isEmpty() ? Optional.empty() : deviceService.lookup(token);
    }

    private static void unauthorized(HttpServletResponse response) throws IOException {
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType("application/json");
        response.getWriter().write("{\"error\":\"unauthorized\"}");
    }
}
