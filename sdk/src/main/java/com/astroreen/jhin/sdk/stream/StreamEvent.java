/**
 * One event on a stream topic.
 *
 * <p>Created by a plugin and handed to
 * {@link StreamRegistry#publish(String, StreamEvent)} or written through
 * {@link SseWriter#event(String, Object)}. The kernel stores and forwards the
 * event untouched; the payload must be JSON-serializable.
 *
 * <p>Components: {@code type} — the event type discriminator; {@code
 * payload} — the event body, JSON-serializable.
 */
package com.astroreen.jhin.sdk.stream;

public record StreamEvent(String type, Object payload) {}
