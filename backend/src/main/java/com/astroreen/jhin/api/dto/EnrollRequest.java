package com.astroreen.jhin.api.dto;

/** Тело {@code POST /enroll}: одноразовый enrollment-код и имя нового устройства. */
public record EnrollRequest(String code, String deviceName) {}
