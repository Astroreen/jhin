package com.astroreen.jhin.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.astroreen.jhin.core.accounts.AccountService;
import com.astroreen.jhin.core.accounts.DeviceService;
import com.astroreen.jhin.core.accounts.EnrollmentService;
import com.astroreen.jhin.core.accounts.IssueResult;
import com.jayway.jsonpath.JsonPath;
import java.nio.file.Path;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.RequestPostProcessor;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

@SpringBootTest
class EnrollControllerTest {

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
    private EnrollmentService enrollments;

    @Autowired
    private DeviceService devices;

    @Autowired
    private JdbcClient jdbcClient;

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders.webAppContextSetup(context)
                .addFilters(springSecurityFilterChain)
                .build();
    }

    @Test
    void happyPathIssuesWorkingDeviceToken() throws Exception {
        String accountId = accounts.createAccount("alice");
        IssueResult issued = enrollments.issueEnrollment(accountId);

        MvcResult result = mockMvc.perform(post("/enroll")
                        .with(clientIp("10.0.0.1"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"code\":\"" + issued.code() + "\",\"deviceName\":\"phone\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.deviceToken").isNotEmpty())
                .andExpect(jsonPath("$.accountId").value(accountId))
                .andExpect(jsonPath("$.accountName").value("alice"))
                .andReturn();

        String deviceToken = JsonPath.read(result.getResponse().getContentAsString(), "$.deviceToken");
        assertThat(devices.lookup(deviceToken)).isPresent();
    }

    @Test
    void reusedCodeIsCodeUsed() throws Exception {
        String accountId = accounts.createAccount("bob");
        IssueResult issued = enrollments.issueEnrollment(accountId);
        String body = "{\"code\":\"" + issued.code() + "\",\"deviceName\":\"phone\"}";

        mockMvc.perform(post("/enroll")
                        .with(clientIp("10.0.0.2"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isOk());

        mockMvc.perform(post("/enroll")
                        .with(clientIp("10.0.0.2"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("code_used"));
    }

    @Test
    void expiredCodeIsCodeExpired() throws Exception {
        String accountId = accounts.createAccount("carol");
        IssueResult issued = enrollments.issueEnrollment(accountId);
        jdbcClient
                .sql("UPDATE enrollment_codes SET expires_at = ?")
                .param(System.currentTimeMillis() - 1)
                .update();

        mockMvc.perform(post("/enroll")
                        .with(clientIp("10.0.0.3"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"code\":\"" + issued.code() + "\",\"deviceName\":\"phone\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("code_expired"));
    }

    @Test
    void unknownCodeIsInvalidCode() throws Exception {
        mockMvc.perform(post("/enroll")
                        .with(clientIp("10.0.0.4"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"code\":\"JBSWY3DPEHPK3PXPJBSWY3DP\",\"deviceName\":\"phone\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("invalid_code"));
    }

    @Test
    void blankFieldsAreBadRequest() throws Exception {
        mockMvc.perform(post("/enroll")
                        .with(clientIp("10.0.0.5"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"code\":\"\",\"deviceName\":\"phone\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("bad_request"));

        mockMvc.perform(post("/enroll")
                        .with(clientIp("10.0.0.5"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"code\":\"JBSWY3DPEHPK3PXPJBSWY3DP\",\"deviceName\":\" \"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("bad_request"));

        mockMvc.perform(post("/enroll")
                        .with(clientIp("10.0.0.5"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"deviceName\":\"phone\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("bad_request"));
    }

    @Test
    void malformedJsonIsBadRequest() throws Exception {
        mockMvc.perform(post("/enroll")
                        .with(clientIp("10.0.0.6"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("bad_request"));
    }

    @Test
    void fourthRequestFromSameIpIsRateLimited() throws Exception {
        String body = "{\"code\":\"JBSWY3DPEHPK3PXPJBSWY3DP\",\"deviceName\":\"phone\"}";
        for (int i = 0; i < 3; i++) {
            mockMvc.perform(post("/enroll")
                            .with(clientIp("10.0.0.7"))
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(body))
                    .andExpect(status().isBadRequest());
        }

        mockMvc.perform(post("/enroll")
                        .with(clientIp("10.0.0.7"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isTooManyRequests())
                .andExpect(header().exists("Retry-After"))
                .andExpect(jsonPath("$.error").value("rate_limited"));
    }

    private static RequestPostProcessor clientIp(String ip) {
        return request -> {
            request.setRemoteAddr(ip);
            return request;
        };
    }
}
