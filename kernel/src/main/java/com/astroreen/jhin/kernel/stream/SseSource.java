/**
 * Internal SSE marker carried by an
 * {@link com.astroreen.jhin.sdk.http.HttpResponse}.
 *
 * <p>Created by {@link StreamRegistryImpl#sse} and understood only by the
 * stream layer's hand-off. The marker travels through the generic response
 * contract untouched; it is never set or read by plugins.
 *
 * <p>Components: {@code topic} — the topic to stream; {@code preamble} — the
 * replay callback run before the live tail.
 */
package com.astroreen.jhin.kernel.stream;

import com.astroreen.jhin.sdk.stream.SsePreamble;

record SseSource(String topic, SsePreamble preamble) {}
