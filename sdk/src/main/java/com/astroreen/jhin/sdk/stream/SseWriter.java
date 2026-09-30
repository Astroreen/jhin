/**
 * Writes events to one SSE stream.
 *
 * <p>Handed to {@link SsePreamble#write(SseWriter)} and implemented by the
 * kernel's SSE machinery. Valid only for the duration of the preamble call.
 */
package com.astroreen.jhin.sdk.stream;

import java.io.IOException;

public interface SseWriter {

    /**
     * Writes one event to the stream. Called by the plugin while replaying its
     * history during the preamble.
     *
     * @param type    the event type discriminator
     * @param payload the event body, JSON-serializable
     * @throws IOException when the write fails
     */
    void event(String type, Object payload) throws IOException;
}
