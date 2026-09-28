package com.astroreen.jhin.core.accounts;

/** Отказ погашения enrollment-кода: {@link Reason} различает INVALID | USED | EXPIRED. */
public class EnrollmentException extends RuntimeException {

    public enum Reason {
        INVALID,
        USED,
        EXPIRED
    }

    private final Reason reason;

    public EnrollmentException(Reason reason, String message) {
        super(message);
        this.reason = reason;
    }

    public Reason reason() {
        return reason;
    }
}
