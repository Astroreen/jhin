/**
 * Handle for one stream subscription.
 *
 * <p>Returned by {@link StreamRegistry#subscribe(String,
 * java.util.function.Consumer)} and closed by the plugin when it no longer
 * wants the events. Closing unregisters the sink; events already handed to the
 * sink are not recalled.
 */
package com.astroreen.jhin.sdk.stream;

public interface Subscription extends AutoCloseable {

    /**
     * Unsubscribes. Called by the plugin; idempotent, never throws. Unlike
     * {@link AutoCloseable#close()} this cannot fail.
     */
    @Override
    void close();
}
