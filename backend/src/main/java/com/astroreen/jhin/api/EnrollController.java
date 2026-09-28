package com.astroreen.jhin.api;

import com.astroreen.jhin.api.dto.ApiError;
import com.astroreen.jhin.api.dto.EnrollRequest;
import com.astroreen.jhin.api.dto.EnrollResponse;
import com.astroreen.jhin.core.accounts.Account;
import com.astroreen.jhin.core.accounts.AccountService;
import com.astroreen.jhin.core.accounts.DeviceService;
import com.astroreen.jhin.core.accounts.EnrollResult;
import com.astroreen.jhin.core.accounts.EnrollmentException;
import com.astroreen.jhin.core.accounts.EnrollmentException.Reason;
import com.astroreen.jhin.core.accounts.EnrollmentService;
import com.astroreen.jhin.core.accounts.IssuedDevice;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code POST /enroll} — погашение enrollment-кода в обмен на device-токен (анонимный роут,
 * permitAll). Plaintext токена живёт только в ответе (нигде не сохраняется и не логируется).
 * Ошибки — JSON: 400 {@code {"error":"bad_request"|"invalid_code"|"code_used"|"code_expired"}}.
 * 429 обрабатывает {@link com.astroreen.jhin.core.security.EnrollRateLimitFilter} до контроллера.
 */
@RestController
public class EnrollController {

    private final EnrollmentService enrollmentService;
    private final DeviceService deviceService;
    private final AccountService accountService;

    @Autowired
    public EnrollController(EnrollmentService enrollmentService, DeviceService deviceService, AccountService accountService) {
        this.enrollmentService = enrollmentService;
        this.deviceService = deviceService;
        this.accountService = accountService;
    }

    @PostMapping("/enroll")
    public ResponseEntity<?> enroll(@RequestBody EnrollRequest request) {
        if (request == null || isBlank(request.code()) || isBlank(request.deviceName())) {
            return ResponseEntity.badRequest().body(new ApiError("bad_request"));
        }
        EnrollResult enrollResult = enrollmentService.consumeEnrollment(request.code());
        IssuedDevice device = deviceService.issueDevice(enrollResult.accountId(), request.deviceName());
        Account account = accountService.findById(enrollResult.accountId()).orElseThrow();
        return ResponseEntity.ok(new EnrollResponse(device.token(), account.id(), account.name()));
    }

    @ExceptionHandler(EnrollmentException.class)
    public ResponseEntity<ApiError> onEnrollmentException(EnrollmentException exception) {
        return ResponseEntity.badRequest().body(new ApiError(errorCode(exception.reason())));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ApiError> onUnreadableBody(HttpMessageNotReadableException exception) {
        return ResponseEntity.badRequest().body(new ApiError("bad_request"));
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private static String errorCode(Reason reason) {
        return switch (reason) {
            case INVALID -> "invalid_code";
            case USED -> "code_used";
            case EXPIRED -> "code_expired";
        };
    }
}
