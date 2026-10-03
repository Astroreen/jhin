package com.astroreen.jhin.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/**
 * Tests for {@link ApiVersion}: the plugin contract level stays at 1 (every
 * manifest pins {@code apiVersion: 1} — bumping it would reject every
 * existing plugin), while the SDUI wire contract and the client persisted
 * schema have their own named levels.
 */
class ApiVersionTest {

    @Test
    void pluginContractLevelIsUnchanged() {
        assertEquals(1, ApiVersion.CURRENT);
    }

    @Test
    void sduiWireContractLevelIsTwo() {
        assertEquals(2, ApiVersion.SDUI_CONTRACT);
    }

    @Test
    void clientSchemaLevelIsThree() {
        assertEquals(3, ApiVersion.CLIENT_SCHEMA);
    }
}
