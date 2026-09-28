package com.astroreen.jhin.core.events;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;

public record Event(String sessionId, long seq, long ts, String type, JsonNode payload) {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final TypeReference<Map<String, Object>> MAP_TYPE = new TypeReference<>() {};

    public Map<String, Object> payloadAsMap() {
        if (payload == null || payload.isNull() || payload.isMissingNode()) {
            return null;
        }
        return MAPPER.convertValue(payload, MAP_TYPE);
    }
}
