/**
 * Replays a plugin's own history at the start of an SSE stream.
 *
 * <p>Implemented by a plugin and handed to
 * {@link StreamRegistry#sse(String, SsePreamble)}. The kernel runs it AFTER it
 * has subscribed and started buffering live events, and BEFORE the buffer is
 * flushed and the live tail begins, so the plugin writes the backlog here and
 * MUST de-duplicate by its own monotonic id.
 */
package com.astroreen.jhin.sdk.stream;

public interface SsePreamble {

    /**
     * Writes the historical events. Called by the kernel once per SSE
     * connection, after live buffering has started and before the live tail.
     *
     * @param w the writer for the SSE stream
     * @throws Exception when the replay fails; the kernel aborts the SSE
     *                   response and logs the stack trace
     */
    void write(SseWriter w) throws Exception;
}
