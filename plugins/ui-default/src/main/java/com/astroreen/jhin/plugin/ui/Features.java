/**
 * Which optional integrations the runtime loaded, resolved once at plugin
 * start. The screens and action handlers take this snapshot instead of probing
 * class names themselves, so every degradation decision is one explicit flag.
 */
package com.astroreen.jhin.plugin.ui;

/**
 * @param security {@code jhin.security} is loaded (enroll screen and enroll action)
 * @param llm      {@code jhin.llm} is loaded (providers screen and provider actions)
 * @param agent    {@code jhin.agent} is loaded (send and cancel actions, chat cancel)
 * @param reload   {@code jhin.reload} is loaded (settings reload button)
 * @param tools    {@code jhin.tools-builtin} is loaded (pending {@code ask_user}
 *                 question panel and the {@code answer-question} action)
 */
record Features(boolean security, boolean llm, boolean agent, boolean reload, boolean tools) {
}
