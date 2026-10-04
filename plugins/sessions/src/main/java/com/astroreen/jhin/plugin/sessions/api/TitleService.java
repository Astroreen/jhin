/**
 * The seam through which session titles are regenerated from conversation
 * history.
 *
 * <p>The sessions plugin only delegates: an LLM-backed implementation is
 * published under this type through the {@code ServiceRegistry} by the plugin
 * that owns the model runtime ({@code jhin.agent}). Lookups are live, so the
 * service may appear after this plugin has started; when it is absent, title
 * regeneration fails with {@link LifecycleException.Failure#TITLE_UNAVAILABLE}
 * and the route answers {@code 503 title_service_unavailable}.
 */
package com.astroreen.jhin.plugin.sessions.api;

import java.util.List;

/**
 * Regenerates a session title from its event history.
 *
 * <p>Implementations are published by dependant plugins (the type lives here
 * because sessions cannot depend on them) and looked up at call time with
 * {@code services().find(TitleService.class)}.
 */
public interface TitleService {

    /**
     * Proposes a short title for one session from its event history.
     *
     * <p>Contract: the returned title is never {@code null} or blank — an
     * implementation that cannot produce a better title falls back to the
     * current one ({@code session.title()}) instead of failing.
     *
     * @param session the session to retitle
     * @param history the full event history of the session, in sequence order
     * @return the new title; never {@code null} or blank
     */
    String regenerate(Session session, List<EventRecord> history);
}
