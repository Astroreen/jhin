/**
 * The timeline row vocabulary of the chat (T101): one builder per row kind,
 * shared by the {@link ChatScreen} transcript, by {@code EventFrames} (the
 * live frame mapping) and by the {@code qa-timeline} probe screen, so a
 * rendered history, a live frame and the QA fixture produce the very same
 * node for the very same row.
 *
 * <p><b>The 14 row kinds</b> (plan section 4.5; the upstream row union is
 * {@code MessagesTimelineRowContent}, t3code commit 37de6cb,
 * {@code components/chat/MessagesTimeline.logic.ts:489-596} — 13 kinds plus
 * the Jhin-side {@code unknown} fallback row): {@code message} (role user /
 * assistant), {@code assistant-meta}, {@code event}, {@code work},
 * {@code work-live}, {@code work-toggle}, {@code thinking},
 * {@code proposed-plan}, {@code working}, {@code worktree-setup},
 * {@code turn-fold}, {@code attempt-fold}, {@code context-compaction} and
 * {@code unknown}. Every row node carries {@code rowKind} and the
 * continuation key {@code rowKey} ({@code ${type}:${subtype}}); an unknown
 * kind falls back to the {@code unknown} placeholder row instead of
 * throwing.
 *
 * <p><b>Anatomy anchors</b> (upstream, commit 37de6cb): the user bubble is
 * {@code rounded-2xl bg-message p-3 text-message-foreground}
 * ({@code MessagesTimeline.tsx:2147}; {@code --radius-2xl} is
 * {@code calc(var(--radius) + 8px)}, {@code index.css:281,1064} — the Jhin
 * {@code $radius.xl2} step; {@code --color-message} is the message surface,
 * {@code index.css:264}), the assistant message is a bordered card (the
 * plan's contract; upstream renders bare markdown,
 * {@code MessagesTimeline.tsx:2494-2525}), the event card is
 * {@code rounded-lg border px-3 py-2} with the tone colours
 * ({@code MessagesTimeline.tsx:2859-2965}), the work rows are the
 * {@code WorkLogRow} line ({@code WorkLog.tsx:63-77}) inside the collapsible
 * section, the working row is the muted border-b strip
 * ({@code MessagesTimeline.tsx:3405-3422}) and the compaction row is the
 * centered {@code mx-auto} divider ({@code MessagesTimeline.tsx:1862-1898}).
 *
 * <p><b>Continuation.</b> {@link #applyContinuation} bakes the per-row
 * bottom gap into a rendered history: rows whose {@code rowKey} equals the
 * next row's key close with no gap (the upstream {@code continuesWorkLog}
 * rule, {@code MessagesTimeline.logic.ts:1773-1781}), the rest close with
 * the kind gap of the upstream {@code pb-*} scale
 * ({@code MessagesTimeline.tsx:1766-1784}: 16 for messages and friends, 8
 * for work/event rows, 6 for the fold and working strips). The live tail
 * computes the same table client-side (the stream view of {@code app.js}).
 *
 * <p><b>The 16 event kinds</b> (T102, plan section 4.5): the {@code event}
 * row dispatches on the event item type through {@link #dispatchEventRow} —
 * {@code diff} (the {@code diff_view} card), {@code file-write} (the
 * changed-files card), {@code shell} (command + code block), {@code
 * message} (inline text), {@code tool-call}/{@code tool-result} (the
 * standard tool card), {@code approval-request} (the question card with
 * option chips), {@code limit-notice} (the warning banner), {@code error}
 * (the danger card), {@code system-notice} (the muted notice), {@code
 * queued-message} (the pending card with the stripe), {@code subagent} (the
 * right-aligned bar), {@code citation} and {@code skill-invocation} (the
 * inline pills), {@code work-log-entry} (the work log row), {@code
 * question} (the question card with answers) — and anything else falls back
 * to the {@code unknown} placeholder card. The standard tool card (T102.1)
 * carries the four-part anatomy: header (tool icon + name + status chip +
 * chevron), collapsible argument summary line, output region (markdown /
 * {@code code_block} / {@code diff_view}) and footer (timestamp + copy
 * button); the expansion is keyed by the row id (the {@code ev-<seq>-body}
 * patch target).
 *
 * <p>All keys are documented contract props (docs/sdui.md sections 2.1 and
 * 2.6); color references are {@code $color.*}/{@code $radius.*} tokens so
 * the client theme stays authoritative.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.ui.Directives;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlRenderer;
import com.astroreen.jhin.sdk.json.Json;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class MessageCardBuilder {

    /** The message surface of the user bubble (the upstream {@code bg-message}). */
    public static final String USER_SURFACE = "$color.message";

    /** The foreground of the user bubble text. */
    public static final String USER_FOREGROUND = "$color.message-foreground";

    /** The danger color token of error and failed-tool content. */
    public static final String DANGER = "$color.error";

    /** The muted foreground token of secondary labels. */
    public static final String MUTED = "$color.muted-foreground";

    /** The hairline border token of cards and dividers. */
    public static final String BORDER = "$color.border";

    /** The accent token of live and active content. */
    public static final String ACCENT = "$color.accent";

    /** The bubble corner radius: the upstream {@code rounded-2xl} step. */
    public static final String BUBBLE_RADIUS = "$radius.xl2";

    /** The event-card corner radius: the upstream {@code rounded-lg} step. */
    public static final String EVENT_RADIUS = "$radius.lg";

    /** The row-kind prop name every timeline row carries. */
    public static final String ROW_KIND_PROP = "rowKind";

    /** The continuation-key prop name ({@code ${type}:${subtype}}). */
    public static final String ROW_KEY_PROP = "rowKey";

    /** The row kind of the user and assistant message bubbles. */
    public static final String KIND_MESSAGE = "message";

    /** The row kind of the model/effort/provider label row. */
    public static final String KIND_ASSISTANT_META = "assistant-meta";

    /** The row kind of the event dispatcher (the T102 kinds). */
    public static final String KIND_EVENT = "event";

    /** The row kind of the collapsible tool group entry. */
    public static final String KIND_WORK = "work";

    /** The row kind of the live tool row (the shine accent). */
    public static final String KIND_WORK_LIVE = "work-live";

    /** The row kind of the collapsed group header with count. */
    public static final String KIND_WORK_TOGGLE = "work-toggle";

    /** The row kind of the collapsible thinking block. */
    public static final String KIND_THINKING = "thinking";

    /** The row kind of the proposed plan card. */
    public static final String KIND_PROPOSED_PLAN = "proposed-plan";

    /** The row kind of the working spinner strip. */
    public static final String KIND_WORKING = "working";

    /** The row kind of the decorative worktree setup status card. */
    public static final String KIND_WORKTREE_SETUP = "worktree-setup";

    /** The row kind of the centered turn fold affordance. */
    public static final String KIND_TURN_FOLD = "turn-fold";

    /** The row kind of the centered attempt fold affordance. */
    public static final String KIND_ATTEMPT_FOLD = "attempt-fold";

    /** The row kind of the centered compaction divider. */
    public static final String KIND_CONTEXT_COMPACTION = "context-compaction";

    /** The fallback row kind for an unknown kind. */
    public static final String KIND_UNKNOWN = "unknown";

    // ------------------------------------------------------------------
    // the 16 event kinds (T102, plan section 4.5)
    // ------------------------------------------------------------------

    /** The event kind of a rendered diff (the {@code diff_view} card). */
    public static final String EVENT_DIFF = "diff";

    /** The event kind of the changed-files card (paths with line stats). */
    public static final String EVENT_FILE_WRITE = "file-write";

    /** The event kind of the shell card (command + code block output). */
    public static final String EVENT_SHELL = "shell";

    /** The event kind of an inline text message. */
    public static final String EVENT_MESSAGE = "message";

    /** The event kind of the standard tool-call card. */
    public static final String EVENT_TOOL_CALL = "tool-call";

    /** The event kind of the standard tool-result card. */
    public static final String EVENT_TOOL_RESULT = "tool-result";

    /** The event kind of the approval question card with option chips. */
    public static final String EVENT_APPROVAL_REQUEST = "approval-request";

    /** The event kind of the usage-limit warning banner. */
    public static final String EVENT_LIMIT_NOTICE = "limit-notice";

    /** The event kind of the error card (the danger tone). */
    public static final String EVENT_ERROR = "error";

    /** The event kind of the muted system notice. */
    public static final String EVENT_SYSTEM_NOTICE = "system-notice";

    /** The event kind of the pending queued-message card with the stripe. */
    public static final String EVENT_QUEUED_MESSAGE = "queued-message";

    /** The event kind of the right-aligned subagent bar. */
    public static final String EVENT_SUBAGENT = "subagent";

    /** The event kind of the citation inline pill. */
    public static final String EVENT_CITATION = "citation";

    /** The event kind of the skill inline pill. */
    public static final String EVENT_SKILL_INVOCATION = "skill-invocation";

    /** The event kind of the work log row. */
    public static final String EVENT_WORK_LOG_ENTRY = "work-log-entry";

    /** The event kind of the question card with answers. */
    public static final String EVENT_QUESTION = "question";

    /** The fallback event kind token of the placeholder card. */
    public static final String EVENT_UNKNOWN = "unknown";

    /** The 16 event kinds, in the plan section 4.5 order (the unknown
     * fallback is not a kind — it is the placeholder every unrecognized
     * type falls back to). */
    public static final Set<String> EVENT_KINDS = Set.copyOf(new LinkedHashSet<>(List.of(
            EVENT_DIFF, EVENT_FILE_WRITE, EVENT_SHELL, EVENT_MESSAGE,
            EVENT_TOOL_CALL, EVENT_TOOL_RESULT, EVENT_APPROVAL_REQUEST,
            EVENT_LIMIT_NOTICE, EVENT_ERROR, EVENT_SYSTEM_NOTICE,
            EVENT_QUEUED_MESSAGE, EVENT_SUBAGENT, EVENT_CITATION,
            EVENT_SKILL_INVOCATION, EVENT_WORK_LOG_ENTRY, EVENT_QUESTION)));

    // ------------------------------------------------------------------
    // the status chip vocabulary (T102.1)
    // ------------------------------------------------------------------

    /** The pending chip label. */
    public static final String CHIP_PENDING = "Pending";

    /** The running chip label. */
    public static final String CHIP_RUNNING = "Running";

    /** The done chip label. */
    public static final String CHIP_DONE = "Done";

    /** The error chip label. */
    public static final String CHIP_ERROR = "Error";

    /** The cancelled chip label. */
    public static final String CHIP_CANCELLED = "Cancelled";

    /** The info color token of the running chip. */
    public static final String INFO = "$color.info";

    /** The warning color token of the pending chip. */
    public static final String WARNING = "$color.warning";

    /** The success color token of the done chip. */
    public static final String SUCCESS = "$color.success";

    /** The diff-addition color token of the changed-files stats. */
    public static final String DIFF_ADDITION = "$color.diff-addition";

    /** The diff-deletion color token of the changed-files stats. */
    public static final String DIFF_DELETION = "$color.diff-deletion";

    /** The 14 row kinds, in the plan section 4.5 order. */
    public static final Set<String> ROW_KINDS = Set.copyOf(new LinkedHashSet<>(List.of(
            KIND_MESSAGE, KIND_ASSISTANT_META, KIND_EVENT, KIND_WORK,
            KIND_WORK_LIVE, KIND_WORK_TOGGLE, KIND_THINKING, KIND_PROPOSED_PLAN,
            KIND_WORKING, KIND_WORKTREE_SETUP, KIND_TURN_FOLD, KIND_ATTEMPT_FOLD,
            KIND_CONTEXT_COMPACTION, KIND_UNKNOWN)));

    /** The badge labels of the run status line. */
    public static final String STATUS_RUNNING = "Running\u2026";

    /** The idle badge label. */
    public static final String STATUS_IDLE = "Idle";

    /** The degraded badge label (the last run closed with an error). */
    public static final String STATUS_LIMITED = "Limited";

    /** The node id of the run status badge (the patch target of run frames). */
    public static final String STATUS_ID = "runStatus";

    /** The label of the working spinner row. */
    public static final String WORKING_LABEL = "agent is working\u2026";

    private MessageCardBuilder() {
    }

    /**
     * The id of one event row.
     *
     * @param seq the event sequence number
     * @return {@code ev-<seq>}
     */
    public static String eventId(long seq) {
        return "ev-" + seq;
    }

    /**
     * The id of the text node of one assistant message; the patch target of
     * its {@code text_delta} and {@code message_end} frames.
     *
     * @param seq the {@code message_start} sequence number
     * @return {@code msg-<seq>}
     */
    public static String messageId(long seq) {
        return "msg-" + seq;
    }

    /**
     * Whether the kind is one of the 14 row kinds.
     *
     * @param kind the kind to check
     * @return {@code true} when the kind renders as a timeline row
     */
    public static boolean isRowKind(String kind) {
        return kind != null && ROW_KINDS.contains(kind);
    }

    /**
     * Whether the type is one of the 16 event kinds.
     *
     * @param type the event item type to check
     * @return {@code true} when the type renders a dedicated event card
     */
    public static boolean isEventKind(String type) {
        return type != null && EVENT_KINDS.contains(type);
    }

    /**
     * The status chip of one tool status: the upstream label words
     * ("Pending", "Running", "Done", "Error", "Cancelled") on the token
     * colours ({@code warning}, {@code info}, {@code success}, {@code
     * error}, {@code muted-foreground}). The upstream words anchor at
     * {@code ComposerTasksBadge.tsx:23-24} ("Pending"/"Running"),
     * {@code ThreadRelationshipIcon.tsx:13,21} ("Running"/"Done") and
     * {@code pullRequestPresentation.tsx:226} ("Cancelled"), t3code commit
     * 37de6cb; the plan's five-state set is the normalized contract. An
     * unrecognized status renders the muted chip with the raw text — never
     * a throw.
     *
     * @param status the tool status ({@code pending}|{@code running}|
     *               {@code success}|{@code error}|{@code cancelled}, with
     *               the {@code completed}/{@code failed}/{@code stopped}
     *               synonyms of the upstream lifecycle statuses)
     * @return the badge node
     */
    public static UiNode statusChip(String status) {
        String text = status == null ? "" : status.trim();
        return switch (text) {
            case "", "pending" -> chip(CHIP_PENDING, WARNING);
            case "running" -> chip(CHIP_RUNNING, INFO);
            case "success", "done", "completed" -> chip(CHIP_DONE, SUCCESS);
            case "error", "failed" -> chip(CHIP_ERROR, DANGER);
            case "cancelled", "canceled", "stopped" -> chip(CHIP_CANCELLED, MUTED);
            default -> chip(text, MUTED);
        };
    }

    /** One filled status-chip badge with the label and the token colour. */
    private static UiNode chip(String label, String color) {
        return Ui.badge().label(label).color(color).build();
    }

    /**
     * The continuation key of one row: {@code ${type}:${subtype}} (plan
     * section 4.5). Consecutive rows sharing the key render as one visual
     * group (no gap inside).
     *
     * @param kind    the row kind
     * @param subtype the kind qualifier (the role, the event type, the log
     *                family); blank collapses to the kind alone
     * @return the continuation key
     */
    public static String rowKey(String kind, String subtype) {
        return (subtype == null || subtype.isBlank()) ? kind : kind + ":" + subtype;
    }

    /**
     * The bottom gap a row closes with when no row continues its group: the
     * upstream {@code pb-*} scale ({@code MessagesTimeline.tsx:1766-1784},
     * {@code WorkLog.tsx:19-21}).
     *
     * @param kind the row kind
     * @return the gap in logical px (16, 8 or 6)
     */
    public static int rowGap(String kind) {
        return switch (kind == null ? "" : kind) {
            case KIND_WORK, KIND_WORK_LIVE, KIND_WORK_TOGGLE, KIND_THINKING,
                 KIND_EVENT, KIND_WORKTREE_SETUP, KIND_ATTEMPT_FOLD, KIND_UNKNOWN -> 8;
            case KIND_TURN_FOLD, KIND_WORKING -> 6;
            default -> 16;
        };
    }

    /**
     * Bakes the continuation gaps into an ordered row list: a row whose
     * {@code rowKey} equals the next row's key closes with no gap (the
     * upstream {@code continuesWorkLog} rule), the rest close with the kind
     * gap. Rows without a {@code rowKind} pass through untouched.
     *
     * @param rows the ordered rows of one rendered history
     * @return the same order with the {@code margin} bottoms applied
     */
    public static List<UiNode> applyContinuation(List<UiNode> rows) {
        List<UiNode> result = new ArrayList<>(rows.size());
        for (int i = 0; i < rows.size(); i++) {
            UiNode row = rows.get(i);
            Object kind = row.props().get(ROW_KIND_PROP);
            if (!(kind instanceof String kindText)) {
                result.add(row);
                continue;
            }
            boolean continues = i + 1 < rows.size()
                    && row.props().get(ROW_KEY_PROP) != null
                    && row.props().get(ROW_KEY_PROP)
                            .equals(rows.get(i + 1).props().get(ROW_KEY_PROP));
            Map<String, Object> margin = new LinkedHashMap<>();
            margin.put("bottom", continues ? 0 : rowGap(kindText));
            Map<String, Object> props = new LinkedHashMap<>(row.props());
            props.put("margin", margin);
            result.add(new UiNode(row.type(), props, row.children()));
        }
        return List.copyOf(result);
    }

    // ------------------------------------------------------------------
    // message
    // ------------------------------------------------------------------

    /**
     * The user message row: a right-aligned bubble on the message surface
     * with the hover-action stubs below it (upstream
     * {@code MessagesTimeline.tsx:2108-2147,2270-2312}).
     *
     * @param text the message text
     * @param seq  the event sequence number (drives the node id)
     * @return the {@code message:user} row
     */
    public static UiNode userMessageRow(String text, long seq) {
        UiNode bubble = Ui.card()
                .id(eventId(seq) + "-bubble")
                .color(USER_SURFACE)
                .borderRadius(BUBBLE_RADIUS)
                .padding(12)
                .maxWidth(560)
                .child(Ui.text(text == null ? "" : text)
                        .style("body")
                        .color(USER_FOREGROUND)
                        .build())
                .build();
        return rowContainer(KIND_MESSAGE, "user", seq, "centerRight", 4,
                bubble, hoverActions(eventId(seq) + "-actions",
                        List.of("Copy", "Edit", "Retry")));
    }

    /**
     * The assistant message row: a bordered card around the markdown text
     * (the plan's contract; the markdown child keeps the {@code msg-<seq>}
     * patch target).
     *
     * @param seq  the {@code message_start} sequence number (drives the ids)
     * @param text the complete message text
     * @return the {@code message:assistant} row
     */
    public static UiNode assistantMessageRow(long seq, String text) {
        UiNode card = Ui.card()
                .id(eventId(seq) + "-bubble")
                .border(BORDER)
                .borderRadius(BUBBLE_RADIUS)
                .padding(12)
                .maxWidth(560)
                .child(streamedText(seq, text))
                .build();
        return rowContainer(KIND_MESSAGE, "assistant", seq, "centerLeft", 4, card);
    }

    /**
     * The streamed-text element of one assistant message: the {@code
     * markdown} node whose stable {@code msg-<seq>} id the {@code patch}
     * frames grow in place. Built by the row above and rebuilt per flush by
     * {@link #streamedTextHtml(String)} — one element definition, one id.
     *
     * @param seq  the {@code message_start} sequence number (drives the id)
     * @param text the message text so far
     * @return the {@code msg-<seq>} markdown element
     */
    public static UiNode streamedText(long seq, String text) {
        return Ui.markdown(text == null ? "" : text).id(messageId(seq)).build();
    }

    /**
     * The rendered streamed-text content of one assistant message: the
     * markdown blocks of {@code text} <em>without</em> the wrapping element
     * — the level-4 {@code patch} {@code html} that swaps into the
     * {@code msg-<seq>} text element (docs/sdui.md section 5: a patch
     * replaces the inner HTML of its target; the plan words it "innerHTML of
     * the markdown block").
     *
     * @param text the accumulated message text
     * @return the inner HTML of the text element
     */
    public static String streamedTextHtml(String text) {
        return innerHtmlOf(Ui.markdown(text == null ? "" : text).build());
    }

    /**
     * The rendered inner content of one node: the HTML of its children
     * without the root element's open/close tags — the {@code patch}
     * {@code html} shape of docs/sdui.md section 5 (the patch swaps the
     * inner HTML of {@code #<id>}, so the payload must not re-emit the
     * target element itself).
     *
     * <p>The extraction is exact, not a heuristic: {@code HtmlEsc} escapes
     * {@code <} and {@code >} in every attribute value and text child, so
     * the first {@code >} of a rendered fragment ends the root open tag and
     * the last {@code <} starts the root close tag. A void or empty root
     * renders as the empty content.
     *
     * @param node the node whose content to render
     * @return the inner HTML of the node's element
     */
    public static String innerHtmlOf(UiNode node) {
        String fragment = HtmlRenderer.renderFragment(node);
        int openEnd = fragment.indexOf('>');
        int closeStart = fragment.lastIndexOf('<');
        if (openEnd < 0 || closeStart <= openEnd) {
            return "";
        }
        return fragment.substring(openEnd + 1, closeStart);
    }

    /**
     * The assistant-meta row: the model/effort/provider label row with the
     * Copy/Fork stubs (upstream {@code AssistantMessageMeta},
     * {@code MessagesTimeline.tsx:2600-2665}; the labels ride the row the
     * way the plan specifies them).
     *
     * @param seq    the sequence number anchoring the row
     * @param labels the model/effort/provider labels, may be empty
     * @return the {@code assistant-meta} row
     */
    public static UiNode assistantMetaRow(long seq, List<String> labels) {
        Ui.RowBuilder meta = Ui.row().id(eventId(seq) + "-meta")
                .align("center")
                .gap(8);
        for (String label : labels == null ? List.<String>of() : labels) {
            meta.child(Ui.text(label)
                    .style("caption")
                    .color(MUTED)
                    .build());
        }
        meta.child(hoverActions(eventId(seq) + "-actions", List.of("Copy", "Fork")));
        return rowContainer(KIND_ASSISTANT_META, "assistant", seq, "centerLeft", 4,
                meta.build());
    }

    // ------------------------------------------------------------------
    // event
    // ------------------------------------------------------------------

    /**
     * The event row: the tone-tinted card the T102 kinds dispatch through
     * (upstream {@code V2EventTimelineRow},
     * {@code MessagesTimeline.tsx:2859-2965}).
     *
     * @param seq    the event sequence number (drives the node id)
     * @param type   the event item type (the {@code rowKey} subtype)
     * @param label  the event label
     * @param detail the one-line detail, may be blank
     * @param tone   {@code danger}|{@code warning}|{@code success}|{@code
     *               muted} — the border/icon tone
     * @return the {@code event:<type>} row
     */
    public static UiNode eventRow(long seq, String type, String label,
                                  String detail, String tone) {
        String toneColor = switch (tone == null ? "muted" : tone) {
            case "danger" -> DANGER;
            case "warning" -> WARNING;
            case "success" -> SUCCESS;
            default -> BORDER;
        };
        Ui.CardBuilder card = Ui.card()
                .id(eventId(seq) + "-card")
                .border(toneColor)
                .borderRadius(EVENT_RADIUS)
                .padding(12);
        Ui.RowBuilder line = Ui.row().gap(8).align("center")
                .child(Ui.icon().icon(iconOf(type)).size(16).color(toneColor).build())
                .child(Ui.text(label == null || label.isBlank() ? type : label)
                        .style("small")
                        .build());
        card.child(line.build());
        if (detail != null && !detail.isBlank()) {
            card.child(Ui.text(detail).style("caption").color(MUTED).build());
        }
        return rowContainer(KIND_EVENT, type, seq, null, 4, card.build());
    }

    /**
     * The event dispatcher: maps one event item type to its event card (the
     * T102 vocabulary, plan section 4.5). Every one of the 16 kinds renders
     * a recognisable card — the tool-call card anatomy, the status chips and
     * the output regions — and an unrecognized type falls back to the
     * {@code unknown} placeholder card instead of throwing (the same
     * fallback contract the row kinds carry).
     *
     * @param type    the event item type (one of the 16 kinds, or anything
     *                else for the placeholder)
     * @param payload the event payload
     * @param seq     the event sequence number
     * @return the dispatched event row
     */
    public static UiNode dispatchEventRow(String type, Map<String, Object> payload, long seq) {
        Map<String, Object> p = payload == null ? Map.of() : payload;
        return switch (type == null ? "" : type) {
            case EVENT_DIFF -> diffEventRow(seq, p);
            case EVENT_FILE_WRITE -> fileWriteEventRow(seq, p);
            case EVENT_SHELL -> shellEventRow(seq, p);
            case EVENT_MESSAGE -> messageEventRow(seq, p);
            case EVENT_TOOL_CALL -> toolCallEventRow(seq, p);
            case EVENT_TOOL_RESULT -> toolResultEventRow(seq, p);
            case EVENT_APPROVAL_REQUEST -> approvalRequestEventRow(seq, p);
            case EVENT_LIMIT_NOTICE -> limitNoticeEventRow(seq, p);
            case EVENT_ERROR -> errorEventRow(seq, p);
            case EVENT_SYSTEM_NOTICE -> systemNoticeEventRow(seq, p);
            case EVENT_QUEUED_MESSAGE -> queuedMessageEventRow(seq, p);
            case EVENT_SUBAGENT -> subagentEventRow(seq, p);
            case EVENT_CITATION -> citationEventRow(seq, p);
            case EVENT_SKILL_INVOCATION -> skillInvocationEventRow(seq, p);
            case EVENT_WORK_LOG_ENTRY -> workLogEntryEventRow(seq, p);
            case EVENT_QUESTION -> questionEventRow(seq, p);
            default -> unknownEventRow(seq, type);
        };
    }

    // ------------------------------------------------------------------
    // the 16 event cards (T102.2)
    // ------------------------------------------------------------------

    /**
     * The {@code diff} card: the {@code diff_view} of the T93 primitive as
     * the row content (the plan's mapping; the view is decorative and
     * carries the mandatory {@code demo} marker). A payload without hunks
     * renders the empty-state region instead of a hunkless view.
     *
     * @param seq     the event sequence number (drives the node id)
     * @param payload {@code file}, {@code language}, {@code additions},
     *                {@code deletions}, {@code hunks}
     * @return the {@code event:diff} row
     */
    private static UiNode diffEventRow(long seq, Map<String, Object> payload) {
        UiNode view = diffViewOf(seq, payload);
        return rowContainer(KIND_EVENT, EVENT_DIFF, seq, null, 4,
                view != null ? view : emptyState(seq));
    }

    /**
     * The {@code file-write} card: the changed-files card — the count header
     * with the total line stats and one row per changed file (the path with
     * the {@code +a}/{@code -d} stats and the optional A/M/D badge; the
     * upstream {@code ChangedFilesCard} header
     * {@code ChangedFilesTree.tsx:57-66} and the {@code DiffStatLabel} pair
     * {@code DiffStatLabel.tsx:38-47}, t3code commit 37de6cb).
     *
     * @param seq     the event sequence number (drives the node id)
     * @param payload {@code files: [{path, additions, deletions, status}]}
     * @return the {@code event:file-write} row
     */
    private static UiNode fileWriteEventRow(long seq, Map<String, Object> payload) {
        List<Map<String, Object>> files = filesOf(payload);
        int additions = 0;
        int deletions = 0;
        for (Map<String, Object> file : files) {
            additions += intOf(file, "additions");
            deletions += intOf(file, "deletions");
        }
        Ui.CardBuilder card = Ui.card()
                .id(eventId(seq) + "-card")
                .border(BORDER)
                .borderRadius(EVENT_RADIUS)
                .padding(12);
        card.child(Ui.row().id(eventId(seq) + "-head").gap(8).align("center")
                .child(Ui.icon().icon("edit_note").size(16).color(MUTED).build())
                .child(Ui.text(files.size() + " changed file"
                        + (files.size() == 1 ? "" : "s")).style("small").build())
                .child(Ui.text("+" + additions).style("mono")
                        .color(DIFF_ADDITION).build())
                .child(Ui.text("-" + deletions).style("mono")
                        .color(DIFF_DELETION).build())
                .build());
        for (Map<String, Object> file : files) {
            String path = textOf(file, "path", "");
            Ui.RowBuilder row = Ui.row().gap(8).align("center")
                    .child(Ui.text(path).style("mono").maxLines(1).ellipsis(true)
                            .flex(1).build())
                    .child(Ui.text("+" + intOf(file, "additions")).style("mono")
                            .color(DIFF_ADDITION).build())
                    .child(Ui.text("-" + intOf(file, "deletions")).style("mono")
                            .color(DIFF_DELETION).build());
            String status = textOf(file, "status", "");
            if (!status.isBlank()) {
                row.child(Ui.badge().label(status).build());
            }
            card.child(row.build());
        }
        return rowContainer(KIND_EVENT, EVENT_FILE_WRITE, seq, null, 4, card.build());
    }

    /**
     * The {@code shell} card: the standard tool card with the command as the
     * summary line and the output as the code block (the plan's mapping).
     *
     * @param seq     the event sequence number (drives the node id)
     * @param payload {@code command}, {@code output}, {@code status},
     *                {@code time}, {@code language}
     * @return the {@code event:shell} row
     */
    private static UiNode shellEventRow(long seq, Map<String, Object> payload) {
        Map<String, Object> card = new LinkedHashMap<>(payload);
        card.putIfAbsent("name", "shell");
        Object command = payload.get("command");
        if (command != null && card.get("summary") == null) {
            card.put("summary", String.valueOf(command));
        }
        return toolCardRow(EVENT_SHELL, seq, card);
    }

    /**
     * The {@code message} card: the inline text (no card chrome; the plan's
     * mapping).
     *
     * @param seq     the event sequence number (drives the node id)
     * @param payload {@code text}
     * @return the {@code event:message} row
     */
    private static UiNode messageEventRow(long seq, Map<String, Object> payload) {
        return rowContainer(KIND_EVENT, EVENT_MESSAGE, seq, null, 4,
                Ui.text(textOf(payload, "text", "")).style("body").build());
    }

    /** The {@code tool-call} card: the standard card with the arguments. */
    private static UiNode toolCallEventRow(long seq, Map<String, Object> payload) {
        return toolCardRow(EVENT_TOOL_CALL, seq, payload);
    }

    /** The {@code tool-result} card: the standard card with the output. */
    private static UiNode toolResultEventRow(long seq, Map<String, Object> payload) {
        return toolCardRow(EVENT_TOOL_RESULT, seq, payload);
    }

    /**
     * The {@code approval-request} card: the question card with the option
     * chips — the warning-tinted title (the upstream approval label rides
     * {@code text-warning}, {@code ComposerPendingApprovalPanel.tsx:40-44},
     * t3code commit 37de6cb), the mono detail and one chip per option; the
     * chips dispatch inline {@code setState} stubs and carry the {@code
     * demo} marker (no backend answers them yet — plan section 14.10).
     *
     * @param seq     the event sequence number (drives the node id)
     * @param payload {@code title}, {@code detail}, {@code options}
     * @return the {@code event:approval-request} row
     */
    private static UiNode approvalRequestEventRow(long seq, Map<String, Object> payload) {
        Ui.CardBuilder card = Ui.card()
                .id(eventId(seq) + "-card")
                .border(WARNING)
                .borderRadius(EVENT_RADIUS)
                .padding(12);
        card.child(Ui.row().id(eventId(seq) + "-head").gap(8).align("center")
                .child(Ui.icon().icon("gpp_maybe").size(16).color(WARNING).build())
                .child(Ui.text(textOf(payload, "title", "Approval requested"))
                        .style("small").color(WARNING).build())
                .build());
        String detail = textOf(payload, "detail", "");
        if (!detail.isBlank()) {
            card.child(Ui.codeBlock(detail).language("shell").maxLines(4).build());
        }
        Ui.RowBuilder options = Ui.row().id(eventId(seq) + "-options").gap(8);
        int index = 0;
        for (Object raw : listOf(payload, "options")) {
            String option = String.valueOf(raw);
            options.child(Ui.chip().label(option)
                    .action(Directives.setState(eventId(seq) + "-option-" + index, option))
                    .set("demo", true)
                    .build());
            index++;
        }
        card.child(options.build());
        return rowContainer(KIND_EVENT, EVENT_APPROVAL_REQUEST, seq, null, 4, card.build());
    }

    /**
     * The {@code limit-notice} card: the warning banner with the decorative
     * {@code Resume} / {@code Resume at reset} buttons (the upstream
     * {@code usageLimitRecoveryBannerItem} — the "Usage limit reached"
     * title, the reset description and the recovery actions,
     * {@code UsageLimitRecoveryBanner.tsx:31-41,92-99}, t3code commit
     * 37de6cb; the buttons are demo-marked inline stubs — plan section
     * 14.10).
     *
     * @param seq     the event sequence number (drives the node id)
     * @param payload {@code resetAt}
     * @return the {@code event:limit-notice} row
     */
    private static UiNode limitNoticeEventRow(long seq, Map<String, Object> payload) {
        String resetAt = textOf(payload, "resetAt", "");
        UiNode content = Ui.row().gap(8)
                .child(Ui.icon().icon("speed").size(16).color(WARNING).build())
                .child(Ui.expanded()
                        .child(Ui.column().gap(2)
                                .child(Ui.text("Usage limit reached").style("small")
                                        .color(WARNING).build())
                                .child(Ui.text(resetAt.isBlank()
                                                ? "Reset time unavailable; retry manually"
                                                : "Resets " + resetAt)
                                        .style("caption").color(MUTED).build())
                                .build())
                        .build())
                .build();
        return rowContainer(KIND_EVENT, EVENT_LIMIT_NOTICE, seq, null, 4,
                Ui.banner()
                        .id(eventId(seq) + "-banner")
                        .content(content)
                        .action(Ui.button("Resume")
                                .action(Directives.setState(eventId(seq) + "-resume", true))
                                .set("demo", true)
                                .build())
                        .action(Ui.button("Resume at reset")
                                .action(Directives.setState(eventId(seq) + "-resume-reset", true))
                                .set("demo", true)
                                .build())
                        .build());
    }

    /**
     * The {@code error} card: the danger-tone event card (the upstream error
     * row tone, {@code MessagesTimeline.tsx:2809-2813}).
     *
     * @param seq     the event sequence number (drives the node id)
     * @param payload {@code message}
     * @return the {@code event:error} row
     */
    private static UiNode errorEventRow(long seq, Map<String, Object> payload) {
        Object reported = payload.get("message");
        String detail = (reported != null) ? String.valueOf(reported) : "";
        return eventRow(seq, EVENT_ERROR, "Error", detail, "danger");
    }

    /**
     * The {@code system-notice} card: the muted-tone notice (the upstream
     * default event presentation — the type as the label on the muted tone,
     * {@code MessagesTimeline.tsx:2779-2785}).
     *
     * @param seq     the event sequence number (drives the node id)
     * @param payload {@code text}, {@code label}
     * @return the {@code event:system-notice} row
     */
    private static UiNode systemNoticeEventRow(long seq, Map<String, Object> payload) {
        String label = textOf(payload, "label", "System notice");
        return eventRow(seq, EVENT_SYSTEM_NOTICE, label, textOf(payload, "text", ""), "muted");
    }

    /**
     * The {@code queued-message} card: the pending card with the left stripe
     * (the pending token colour) — the upstream queued intent marker rides
     * the user bubble ({@code MessagesTimeline.tsx:2313-2352}); the plan's
     * stripe card is the timeline-side pending presentation.
     *
     * @param seq     the event sequence number (drives the node id)
     * @param payload {@code text}
     * @return the {@code event:queued-message} row
     */
    private static UiNode queuedMessageEventRow(long seq, Map<String, Object> payload) {
        UiNode card = Ui.card()
                .id(eventId(seq) + "-card")
                .border(BORDER)
                .borderRadius(EVENT_RADIUS)
                // the left inset clears the 3px stripe painted over the edge
                .padding(List.of(12, 12, 12, 15))
                .child(Ui.text(textOf(payload, "text", "")).style("body").build())
                .build();
        UiNode stripe = Ui.positioned()
                .top(0).bottom(0).left(0).width(3)
                .child(Ui.box().color(WARNING).build())
                .build();
        UiNode stack = Ui.stack().id(eventId(seq) + "-stripe")
                .child(stripe)
                .child(card)
                .build();
        return rowContainer(KIND_EVENT, EVENT_QUEUED_MESSAGE, seq, null, 4, stack);
    }

    /**
     * The {@code subagent} card: the right-aligned subagent bar (the plan's
     * {@code self-end} alignment; the upstream bar is the
     * {@code ProviderSubagentBar} rounded strip with the provider icon, the
     * model label and the status, {@code ProviderSubagentBar.tsx:66-70}).
     *
     * @param seq     the event sequence number (drives the node id)
     * @param payload {@code title}, {@code status}
     * @return the {@code event:subagent} row
     */
    private static UiNode subagentEventRow(long seq, Map<String, Object> payload) {
        UiNode bar = Ui.card()
                .id(eventId(seq) + "-bar")
                .border(BORDER)
                .borderRadius(BUBBLE_RADIUS)
                .padding(12)
                .child(Ui.row().gap(8).align("center")
                        .child(Ui.icon().icon("smart_toy").size(16).color(MUTED).build())
                        .child(Ui.text(textOf(payload, "title", "Subagent"))
                                .style("small")
                                .maxLines(1)
                                .ellipsis(true)
                                .flex(1)
                                .build())
                        .child(statusChip(textOf(payload, "status", "running")))
                        .build())
                .build();
        return rowContainer(KIND_EVENT, EVENT_SUBAGENT, seq, "centerRight", 4, bar);
    }

    /**
     * The {@code citation} card: the inline citation pill (the upstream
     * {@code AssistantCitationChip} rides the {@code ContextChip} citation
     * kind — the blue accent, {@code ContextChip.tsx:60}; the Jhin pill is
     * the filled badge on the {@code info} token).
     *
     * @param seq     the event sequence number (drives the node id)
     * @param payload {@code label}
     * @return the {@code event:citation} row
     */
    private static UiNode citationEventRow(long seq, Map<String, Object> payload) {
        return rowContainer(KIND_EVENT, EVENT_CITATION, seq, null, 4,
                chip(textOf(payload, "label", "Citation"), INFO));
    }

    /**
     * The {@code skill-invocation} card: the inline skill pill (the upstream
     * {@code SkillChip} rides the {@code ContextChip} skill kind — the
     * magenta accent, {@code ContextChip.tsx:59}; the Jhin pill is the
     * filled badge on the {@code primary} token).
     *
     * @param seq     the event sequence number (drives the node id)
     * @param payload {@code name}
     * @return the {@code event:skill-invocation} row
     */
    private static UiNode skillInvocationEventRow(long seq, Map<String, Object> payload) {
        return rowContainer(KIND_EVENT, EVENT_SKILL_INVOCATION, seq, null, 4,
                chip(textOf(payload, "name", "skill"), "$color.primary"));
    }

    /**
     * The {@code work-log-entry} card: the work log row — the icon, the
     * label and the trailing timestamp on one line (the upstream
     * {@code WorkLogLine}, {@code WorkLog.tsx:31-45}).
     *
     * @param seq     the event sequence number (drives the node id)
     * @param payload {@code label}, {@code time}
     * @return the {@code event:work-log-entry} row
     */
    private static UiNode workLogEntryEventRow(long seq, Map<String, Object> payload) {
        String time = textOf(payload, "time", "");
        Ui.RowBuilder line = Ui.row().id(eventId(seq) + "-log").gap(8).align("center")
                .child(Ui.icon().icon("construction").size(16).color(MUTED).build())
                .child(Ui.text(textOf(payload, "label", "Work")).style("small")
                        .maxLines(1).ellipsis(true).flex(1).build());
        if (!time.isBlank()) {
            line.child(Ui.text(time).style("caption").color(MUTED).build());
        }
        return rowContainer(KIND_EVENT, EVENT_WORK_LOG_ENTRY, seq, null, 4, line.build());
    }

    /**
     * The {@code question} card: the question card with the answers — the
     * question text and one check-marked row per answer (the upstream
     * question heading leads the row identity,
     * {@code MessagesTimeline.tsx:5099-5104}).
     *
     * @param seq     the event sequence number (drives the node id)
     * @param payload {@code question}, {@code answers}
     * @return the {@code event:question} row
     */
    private static UiNode questionEventRow(long seq, Map<String, Object> payload) {
        Ui.CardBuilder card = Ui.card()
                .id(eventId(seq) + "-card")
                .border(BORDER)
                .borderRadius(EVENT_RADIUS)
                .padding(12);
        card.child(Ui.row().id(eventId(seq) + "-head").gap(8).align("center")
                .child(Ui.icon().icon("help_outline").size(16).color(MUTED).build())
                .child(Ui.text(textOf(payload, "question", "Question"))
                        .style("small").build())
                .build());
        for (Object raw : listOf(payload, "answers")) {
            card.child(Ui.row().gap(8).align("center")
                    .child(Ui.icon().icon("check_circle").size(14).color(SUCCESS).build())
                    .child(Ui.text(String.valueOf(raw)).style("caption").build())
                    .build());
        }
        return rowContainer(KIND_EVENT, EVENT_QUESTION, seq, null, 4, card.build());
    }

    /**
     * The unknown event card: the placeholder an unrecognized event type
     * falls back to instead of throwing (the same fallback contract the row
     * kinds carry).
     *
     * @param seq  the sequence number anchoring the row
     * @param type the unrecognized event type
     * @return the {@code event:unknown} row
     */
    private static UiNode unknownEventRow(long seq, String type) {
        UiNode card = Ui.card()
                .id(eventId(seq) + "-card")
                .border(BORDER)
                .borderRadius(EVENT_RADIUS)
                .padding(12)
                .child(Ui.text("Unknown event: " + (type == null ? "" : type))
                        .style("caption")
                        .color(MUTED)
                        .build())
                .build();
        return rowContainer(KIND_EVENT, EVENT_UNKNOWN, seq, null, 4, card);
    }

    // ------------------------------------------------------------------
    // the standard tool card (T102.1)
    // ------------------------------------------------------------------

    /**
     * The standard tool card (T102.1): the four-part anatomy the plan
     * specifies — the header (tool icon + name + status chip + chevron),
     * the collapsible argument summary line, the output region (markdown /
     * {@code code_block} / {@code diff_view}) and the footer (timestamp +
     * copy button). The upstream anchors (t3code commit 37de6cb): the work
     * row line with the trailing timestamp and the disclosure chevron
     * ({@code MessagesTimeline.tsx:5296-5330}), the tool output states with
     * the muted italic "No output." empty state
     * ({@code V2ItemInspector.tsx:143-158}) and the status chip words
     * ({@code ComposerTasksBadge.tsx:23-24}).
     *
     * <p><b>Expansion.</b> The expansion state is keyed by the row id: the
     * header chevron patches the body region ({@code ev-<seq>-body})
     * {@code visible: true} and the footer's collapse affordance patches it
     * back to {@code false} — both pure client-side directives, no server
     * round-trip. (The plan words this as {@code setState} keyed by row id;
     * the {@code when} degradation rule — an unset field keeps the node
     * visible, docs/sdui.md section 7 — cannot express a collapsed-by-default
     * region, so the patch/visible pair carries the same pure client-side
     * reveal. Recorded in the T102 evidence.)
     *
     * @param kind    the event kind ({@code tool-call}, {@code tool-result}
     *                or {@code shell}) — the {@code rowKey} subtype
     * @param seq     the event sequence number (drives the node ids)
     * @param payload {@code name}, {@code status}, {@code summary},
     *                {@code output}, {@code outputKind}, {@code language},
     *                {@code time}; the {@code diff} output kind reads
     *                {@code file}/{@code additions}/{@code deletions}/
     *                {@code hunks}
     * @return the {@code event:<kind>} row
     */
    public static UiNode toolCardRow(String kind, long seq, Map<String, Object> payload) {
        Map<String, Object> p = payload == null ? Map.of() : payload;
        String id = eventId(seq);
        // the expanded body first — the output region + the footer — so the
        // header chevron can carry its rendered content as the show patch
        List<UiNode> body = new ArrayList<>();
        body.add(outputRegion(seq, p));
        Ui.RowBuilder footer = Ui.row().id(id + "-footer").align("center").gap(8);
        String time = textOf(p, "time", "");
        if (!time.isBlank()) {
            footer.child(Ui.text(time).style("caption").color(MUTED).build());
        }
        footer.child(Ui.spacer().build());
        footer.child(Ui.iconButton().id(id + "-copy").icon("copy").iconSize(16)
                .action(Directives.setState(id + "-copy", true))
                .set("demo", true)
                .tooltip("Copy output")
                .build());
        footer.child(Ui.iconButton().id(id + "-collapse").icon("unfold_less")
                .iconSize(16)
                .action(Directives.patch(id + "-body", ""))
                .tooltip("Hide details")
                .build());
        body.add(footer.build());
        List<Object> bodyNodes = new ArrayList<>(body);
        Ui.CardBuilder card = Ui.card()
                .id(id + "-card")
                .border(BORDER)
                .borderRadius(EVENT_RADIUS)
                .padding(12);
        // header: tool icon + name + status chip + chevron
        card.child(Ui.row().id(id + "-head").align("center").gap(8)
                .child(Ui.icon().icon(iconOf(kind)).size(16).color(MUTED).build())
                .child(Ui.text(textOf(p, "name", "tool")).style("small").build())
                .child(statusChip(textOf(p, "status", "success")))
                .child(Ui.spacer().build())
                .child(Ui.iconButton().id(id + "-chevron").icon("expand_more")
                        .iconSize(16)
                        .action(Directives.patch(id + "-body", renderFragmentOf(bodyNodes)))
                        .tooltip("Show details")
                        .build())
                .build());
        // the collapsible argument summary line
        String summary = textOf(p, "summary", "");
        if (!summary.isBlank()) {
            card.child(Ui.text(summary).style("mono").color(MUTED)
                    .maxLines(1).ellipsis(true).build());
        }
        card.child(Ui.column().id(id + "-body").visible(false).gap(8)
                .children(bodyNodes).build());
        return rowContainer(KIND_EVENT, kind, seq, null, 4, card.build());
    }

    /**
     * The rendered inner content of one node list: the level-4
     * {@code patch} {@code html} a content swap carries — the nodes
     * themselves rendered, never the wrapping region (docs/sdui.md section
     * 9.5: {@code patch} replaces the inner HTML of the target).
     *
     * @param nodes the content nodes
     * @return the concatenated HTML fragments
     */
    private static String renderFragmentOf(List<Object> nodes) {
        StringBuilder html = new StringBuilder();
        for (Object node : nodes) {
            if (node instanceof UiNode inner) {
                html.append(HtmlRenderer.renderFragment(inner));
            }
        }
        return html.toString();
    }

    /**
     * The output region of the tool card: the {@code markdown} /
     * {@code code_block} / {@code diff_view} node the payload asks for, or
     * the muted italic "No output." empty state when the output is blank
     * (the upstream {@code ToolOutput} empty state,
     * {@code V2ItemInspector.tsx:148}).
     */
    private static UiNode outputRegion(long seq, Map<String, Object> payload) {
        String kind = textOf(payload, "outputKind", "code");
        String output = textOf(payload, "output", "");
        if ("diff".equals(kind)) {
            UiNode view = diffViewOf(seq, payload);
            if (view != null) {
                return view;
            }
        } else if ("markdown".equals(kind) && !output.isBlank()) {
            return Ui.markdown(output).id(eventId(seq) + "-output").build();
        } else if (!output.isBlank()) {
            Ui.CodeBlockBuilder block = Ui.codeBlock(output)
                    .id(eventId(seq) + "-output")
                    .copyable(true)
                    .maxLines(12);
            String language = textOf(payload, "language", "");
            if (!language.isBlank()) {
                block.language(language);
            }
            return block.build();
        }
        return emptyState(seq);
    }

    /** The muted italic "No output." empty-state region of an output-less card. */
    private static UiNode emptyState(long seq) {
        return Ui.text("No output.").style("caption").color(MUTED).italic(true)
                .id(eventId(seq) + "-empty").build();
    }

    /**
     * The {@code diff_view} node of a diff payload ({@code file},
     * {@code language}, {@code additions}, {@code deletions},
     * {@code hunks}); {@code null} when the payload carries no hunks — the
     * caller renders the empty state instead of a hunkless view. The view is
     * decorative and carries the mandatory {@code demo} marker.
     */
    private static UiNode diffViewOf(long seq, Map<String, Object> payload) {
        if (!(payload.get("hunks") instanceof List<?> hunks) || hunks.isEmpty()) {
            return null;
        }
        Ui.DiffViewBuilder view = Ui.diffView()
                .id(eventId(seq) + "-diff")
                .demo(true);
        String file = textOf(payload, "file", "");
        if (!file.isBlank()) {
            view.file(file);
        }
        String language = textOf(payload, "language", "");
        if (!language.isBlank()) {
            view.language(language);
        }
        Object additions = payload.get("additions");
        Object deletions = payload.get("deletions");
        if (additions instanceof Number a && deletions instanceof Number d) {
            view.stats(a, d);
        }
        view.hunks(new ArrayList<>((List<Object>) hunks));
        return view.build();
    }

    // ------------------------------------------------------------------
    // work family
    // ------------------------------------------------------------------

    /**
     * The collapsible detail of a {@code tool_use}: the compact arguments
     * JSON code block (language label {@code json}, copyable, {@code
     * maxLines} capped).
     *
     * @param arguments the raw arguments JSON text
     * @param seq       the event sequence number (drives the node id)
     * @return the detail node
     */
    public static UiNode toolArgumentsNode(String arguments, long seq) {
        return Ui.codeBlock(arguments == null ? "" : arguments)
                .id(eventId(seq) + "-args")
                .language("json")
                .wrap(false)
                .copyable(true)
                .maxLines(8)
                .lineNumbers(false)
                .semanticsLabel("tool call arguments")
                .build();
    }

    /**
     * The collapsible detail of a {@code tool_result}: the plain content
     * text, danger-tinted when the tool reported a failure.
     *
     * @param content the plain text content
     * @param error   whether the tool reported a failure
     * @param seq     the event sequence number (drives the node id)
     * @return the detail node
     */
    public static UiNode toolResultNode(String content, boolean error, long seq) {
        Ui.TextBuilder text = Ui.text(content == null ? "" : content).style("body");
        if (error) {
            text.color(DANGER);
        }
        return text.id(eventId(seq) + "-result").build();
    }

    /**
     * The work row: one collapsible tool entry (the upstream
     * {@code WorkLogRow} line inside a collapsible section,
     * {@code WorkLog.tsx:63-77}).
     *
     * @param seq     the event sequence number (drives the node id)
     * @param label   the collapsed header label (tool + summary)
     * @param details the collapsible detail nodes (arguments, output)
     * @return the {@code work:log} row
     */
    public static UiNode workRow(long seq, String label, List<UiNode> details) {
        Map<String, Object> section = new LinkedHashMap<>();
        section.put("id", eventId(seq) + "-section");
        section.put("label", label == null || label.isBlank() ? "Work" : label);
        section.put("collapsible", true);
        section.put("collapsed", true);
        section.put("items", new ArrayList<>(details == null ? List.<UiNode>of() : details));
        UiNode list = Ui.list().id(eventId(seq) + "-list")
                .sections(List.of(section))
                .build();
        return rowContainer(KIND_WORK, "log", seq, null, 0, list);
    }

    /**
     * The work-live row: the inline live tool entry with the accent shine —
     * the accent label plus the pulsing indeterminate indicator standing in
     * for the upstream {@code live-tool-shine} keyframe
     * ({@code MessagesTimeline.tsx:3611-3646}, {@code index.css:502-526}).
     *
     * @param seq   the sequence number anchoring the row
     * @param label the live activity label
     * @return the {@code work-live:log} row
     */
    public static UiNode workLiveRow(long seq, String label) {
        UiNode line = Ui.row().id(eventId(seq) + "-live")
                .align("center")
                .gap(8)
                .child(Ui.icon().icon("bolt").size(16).color(ACCENT).build())
                .child(Ui.text(label == null || label.isBlank() ? "Working" : label)
                        .style("small")
                        .color(ACCENT)
                        .build())
                .child(Ui.spacer().build())
                .child(Ui.progress().kind("linear").statusPulse("pulse")
                        .width(48).build())
                .build();
        return rowContainer(KIND_WORK_LIVE, "log", seq, null, 0, line);
    }

    /**
     * The work-toggle row: the collapsed group header with the hidden-entry
     * count (upstream {@code WorkGroupToggleTimelineRow},
     * {@code MessagesTimeline.tsx:3701-3712}).
     *
     * @param seq     the sequence number anchoring the row
     * @param summary the group summary label
     * @param count   how many entries the group hides
     * @return the {@code work-toggle:log} row
     */
    public static UiNode workToggleRow(long seq, String summary, int count) {
        UiNode line = Ui.row().id(eventId(seq) + "-toggle")
                .align("center")
                .gap(8)
                .child(Ui.icon().icon("construction").size(16).color(MUTED).build())
                .child(Ui.text(summary == null || summary.isBlank() ? "Work" : summary)
                        .style("small")
                        .build())
                .child(Ui.badge().count(count).build())
                .child(Ui.spacer().build())
                .child(Ui.icon().icon("expand_more").size(16).color(MUTED).build())
                .build();
        return rowContainer(KIND_WORK_TOGGLE, "log", seq, null, 0, line);
    }

    /**
     * The thinking row: the collapsible brain block (upstream
     * {@code ThinkingTimelineRow}, {@code MessagesTimeline.tsx:3487-3501}).
     *
     * @param seq    the sequence number anchoring the row
     * @param detail the reasoning preview, may be blank
     * @return the {@code thinking:log} row
     */
    public static UiNode thinkingRow(long seq, String detail) {
        Map<String, Object> section = new LinkedHashMap<>();
        section.put("id", eventId(seq) + "-section");
        section.put("label", "Thinking");
        section.put("collapsible", true);
        section.put("collapsed", true);
        section.put("items", List.of(Ui.text(detail == null ? "" : detail)
                .style("caption")
                .color(MUTED)
                .build()));
        UiNode list = Ui.list().id(eventId(seq) + "-list")
                .sections(List.of(section))
                .build();
        return rowContainer(KIND_THINKING, "log", seq, null, 0, list);
    }

    // ------------------------------------------------------------------
    // plan, working, setup, folds, compaction
    // ------------------------------------------------------------------

    /**
     * The proposed-plan row: the plan card with the decorative Accept/Reject
     * buttons (upstream {@code ProposedPlanCard} carries copy/save/expand —
     * the accept/reject pair is the plan's decorative contract).
     *
     * @param seq      the sequence number anchoring the row
     * @param markdown the plan markdown
     * @return the {@code proposed-plan:plan} row
     */
    public static UiNode proposedPlanRow(long seq, String markdown) {
        UiNode card = Ui.card()
                .id(eventId(seq) + "-card")
                .border(BORDER)
                .borderRadius(EVENT_RADIUS)
                .padding(12)
                .child(Ui.markdown(markdown == null ? "" : markdown).build())
                .child(Ui.row().gap(8)
                        .child(Ui.button("Accept")
                                .style("primary")
                                .action(Directives.setState("plan-" + seq, true))
                                .set("demo", true)
                                .build())
                        .child(Ui.button("Reject")
                                .action(Directives.setState("plan-" + seq, false))
                                .set("demo", true)
                                .build())
                        .build())
                .build();
        return rowContainer(KIND_PROPOSED_PLAN, "plan", seq, null, 4, card);
    }

    /**
     * The working row: the spinner strip (upstream
     * {@code WorkingTimelineRow}, {@code MessagesTimeline.tsx:3405-3422} —
     * the plan's label wording).
     *
     * @param seq the sequence number anchoring the row
     * @return the {@code working:run} row
     */
    public static UiNode workingRow(long seq) {
        UiNode line = Ui.row().id(eventId(seq) + "-working")
                .align("center")
                .gap(8)
                .child(Ui.progress().kind("circular").width(14).height(14).build())
                .child(Ui.text(WORKING_LABEL).style("small").color(MUTED).build())
                .build();
        return rowContainer(KIND_WORKING, "run", seq, null, 0, line);
    }

    /**
     * The worktree-setup row: the decorative setup status card (upstream
     * {@code WorktreeSetupCard}).
     *
     * @param seq   the sequence number anchoring the row
     * @param phase the setup phase ({@code running}|{@code failed}|{@code
     *              done})
     * @param label the status line
     * @return the {@code worktree-setup:setup} row
     */
    public static UiNode worktreeSetupRow(long seq, String phase, String label) {
        UiNode card = Ui.card()
                .id(eventId(seq) + "-card")
                .border(BORDER)
                .borderRadius(EVENT_RADIUS)
                .padding(12)
                .title("Setting up worktree")
                .child(Ui.row().gap(8).align("center")
                        .child(Ui.badge().label(phase == null || phase.isBlank()
                                ? "running" : phase).build())
                        .child(Ui.text(label == null || label.isBlank()
                                        ? "Preparing the workspace" : label)
                                .style("caption")
                                .color(MUTED)
                                .build())
                        .build())
                .set("demo", true)
                .build();
        return rowContainer(KIND_WORKTREE_SETUP, "setup", seq, null, 4, card);
    }

    /**
     * The turn-fold row: the centered fold affordance (upstream
     * {@code TurnFoldTimelineRow}, {@code MessagesTimeline.tsx:2448-2470} —
     * the plan centers it).
     *
     * @param seq   the sequence number anchoring the row
     * @param label the fold label (e.g. {@code "1 earlier turn"})
     * @return the {@code turn-fold:fold} row
     */
    public static UiNode turnFoldRow(long seq, String label) {
        UiNode line = Ui.row().id(eventId(seq) + "-fold")
                .align("center")
                .gap(4)
                .child(Ui.text(label == null || label.isBlank()
                                ? "Earlier turn" : label)
                        .style("caption")
                        .color(MUTED)
                        .build())
                .child(Ui.icon().icon("expand_more").size(14).color(MUTED).build())
                .action(Directives.setState("fold-" + seq, true))
                .set("demo", true)
                .build();
        return rowContainer(KIND_TURN_FOLD, "fold", seq, "center", 0, line);
    }

    /**
     * The attempt-fold row: the centered superseded-attempt affordance
     * (upstream {@code AttemptFoldTimelineRow},
     * {@code MessagesTimeline.tsx:2472-2492} — the plan centers it).
     *
     * @param seq   the sequence number anchoring the row
     * @param label the fold label
     * @return the {@code attempt-fold:fold} row
     */
    public static UiNode attemptFoldRow(long seq, String label) {
        UiNode line = Ui.row().id(eventId(seq) + "-fold")
                .align("center")
                .gap(4)
                .child(Ui.text(label == null || label.isBlank()
                                ? "Superseded attempt" : label)
                        .style("caption")
                        .color(MUTED)
                        .build())
                .child(Ui.icon().icon("expand_more").size(14).color(MUTED).build())
                .action(Directives.setState("fold-" + seq, true))
                .set("demo", true)
                .build();
        return rowContainer(KIND_ATTEMPT_FOLD, "fold", seq, "center", 0, line);
    }

    /**
     * The context-compaction row: the centered divider banner (upstream
     * {@code ContextCompactionTimelineRow},
     * {@code MessagesTimeline.tsx:1862-1898}).
     *
     * @param seq    the sequence number anchoring the row
     * @param label  the compaction label
     * @param active whether the compaction is running (the accent tone)
     * @return the {@code context-compaction:compaction} row
     */
    public static UiNode contextCompactionRow(long seq, String label, boolean active) {
        String tone = active ? ACCENT : MUTED;
        UiNode line = Ui.row().id(eventId(seq) + "-compaction")
                .align("center")
                .gap(12)
                .child(Ui.box().height(1).flex(1).color(BORDER).build())
                .child(Ui.icon().icon("compress").size(14).color(tone).build())
                .child(Ui.text(label == null || label.isBlank()
                                ? "Context compacted" : label)
                        .style("caption")
                        .color(tone)
                        .build())
                .child(Ui.box().height(1).flex(1).color(BORDER).build())
                .build();
        return rowContainer(KIND_CONTEXT_COMPACTION, "compaction", seq, null, 0, line);
    }

    /**
     * The unknown row: the placeholder a row of an unrecognized kind falls
     * back to instead of throwing (the plan's failure contract).
     *
     * @param seq  the sequence number anchoring the row
     * @param kind the unrecognized kind text
     * @return the {@code unknown:unknown} row
     */
    public static UiNode unknownRow(long seq, String kind) {
        UiNode card = Ui.card()
                .id(eventId(seq) + "-card")
                .border(BORDER)
                .borderRadius(EVENT_RADIUS)
                .padding(12)
                .child(Ui.text("Unknown row: " + (kind == null ? "" : kind))
                        .style("caption")
                        .color(MUTED)
                        .build())
                .build();
        return rowContainer(KIND_UNKNOWN, "unknown", seq, null, 4, card);
    }

    // ------------------------------------------------------------------
    // run status badge (the T77 composer status line)
    // ------------------------------------------------------------------

    /**
     * The run status badge of the composer status line.
     *
     * @param label the status label ({@value #STATUS_RUNNING},
     *              {@value #STATUS_IDLE} or {@value #STATUS_LIMITED})
     * @param color the badge color token, {@code null} for the default
     * @return the badge node
     */
    public static UiNode runBadge(String label, String color) {
        Ui.BadgeBuilder badge = Ui.badge().id(STATUS_ID).label(label);
        if (color != null) {
            badge.color(color);
        }
        return badge.build();
    }

    /**
     * The status props one run frame patches onto the badge.
     *
     * @param label the status label
     * @param color the badge color token or {@code null}
     * @return the patch props
     */
    public static Map<String, Object> statusProps(String label, String color) {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("label", label);
        props.put("color", color);
        return props;
    }

    // ------------------------------------------------------------------
    // shared pieces
    // ------------------------------------------------------------------

    /**
     * The row envelope: a column container carrying {@code rowKind},
     * {@code rowKey}, the optional alignment and the inner gap.
     */
    private static UiNode rowContainer(String kind, String subtype, long seq,
                                       String align, int gap, UiNode... children) {
        Ui.ContainerBuilder container = Ui.container()
                .id(eventId(seq))
                .direction("column")
                .gap(gap)
                .set(ROW_KIND_PROP, kind)
                .set(ROW_KEY_PROP, rowKey(kind, subtype));
        if (align != null) {
            container.align(align);
        }
        for (UiNode child : children) {
            container.child(child);
        }
        return container.build();
    }

    /**
     * The hover-action stubs of the message rows: small demo-marked icon
     * buttons dispatching inline {@code setState} stubs (no clipboard, no
     * retry backend — plan section 14.10 marks them decorative).
     */
    private static UiNode hoverActions(String id, List<String> actions) {
        Ui.RowBuilder row = Ui.row().id(id).align("center").gap(2);
        for (int i = 0; i < actions.size(); i++) {
            String action = actions.get(i);
            row.child(Ui.button(action)
                    .action(Directives.setState(id + "-" + action, true))
                    .set("demo", true)
                    .build());
        }
        return row.build();
    }

    /** The event icon per item type (the upstream presentation icons). */
    private static String iconOf(String type) {
        return switch (type == null ? "" : type) {
            case "error", "run_interrupt_request" -> "warning";
            case "run_interrupt_result" -> "block";
            case "handoff" -> "bolt";
            case "fork" -> "call_split";
            case "compaction" -> "compress";
            case "todo_list" -> "check";
            // the T102 event kinds
            case EVENT_DIFF -> "difference";
            case EVENT_FILE_WRITE -> "edit_note";
            case EVENT_SHELL -> "terminal";
            case EVENT_TOOL_CALL, EVENT_TOOL_RESULT, EVENT_WORK_LOG_ENTRY -> "construction";
            case EVENT_APPROVAL_REQUEST -> "gpp_maybe";
            case EVENT_LIMIT_NOTICE -> "speed";
            case EVENT_SYSTEM_NOTICE -> "info";
            case EVENT_QUEUED_MESSAGE -> "schedule";
            case EVENT_SUBAGENT -> "smart_toy";
            case EVENT_CITATION -> "format_quote";
            case EVENT_SKILL_INVOCATION -> "auto_awesome";
            case EVENT_QUESTION, EVENT_UNKNOWN -> "help_outline";
            default -> "construction";
        };
    }

    /** Parses a structured payload; {@code null} when absent or malformed. */
    public static Map<String, Object> parseObject(String structured) {
        if (structured == null || structured.isBlank()) {
            return null;
        }
        try {
            return Json.readMap(structured);
        } catch (RuntimeException e) {
            return null;
        }
    }

    // ------------------------------------------------------------------
    // payload helpers (the T102 event payloads)
    // ------------------------------------------------------------------

    /** The {@code text} field of a payload, or the default when absent. */
    private static String textOf(Map<String, Object> payload, String key, String def) {
        Object value = payload.get(key);
        return (value == null) ? def : String.valueOf(value);
    }

    /** The {@code int} field of a payload, {@code 0} when absent or malformed. */
    private static int intOf(Map<String, Object> payload, String key) {
        return (payload.get(key) instanceof Number number) ? number.intValue() : 0;
    }

    /** The {@code List} field of a payload, empty when absent or of another shape. */
    private static List<?> listOf(Map<String, Object> payload, String key) {
        return (payload.get(key) instanceof List<?> list) ? list : List.of();
    }

    /** The {@code files} array of a changed-files payload as maps. */
    private static List<Map<String, Object>> filesOf(Map<String, Object> payload) {
        List<Map<String, Object>> files = new ArrayList<>();
        for (Object raw : listOf(payload, "files")) {
            if (raw instanceof Map<?, ?> map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> file = (Map<String, Object>) map;
                files.add(file);
            }
        }
        return files;
    }
}
