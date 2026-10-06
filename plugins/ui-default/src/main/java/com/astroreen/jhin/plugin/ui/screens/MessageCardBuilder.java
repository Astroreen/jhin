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
 * computes the same table client-side ({@code stream_view.dart}).
 *
 * <p>All keys are documented contract props (docs/sdui.md sections 2.1 and
 * 2.6); color references are {@code $color.*}/{@code $radius.*} tokens so
 * the client theme stays authoritative.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.ui.Directives;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
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
                .child(Ui.markdown(text == null ? "" : text).id(messageId(seq)).build())
                .build();
        return rowContainer(KIND_MESSAGE, "assistant", seq, "centerLeft", 4, card);
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
            case "warning" -> "$color.warning";
            case "success" -> "$color.success";
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
     * The event dispatcher: maps one event payload to its event row. The
     * T102 kinds refine the anatomy; today the Jhin {@code error} wire event
     * lands on the danger tone and anything else on the muted tone with the
     * type as the label (the upstream default presentation,
     * {@code MessagesTimeline.tsx:2748-2766}).
     *
     * @param type    the event item type
     * @param payload the event payload
     * @param seq     the event sequence number
     * @return the dispatched event row
     */
    public static UiNode dispatchEventRow(String type, Map<String, Object> payload, long seq) {
        Object reported = payload.get("message");
        String detail = (reported != null) ? String.valueOf(reported) : "";
        boolean danger = "error".equals(type);
        return eventRow(seq, type, danger ? "Error" : type, detail,
                danger ? "danger" : "muted");
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
            default -> "construction";
        };
    }

    /** Parses a structured payload; {@code null} when absent or malformed. */
    static Map<String, Object> parseObject(String structured) {
        if (structured == null || structured.isBlank()) {
            return null;
        }
        try {
            return Json.readMap(structured);
        } catch (RuntimeException e) {
            return null;
        }
    }
}
