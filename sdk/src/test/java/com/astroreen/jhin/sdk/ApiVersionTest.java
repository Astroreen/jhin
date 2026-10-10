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
    void sduiWireContractLevelIsFour() {
        assertEquals(4, ApiVersion.SDUI_CONTRACT);
    }

    @Test
    void sduiWireContractHasNoDowngradePath() {
        assertEquals(4, ApiVersion.SDUI_CONTRACT_MIN);
        assertEquals(ApiVersion.SDUI_CONTRACT, ApiVersion.SDUI_CONTRACT_MIN);
    }

    @Test
    void clientSchemaLevelIsFive() {
        assertEquals(5, ApiVersion.CLIENT_SCHEMA);
        assertEquals(5, ApiVersion.CLIENT_SCHEMA_MIN);
    }
}
