/**
 * The default SDUI plugin: it owns {@code GET /_jhin/bootstrap} (replacing the
 * kernel fallback), {@code GET /ui/screen/{id}}, {@code POST /ui/action/{name}}
 * and {@code GET /ui/stream/session/{id}}, authors the offline/error fallback
 * nodes and renders the minimal screen registry of the T36 surface (connect,
 * sessions, and a providers placeholder when the LLM plugin is loaded).
 *
 * <p>Everything is built with the {@code jhin.ui-kit} builder and tailored to
 * the request's {@code X-Jhin-Client} capabilities at the source: nodes and
 * directives the client cannot honour are degraded before the payload is
 * written.
 */
package com.astroreen.jhin.plugin.ui;
