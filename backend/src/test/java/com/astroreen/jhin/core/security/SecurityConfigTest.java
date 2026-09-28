package com.astroreen.jhin.core.security;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.astroreen.jhin.core.accounts.AccountService;
import com.astroreen.jhin.core.accounts.DeviceService;
import com.astroreen.jhin.core.accounts.IssuedDevice;
import java.nio.file.Path;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;
import org.springframework.web.servlet.function.RouterFunction;
import org.springframework.web.servlet.function.RouterFunctions;
import org.springframework.web.servlet.function.ServerResponse;

@SpringBootTest
class SecurityConfigTest {

    @TempDir
    static Path jhinHome;

    @DynamicPropertySource
    static void jhinHomeProperties(DynamicPropertyRegistry registry) {
        registry.add("jhin.home", jhinHome::toString);
    }

    @Autowired
    private WebApplicationContext context;

    @Autowired
    private FilterChainProxy springSecurityFilterChain;

    @Autowired
    private AccountService accounts;

    @Autowired
    private DeviceService devices;

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders.webAppContextSetup(context)
                .addFilters(springSecurityFilterChain)
                .build();
    }

    @TestConfiguration
    static class ProtectedStubConfiguration {

        @Bean
        RouterFunction<ServerResponse> protectedStub() {
            return RouterFunctions.route()
                    .GET("/api/protected-stub", request -> ServerResponse.ok().body("ok"))
                    .build();
        }
    }

    @Test
    void healthIsAnonymous() throws Exception {
        mockMvc.perform(get("/health"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("UP"));
    }

    @Test
    void protectedStubWithoutTokenIsUnauthorized() throws Exception {
        mockMvc.perform(get("/api/protected-stub"))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentType("application/json"))
                .andExpect(jsonPath("$.error").value("unauthorized"));
    }

    @Test
    void protectedStubWithGarbageTokenIsUnauthorized() throws Exception {
        mockMvc.perform(get("/api/protected-stub").header("Authorization", "Bearer garbage"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error").value("unauthorized"));
    }

    @Test
    void protectedStubWithValidDeviceTokenIsAuthenticated() throws Exception {
        IssuedDevice device = issueDevice("alice");

        mockMvc.perform(get("/api/protected-stub").header("Authorization", "Bearer " + device.token()))
                .andExpect(status().isOk())
                .andExpect(content().string("ok"));
    }

    @Test
    void protectedStubWithRevokedDeviceTokenIsUnauthorized() throws Exception {
        IssuedDevice device = issueDevice("bob");
        devices.revokeDevice(device.id());

        mockMvc.perform(get("/api/protected-stub").header("Authorization", "Bearer " + device.token()))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error").value("unauthorized"));
    }

    @Test
    void protectedStubWithMalformedAuthorizationHeaderIsUnauthorized() throws Exception {
        mockMvc.perform(get("/api/protected-stub").header("Authorization", "Basic xx"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error").value("unauthorized"));
    }

    private IssuedDevice issueDevice(String name) {
        String accountId = accounts.createAccount(name);
        return devices.issueDevice(accountId, name + "-laptop");
    }
}
