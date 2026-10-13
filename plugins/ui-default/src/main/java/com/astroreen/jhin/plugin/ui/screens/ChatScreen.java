/**
 * The {@code chat:<session-id>} screen: the chat frame (T100) — the header
 * row, the content lane, the scroll-anchored timeline and the docked
 * composer — around the T77 conversation surface.
 *
 * <p><b>Frame.</b> The body is a stack: the chat frame column (the chat
 * header row, then the content lane filling the rest) with the T105 right
 * panel overlaid at the right edge. The lane (id {@code chat-lane}) carries
 * the {@code laneWidth} prop — the server-side default {@value #LANE_WIDTH},
 * the upstream {@code --chat-content-max-width} root default (t3code
 * {@code apps/web/src/index.css:128}, commit {@code 37de6cb}); the client
 * resolves the effective width from its {@code chatWidth} switch (T86) the
 * same way upstream sets the variable per {@code data-chat-width} on
 * {@code :root} ({@code __root.tsx:277-280}). Inside the lane the timeline
 * scrolls under a top {@code scroll_fade} (the upstream messages-timeline
 * fade, {@code MessagesTimeline.tsx:1377}), the composer-seam divider
 * paints the {@code --background-image-composer-seam-above} recipe
 * (index.css:207-215 — the 10 px shade hugging the composer's top edge,
 * fading upward) and the composer docks at the bottom on the reserved
 * {@code composer} surface id (the client paints {@code --shadow-composer}
 * and the bottom safe-area inset there, T87).
 *
 * <p><b>Header row.</b> The thread title, the run status badge (the status
 * indicator) and the actions: the right-panel and terminal toggles —
 * inline {@code setState} shells marked {@code demo} (the E-phase panels
 * do not exist yet) — and the thread action menu with the real lifecycle
 * actions (the upstream header menu is the thread action menu,
 * {@code ChatHeader.tsx} + {@code useThreadActionMenu}).
 *
     * <p><b>Message list.</b> The persisted event history renders through
     * {@link MessageCardBuilder} into the T101 timeline rows of a {@code
     * list}: user messages as the {@code message:user} bubble on the message
     * surface, assistant messages as the bordered {@code message:assistant}
     * card with markdown text, collapsible {@code work:log} entries for the
     * tool events, the {@code event:error} row and the {@code working} strip
     * of an open run. Consecutive rows sharing a continuation key close with
     * no gap ({@link MessageCardBuilder#applyContinuation}). The ids ({@code
     * ev-<seq>}, {@code msg-<seq>}) are the same ones {@code EventFrames}
     * emits, so live frames patch the rendered history in place.
 *
 * <p><b>Live tail.</b> The {@code stream_view} ({@code id} {@code stream},
 * {@code itemLimit} {@code 200}, {@code autoScroll}) opens
 * {@code /ui/stream/session/<id>} with {@code fromSeq} set to the last
 * rendered sequence number, so the replay continues after the pre-rendered
 * list instead of duplicating it; patches aimed at a rendered message id fall
 * back to the screen and grow the bubble in place. The client anchors the
 * tail: appended items jump to the bottom while the view follows the end, a
 * patch preserves the position, and the tail reserves the upstream
 * {@code CHAT_TIMELINE_ANCHOR_OFFSET} (24 px,
 * {@code timelineScrollAnchoring.ts:39}) as the end inset.
 *
 * <p><b>Composer.</b> The full upstream control surface (T103): the header
 * row of decorative pickers (model, provider, effort, access mode, workspace,
 * branch, host — each a {@code demo} button whose picker opens a dialog list
 * that sets local state and toasts, the upstream control-row anatomy,
 * {@code ChatComposer.tsx:5375-5555} + {@code ComposerControl.tsx}), the
 * context chips row (the upstream {@code ContextChip} pill kinds,
 * {@code ContextChip.tsx:25-83}), the decorative context-window meter (the
 * plan's gradient bar, green / yellow / red at the 50 / 80% marks) and the
 * footer row — attach ({@code Paperclip}, {@code ChatComposer.tsx:7496-7504}),
 * voice (the plan adds a Microphone affordance; upstream has none in the
 * composer), the stash menu (the {@code ComposerStashMenu} shell), the queue
 * indicator badge, the send split-button (Direct / Queue / Steer) and the
 * stop button ({@code Square}, visible only while a run is live — the
 * upstream destructive round stop, {@code ComposerPrimaryActions.tsx:123-145}).
 * The textarea carries the reserved id {@code messageInput} the Send action
 * and the T68 keyboard layer operate on, renders at the prompt font size
 * (the upstream {@code --font-size-prompt-touch} floor, index.css:131) and
 * holds the {@value #COMPOSER_MIN_HEIGHT}px minimum height growing with
 * content. Send posts to the {@code send} action ({@code POST
 * /ui/action/send} with {@code sessionId} and the included {@code
 * messageInput}); the stop button posts the real {@code cancel} action. The
 * pickers seed their decorative defaults into the client state (the
 * invisible {@code value} carriers) so their labels interpolate live —
 * selecting an option changes the visible label and toasts, never the
 * server. The status badge reads {@code Running\u2026} while the last
 * {@code run_start} is unpaired, {@code Limited} when the last run closed
 * with an {@code error} and {@code Idle} otherwise.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.ui.Directives;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.json.Json;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class ChatScreen {

    /** Path prefix of the session stream endpoint the UI plugin serves. */
    private static final String STREAM_TOPIC_PREFIX = "/ui/stream/session/";

    /** The input id the send action and the composer commands include. */
    private static final String MESSAGE_INPUT = "messageInput";

    /** The content lane id and its server-side default width (T100). */
    public static final String LANE_ID = "chat-lane";

    /**
     * The lane width default: the upstream {@code --chat-content-max-width}
     * root default (index.css:128). The client's {@code chatWidth} switch
     * resolves the effective lane from it (46rem normal / 72rem wide / full).
     */
    public static final String LANE_WIDTH = "46rem";

    /** The chat header row id. */
    public static final String HEADER_ID = "chat-header";

    /** The composer-seam divider id (the painted seam-above recipe). */
    public static final String SEAM_ID = "composer-seam";

    /** The timeline region id (the scroll-fade child). */
    public static final String TIMELINE_ID = "chat-timeline";

    /** UiState ids of the decorative panel toggles (the E-phase panels). */
    public static final String STATE_RIGHT_PANEL = "chat_right_panel";
    public static final String STATE_TERMINAL = "chat_terminal";

    /** The composer surface id (the client paints shadow.composer there). */
    public static final String COMPOSER_ID = "composer";

    /** The composer header control row id. */
    public static final String CONTROLS_ID = "composer-controls";

    /** The context chips row id. */
    public static final String CHIPS_ID = "composer-chips";

    /** The context-window meter id. */
    public static final String METER_ID = "context-meter";

    /** The composer footer row id. */
    public static final String FOOTER_ID = "composer-footer";

    /** The stop button id (visible only while a run is live). */
    public static final String STOP_ID = "composer-stop";

    /** The queue indicator badge id. */
    public static final String QUEUE_BADGE_ID = "queue-badge";

    /**
     * The composer minimum height in px (the plan's {@code
     * COMPOSER_MIN_HEIGHT}); the textarea grows with its content above it.
     */
    public static final int COMPOSER_MIN_HEIGHT = 160;

    /** The UiState ids of the decorative picker selections (T103). */
    public static final String STATE_MODEL = "chat_model";
    public static final String STATE_PROVIDER = "chat_provider";
    public static final String STATE_EFFORT = "chat_effort";
    public static final String STATE_MODE = "chat_mode";
    public static final String STATE_WORKSPACE = "chat_workspace";
    public static final String STATE_BRANCH = "chat_branch";
    public static final String STATE_HOST = "chat_host";

    /** The UiState id of the send split-button's dispatch mode (T103). */
    public static final String STATE_DISPATCH = "chat_dispatch";

    /** The composer picker control node ids (the T103 chords open these). */
    public static final String PICKER_MODEL = "composer-model-picker";
    public static final String PICKER_PROVIDER = "composer-provider-picker";
    public static final String PICKER_EFFORT = "composer-effort-picker";
    public static final String PICKER_MODE = "composer-mode-picker";
    public static final String PICKER_WORKSPACE = "composer-workspace-picker";
    public static final String PICKER_BRANCH = "composer-branch-picker";
    public static final String PICKER_HOST = "composer-host-picker";

    /** The T108 permissions dialog ids (the access-mode picker shell). */
    public static final String PERMISSIONS_DIALOG_ID = "composer-mode-dialog";
    public static final String PERMISSIONS_MODES_ID = "permissions-modes";
    public static final String PERMISSIONS_NOTE_ID = "permissions-note";
    public static final String PERMISSIONS_SAVE_ID = "permissions-save";

    /** The T108 permission-mode rows (the upstream access modes). */
    public static final List<String> PERMISSION_MODES =
            List.of("Read only", "Ask", "Full access");

    /** The seam shade: the recipe's {@code rgb(0 0 0 / 18%)} as AARRGGBB. */
    private static final String SEAM_SHADE = "#2E000000";

    /** The seam gradient's transparent end. */
    private static final String SEAM_CLEAR = "#00000000";

    private ChatScreen() {
    }

    /**
     * Builds the chat screen of one session.
     *
     * @param session the session the screen is opened for
     * @param history the stored events of the session in sequence order
     * @return the screen node
     */
    public static UiNode render(Session session, List<EventRecord> history) {
        String sessionId = session.id();
        String status = statusOf(history);
        boolean runLive = MessageCardBuilder.STATUS_RUNNING.equals(status);
        return Ui.screen()
                .title(session.title())
                .body(Ui.stack()
                        .id("chat-frame-stack")
                        .fit("expand")
                        .child(Ui.column()
                                .id("chat-frame")
                                .gap(0)
                                .child(header(session, status))
                                .child(Ui.expanded()
                                        .child(lane(sessionId, history, runLive))
                                        .build())
                                .build())
                        .child(RightPanelBuilder.build(session, status))
                        .build())
                .build();
    }

    /** The run status badge label derived from the run events of the history. */
    static String statusOf(List<EventRecord> history) {
        boolean open = false;
        boolean limited = false;
        for (EventRecord record : history) {
            switch (record.type().wire()) {
                case "run_start" -> open = true;
                case "run_end" -> {
                    open = false;
                    limited = false;
                }
                case "error" -> {
                    open = false;
                    limited = true;
                }
                default -> {
                }
            }
        }
        return open ? MessageCardBuilder.STATUS_RUNNING
                : limited ? MessageCardBuilder.STATUS_LIMITED
                : MessageCardBuilder.STATUS_IDLE;
    }

    /** The settled run duration label, e.g. {@code "1.4s"} (locale-free). */
    private static String durationLabel(long millis) {
        if (millis < 0) {
            return "";
        }
        long tenths = millis / 100;
        return (tenths / 10) + "." + (tenths % 10) + "s";
    }

    private static String statusColor(String status) {
        return switch (status) {
            case MessageCardBuilder.STATUS_RUNNING -> "$color.accent";
            case MessageCardBuilder.STATUS_LIMITED -> MessageCardBuilder.DANGER;
            default -> null;
        };
    }

    /**
     * The chat header row (T100): the thread title, the run status badge and
     * the actions — the T303 context chip (model + provider + workdir path
     * chip) beside the two demo-marked panel toggles (inline {@code
     * setState} shells; the E-phase panels do not exist yet) and the thread
     * action menu with the real lifecycle actions. The chip inserts before
     * the trailing menu, so the asserted child anchors (title, status badge,
     * trailing menu) keep their positions.
     */
    private static UiNode header(Session session, String status) {
        Ui.RowBuilder header = Ui.row()
                .id(HEADER_ID)
                .align("center")
                .gap(8)
                .padding(List.of(12, 16))
                .child(Ui.text(session.title())
                        .fontSize(14)
                        .fontWeight(600)
                        .maxLines(1)
                        .build())
                .child(MessageCardBuilder.runBadge(status, statusColor(status)))
                .child(Ui.spacer().build())
                .child(panelToggle(STATE_RIGHT_PANEL, "view_sidebar"))
                .child(panelToggle(STATE_TERMINAL, "dock"));
        if (MessageCardBuilder.hasContext(session.model(), session.providerId(), session.workdir())) {
            header.child(MessageCardBuilder.contextChip("context-chip",
                    session.model(), session.providerId(), session.workdir()));
        }
        return header.child(headerMenu(session)).build();
    }

    /**
     * One decorative panel toggle: an icon button whose tap runs the inline
     * {@code setState} that the E-phase panel will read. It has no visible
     * effect yet, so it carries the {@code demo} marker (plan section 14.10).
     */
    private static UiNode panelToggle(String stateId, String icon) {
        return Ui.iconButton()
                .id(stateId + "-toggle")
                .icon(icon)
                .action(Directives.setState(stateId, true))
                .tooltip("Toggle panel")
                .set("demo", true)
                .build();
    }

    /**
     * The thread action menu of the header (the upstream header menu is the
     * thread action menu): the real lifecycle actions of this session —
     * pin/unpin, settle/un-settle, the snooze presets (or Wake while
     * snoozed), regenerate title, archive and delete.
     */
    private static UiNode headerMenu(Session session) {
        String id = session.id();
        long now = System.currentTimeMillis();
        boolean snoozed = session.snoozedUntil() != null && session.snoozedUntil() > now;
        Ui.MenuBuilder menu = Ui.menu()
                .trigger(Ui.iconButton().icon("more_vert")
                        .action(ActionDescriptors.of("noop"))
                        .build());
        if (session.pinned()) {
            menu.item(Ui.menuItem("Unpin thread")
                    .icon("keep_off")
                    .action(ActionDescriptors.of("unpin", Map.of("id", id), null))
                    .build());
        } else {
            menu.item(Ui.menuItem("Pin thread")
                    .icon("keep")
                    .action(ActionDescriptors.of("pin", Map.of("id", id), null))
                    .build());
        }
        if (session.settledAt() != null) {
            menu.item(Ui.menuItem("Un-settle thread")
                    .icon("check_circle")
                    .action(ActionDescriptors.of("unsettle", Map.of("id", id), null))
                    .build());
        } else {
            menu.item(Ui.menuItem("Settle thread")
                    .icon("check_circle")
                    .action(ActionDescriptors.of("settle", Map.of("id", id), null))
                    .build());
        }
        if (snoozed) {
            menu.item(Ui.menuItem("Wake thread")
                    .icon("schedule")
                    .action(ActionDescriptors.of("wake", Map.of("id", id), null))
                    .build());
        } else {
            menu.item(Ui.menuItem("Snooze")
                    .icon("schedule")
                    .children(SidebarBuilder.snoozeChildren(id, now))
                    .build());
        }
        menu.item(Ui.menuItem("Regenerate title")
                .icon("refresh")
                .separatorBefore(true)
                .action(ActionDescriptors.of("regenerate-title", Map.of("id", id), null))
                .build());
        menu.item(Ui.menuItem("Archive thread")
                .icon("archive")
                .separatorBefore(true)
                .action(ActionDescriptors.of("archive", Map.of("id", id), null))
                .confirm("Archive this thread?")
                .build());
        menu.item(Ui.menuItem("Delete")
                .icon("delete")
                .action(ActionDescriptors.of("delete-session", Map.of("id", id), null))
                .confirm("Delete this thread? This cannot be undone.")
                .danger(true)
                .build());
        return menu.build();
    }

    /**
     * The content lane (T100): the timeline scrolling under a top scroll
     * fade, the composer-seam divider and the docked composer, all centered
     * at the {@code laneWidth} default the client resolves through its
     * {@code chatWidth} switch.
     */
    private static UiNode lane(String sessionId, List<EventRecord> history, boolean runLive) {
        return Ui.container()
                .id(LANE_ID)
                .direction("column")
                .gap(0)
                .set("laneWidth", LANE_WIDTH)
                // flex 1: inside a container the expanded node needs the
                // explicit flex for the universal Expanded wrap — a plain
                // child of a column gets unbounded height (the scroll_fade
                // and the timeline under it would crash).
                .child(Ui.expanded()
                        .flex(1)
                        .child(Ui.scrollFade()
                                .edge("top")
                                .child(timeline(sessionId, history))
                                .build())
                        .build())
                .child(seam())
                .child(composer(sessionId, runLive))
                .build();
    }

    /**
     * The timeline region: the transcript list filling the height and the
     * live tail below it (the T77 shape; T101 unifies the rows).
     */
    private static UiNode timeline(String sessionId, List<EventRecord> history) {
        return Ui.column()
                .id(TIMELINE_ID)
                .gap(8)
                .child(Ui.expanded()
                        .child(messageList(history))
                        .build())
                .child(liveTail(sessionId, history))
                .build();
    }

    /**
     * The composer-seam divider (T100): the painted port of the upstream
     * {@code --background-image-composer-seam-above} recipe (index.css:207-215)
     * at its default zero attachment overlap — a 10 px band of
     * {@code rgb(0 0 0 / 18%)} hugging the composer's top edge and fading
     * upward. The recipe's second layer (the 1% white fill of the
     * seam-below variant) is imperceptible at this scale and is not
     * painted.
     *
     * <p>The gradient spec is emitted without the {@code type} key: the
     * client defaults a typeless gradient to {@code linear}
     * (docs/sdui.md section 2.1), and a literal {@code "type": "linear"}
     * inside a prop map would read as a node discriminator to every
     * primitive-catalog walker (the section 2.5 guards).
     */
    private static UiNode seam() {
        Map<String, Object> gradient = new LinkedHashMap<>();
        gradient.put("begin", "bottomCenter");
        gradient.put("end", "topCenter");
        gradient.put("colors", List.of(SEAM_SHADE, SEAM_CLEAR));
        return Ui.box()
                .id(SEAM_ID)
                .height(10)
                .alignment("center")
                .child(Ui.sizedBox().build())
                .gradient(gradient)
                .build();
    }

    /**
     * The scrollable timeline: the T101 rows of the persisted history in
     * sequence order — {@code message} bubbles, {@code work} tool entries,
     * the {@code event} error row, the {@code working} strip of an open run
     * — with the continuation gaps baked in (rows sharing a continuation key
     * close with no gap). An open assistant message is flushed as-is.
     */
    private static UiNode messageList(List<EventRecord> history) {
        List<UiNode> rows = new ArrayList<>();
        long openSeq = -1;
        StringBuilder buffer = new StringBuilder();
        Long workingSeq = null;
        int lifecycleRow = -1;
        long lifecycleSeq = -1;
        long runStartTs = 0;
        boolean runFailed = false;
        for (EventRecord record : history) {
            long seq = record.seq();
            Map<String, Object> payload = parse(record.payload());
            switch (record.type().wire()) {
                case "user_message" -> rows.add(MessageCardBuilder.userMessageRow(
                        textOf(payload, "text"), seq));
                case "message_start" -> {
                    openSeq = seq;
                    buffer.setLength(0);
                }
                case "text_delta" -> {
                    if (openSeq < 0) {
                        openSeq = seq;
                        buffer.setLength(0);
                    }
                    buffer.append(textOf(payload, "text"));
                }
                case "message_end" -> {
                    String text = payload.containsKey("text")
                            ? textOf(payload, "text") : buffer.toString();
                    rows.add(MessageCardBuilder.assistantMessageRow(
                            openSeq >= 0 ? openSeq : seq, text));
                    openSeq = -1;
                    buffer.setLength(0);
                }
                case "tool_use" -> rows.add(MessageCardBuilder.workRow(
                        seq,
                        textOf(payload, "name") + " " + jsonOf(payload.get("arguments")),
                        List.of(MessageCardBuilder.toolArgumentsNode(
                                jsonOf(payload.get("arguments")), seq))));
                case "tool_result" -> rows.add(toolResultRow(payload, seq));
                case "run_start" -> {
                    workingSeq = seq;
                    lifecycleSeq = seq;
                    runStartTs = record.ts();
                    runFailed = false;
                    lifecycleRow = rows.size();
                    rows.add(MessageCardBuilder.lifecycleRow(seq, "running", "Run", ""));
                }
                case "run_end" -> {
                    workingSeq = null;
                    if (lifecycleRow >= 0 && !runFailed) {
                        rows.set(lifecycleRow, MessageCardBuilder.lifecycleRow(
                                lifecycleSeq, "done", "Run",
                                durationLabel(record.ts() - runStartTs)));
                    }
                    lifecycleRow = -1;
                }
                case "error" -> {
                    rows.add(MessageCardBuilder.dispatchEventRow(
                            "error", payload, seq));
                    if (lifecycleRow >= 0 && !runFailed) {
                        runFailed = true;
                        rows.set(lifecycleRow, MessageCardBuilder.lifecycleRow(
                                lifecycleSeq, "failed", "Run", ""));
                    }
                }
                default -> {
                }
            }
        }
        if (openSeq >= 0) {
            rows.add(MessageCardBuilder.assistantMessageRow(openSeq, buffer.toString()));
        }
        if (workingSeq != null) {
            rows.add(MessageCardBuilder.workingRow(workingSeq));
        }
        Ui.ListBuilder list = Ui.list().id("messages").set("empty", "No messages yet.");
        for (UiNode row : MessageCardBuilder.applyContinuation(rows)) {
            list.item(row);
        }
        return list.build();
    }

    /**
     * The live tail: the session stream continuing after the last rendered
     * sequence number ({@code fromSeq} is an exclusive lower bound), so a
     * replayed history never duplicates the pre-rendered list.
     */
    private static UiNode liveTail(String sessionId, List<EventRecord> history) {
        long lastSeq = 0;
        for (EventRecord record : history) {
            lastSeq = Math.max(lastSeq, record.seq());
        }
        return Ui.streamView("stream", STREAM_TOPIC_PREFIX + sessionId + "?fromSeq=" + lastSeq)
                .mode("append")
                .itemLimit(200)
                .autoScroll(true)
                .build();
    }

    /**
     * The {@code tool_result} history row: a {@code structured} payload
     * whose {@code type} names one of the 16 T102 event kinds renders that
     * event card (the same mapping the live frames use — the rendered
     * history and the live tail stay identical); anything else degrades to
     * the T101 work row with the plain content detail.
     */
    private static UiNode toolResultRow(Map<String, Object> payload, long seq) {
        Object structured = payload.get("structured");
        Map<String, Object> card = null;
        if (structured instanceof Map<?, ?> map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> typed = (Map<String, Object>) map;
            card = typed;
        } else if (structured instanceof String text && !text.isBlank()) {
            card = MessageCardBuilder.parseObject(text);
        }
        if (card != null && card.get("type") instanceof String type
                && MessageCardBuilder.isEventKind(type)) {
            return MessageCardBuilder.dispatchEventRow(type, card, seq);
        }
        return MessageCardBuilder.workRow(
                seq,
                textOf(payload, "name") + " result",
                List.of(MessageCardBuilder.toolResultNode(
                        textOf(payload, "content"),
                        Boolean.TRUE.equals(payload.get("error")), seq)));
    }

    /**
     * The composer (T103): the header control row, the context chips, the
     * context-window meter, the draft textarea and the footer row. The
     * surface keeps the reserved {@code composer} id the client paints the
     * composer shadow and the bottom safe-area inset on.
     */
    private static UiNode composer(String sessionId, boolean runLive) {
        Map<String, Object> runPayload = Map.of("sessionId", sessionId);
        Ui.ColumnBuilder column = Ui.column()
                .id(COMPOSER_ID)
                .gap(8)
                .padding(12)
                .child(controlRow())
                .child(chipsRow())
                .child(contextMeter())
                .child(Ui.textarea(MESSAGE_INPUT)
                        .label("Message")
                        .required(true)
                        .errorText("Write a message first")
                        .minLines(1)
                        .maxLines(8)
                        .autofocus(true)
                        .flex(1)
                        .constraints(Map.of("minHeight", COMPOSER_MIN_HEIGHT))
                        .build())
                .child(footerRow(sessionId, runLive, runPayload))
                .child(seedState());
        return column.build();
    }

    /**
     * The header control row (T103.1): the seven decorative pickers — model,
     * provider, effort, access mode, workspace, git branch and host. Each is
     * a {@code demo} button (icon + live label + chevron) whose action opens
     * the picker dialog; the dialog list sets local state and toasts.
     */
    private static UiNode controlRow() {
        return Ui.row()
                .id(CONTROLS_ID)
                .align("center")
                .gap(4)
                .child(picker(PICKER_MODEL, "Model: ${" + STATE_MODEL + "}",
                        "auto_awesome", "mod+shift+m", modelDialog()))
                .child(picker(PICKER_PROVIDER, "Provider: ${" + STATE_PROVIDER + "}",
                        "smart_toy", null, providerDialog()))
                .child(picker(PICKER_EFFORT, "Effort: ${" + STATE_EFFORT + "}",
                        "speed", "mod+shift+e", effortDialog()))
                .child(picker(PICKER_MODE, "Access: ${" + STATE_MODE + "}",
                        "shield", "mod+shift+a", permissionsDialog()))
                .child(picker(PICKER_WORKSPACE, "${" + STATE_WORKSPACE + "}",
                        "folder_open", "mod+shift+x", workspaceDialog()))
                .child(picker(PICKER_BRANCH, "${" + STATE_BRANCH + "}",
                        "alt_route", "mod+shift+g", branchDialog()))
                .child(picker(PICKER_HOST, "${" + STATE_HOST + "}",
                        "computer", "mod+shift+h", hostDialog()))
                .build();
    }

    /**
     * One picker control: the {@code demo} button carrying the icon, the
     * interpolating label and the dialog-opening action, plus the chord hint
     * in its tooltip where upstream advertises one.
     */
    private static UiNode picker(String id, String label, String icon, String chord,
                                 UiNode dialogNode) {
        Ui.ButtonBuilder button = Ui.button(label)
                .id(id)
                .icon(icon)
                .action(Directives.dialog(dialogNode))
                .set("demo", true)
                .tooltip(chord == null ? "Picker (preview only)" : chord + " — picker (preview only)");
        Ui.BoxBuilder chevronWrap = Ui.box()
                .child(Ui.iconButton()
                        .icon("expand_more")
                        .iconSize(16)
                        .set("demo", true)
                        .action(Directives.dialog(dialogNode))
                        .build());
        return Ui.row()
                .id(id + "-control")
                .align("center")
                .gap(0)
                .child(button.build())
                .child(chevronWrap.build())
                .build();
    }

    /**
     * The shared shape of the picker dialogs: the title row (name + chord
     * hint) over the option list, closed by the {@code Done} action. Options
     * dispatch the inline directive composite — {@code setState} + the
     * preview toast — so a selection changes the visible label with no
     * server round-trip.
     */
    private static Ui.ColumnBuilder dialogOptions(String dialogId, String name, String chord) {
        Ui.RowBuilder title = Ui.row()
                .gap(8)
                .align("center")
                .child(Ui.text(name).fontWeight(600).build());
        if (chord != null) {
            title.child(Ui.kbd().chord(chord).build());
        }
        return Ui.column()
                .id(dialogId)
                .gap(4)
                .child(title.build());
    }

    /** The trailing action row of a picker dialog. */
    private static UiNode dialogDone() {
        return Ui.button("Done")
                .action(Directives.dismissDialog())
                .build();
    }

    /** The model picker dialog (decorative fixtures). */
    private static UiNode modelDialog() {
        return dialogOptions("composer-model-dialog", "Model", "mod+shift+m")
                .child(option(STATE_MODEL, "Opus 4.6"))
                .child(option(STATE_MODEL, "Sonnet 4.6"))
                .child(option(STATE_MODEL, "GPT-5 Codex"))
                .child(option(STATE_MODEL, "Gemini 3 Pro"))
                .child(dialogDone())
                .build();
    }

    /** The provider selector dialog: the three built-in provider kinds. */
    private static UiNode providerDialog() {
        return dialogOptions("composer-provider-dialog", "Provider", null)
                .child(option(STATE_PROVIDER, "anthropic"))
                .child(option(STATE_PROVIDER, "openai"))
                .child(option(STATE_PROVIDER, "google"))
                .child(dialogDone())
                .build();
    }

    /** The effort picker dialog: Low / Med / High. */
    private static UiNode effortDialog() {
        return dialogOptions("composer-effort-dialog", "Effort", "mod+shift+e")
                .child(option(STATE_EFFORT, "Low"))
                .child(option(STATE_EFFORT, "Med"))
                .child(option(STATE_EFFORT, "High"))
                .child(dialogDone())
                .build();
    }

    /**
     * The T108 permissions dialog shell: the access-mode picker opened from
     * the composer's access control. The three upstream permission modes
     * (Read only / Ask / Full access) are a radio group — a {@code list} of
     * {@code list_row}s whose leading radio glyph and selected tint follow
     * the local {@code chat_mode} state — over a demo note and the Save
     * button. Save toasts the preview wording and closes; nothing is
     * persisted (plan section 14.10).
     */
    private static UiNode permissionsDialog() {
        Ui.ListBuilder modes = Ui.list().id(PERMISSIONS_MODES_ID);
        for (String mode : PERMISSION_MODES) {
            modes.item(permissionRow(mode));
        }
        return Ui.column()
                .id(PERMISSIONS_DIALOG_ID)
                .gap(8)
                .child(Ui.row()
                        .gap(8)
                        .align("center")
                        .child(Ui.text("Permissions").fontWeight(600).build())
                        .child(Ui.kbd().chord("mod+shift+a").build())
                        .build())
                .child(modes.build())
                .child(Ui.text("Preview only \u2014 permission changes are not saved in this build.")
                        .id(PERMISSIONS_NOTE_ID)
                        .fontSize(12)
                        .color("$color.muted-foreground")
                        .build())
                .child(Ui.button("Save")
                        .id(PERMISSIONS_SAVE_ID)
                        .action(Directives.client(List.of(
                                Directives.toast("Permissions saved (preview only)"),
                                Directives.dismissDialog())))
                        .set("demo", true)
                        .build())
                .build();
    }

    /** One permission-mode radio row: the leading radio glyph plus the mode. */
    private static UiNode permissionRow(String mode) {
        boolean selected = PERMISSION_MODES.get(0).equals(mode);
        return Ui.listRow()
                .id("permission-mode-" + permissionSlug(mode))
                .leading(radioGlyph(mode, selected))
                .title(mode)
                .subtitle(permissionDescription(mode))
                .selected(selected)
                .action(Directives.client(permissionSelectOps(mode)))
                .set("demo", true)
                .build();
    }

    /**
     * The leading radio glyph of one permission row: the id is the
     * {@code patch} address the selection flip swaps in place.
     */
    private static UiNode radioGlyph(String mode, boolean selected) {
        return Ui.icon()
                .id("permission-mode-" + permissionSlug(mode) + "-radio")
                .icon(selected ? "radio_button_checked" : "radio_button_unchecked")
                .size(18)
                .color(selected ? "$color.accent" : "$color.muted-foreground")
                .build();
    }

    /**
     * The inline composite of one permission row: set the local mode, flip
     * every radio glyph to the new selection and toast the preview wording.
     * The flip is a {@code patch} per glyph whose {@code html} is the glyph
     * re-rendered in its new state (contract level 4 — no prop merge).
     */
    private static List<Map<String, Object>> permissionSelectOps(String mode) {
        List<Map<String, Object>> ops = new ArrayList<>();
        ops.add(Directives.setState(STATE_MODE, mode));
        for (String candidate : PERMISSION_MODES) {
            boolean selected = candidate.equals(mode);
            ops.add(Directives.patch(
                    "permission-mode-" + permissionSlug(candidate) + "-radio",
                    radioGlyph(candidate, selected)));
        }
        ops.add(Directives.toast(mode + " selected (preview only)"));
        return ops;
    }

    /** The upstream permission-mode description (permission-modes.md:11-16). */
    private static String permissionDescription(String mode) {
        return switch (mode) {
            case "Read only" -> "Read files and run read-only commands.";
            case "Ask" -> "Ask before commands and file changes.";
            default -> "Allow commands and edits without prompts.";
        };
    }

    /** The id slug of one permission mode. */
    private static String permissionSlug(String mode) {
        return mode.toLowerCase(java.util.Locale.ROOT).replace(' ', '-');
    }

    /** The workspace selector dialog: the current worktree plus fixtures. */
    private static UiNode workspaceDialog() {
        return dialogOptions("composer-workspace-dialog", "Workspace", "mod+shift+x")
                .child(option(STATE_WORKSPACE, "jhin"))
                .child(option(STATE_WORKSPACE, "api-redesign (worktree)"))
                .child(option(STATE_WORKSPACE, "New worktree…"))
                .child(dialogDone())
                .build();
    }

    /** The git branch selector dialog. */
    private static UiNode branchDialog() {
        return dialogOptions("composer-branch-dialog", "Branch", "mod+shift+g")
                .child(option(STATE_BRANCH, "main"))
                .child(option(STATE_BRANCH, "feat/composer-rows"))
                .child(dialogDone())
                .build();
    }

    /**
     * The machine/host selector dialog: the single real entry plus the
     * decorative rows (the plan section 3.2 multi-environment rule).
     */
    private static UiNode hostDialog() {
        return dialogOptions("composer-host-dialog", "Host", "mod+shift+h")
                .child(option(STATE_HOST, "This machine"))
                .child(option(STATE_HOST, "gpu-box (decorative)"))
                .child(dialogDone())
                .build();
    }

    /** One picker dialog option: setState + preview toast, demo-marked. */
    private static UiNode option(String stateId, String value) {
        return Ui.button(value)
                .action(Directives.client(List.of(
                        Directives.setState(stateId, value),
                        Directives.toast(value + " selected (preview only)"))))
                .set("demo", true)
                .build();
    }

    /**
     * The context chips row (T103.2): the six upstream {@code ContextChip}
     * kinds (mention, skill, thread, image, file, terminal) as decorative
     * pills; a tap toasts the preview notice.
     */
    private static UiNode chipsRow() {
        return Ui.wrap()
                .id(CHIPS_ID)
                .spacing(6)
                .child(contextChip("mention", "@ada", "alternate_email"))
                .child(contextChip("skill", "jhin-plugin", "auto_awesome"))
                .child(contextChip("thread", "Fix the login bug", "chat_bubble"))
                .child(contextChip("image", "screenshot.png", "image"))
                .child(contextChip("file", "src/auth.java", "insert_drive_file"))
                .child(contextChip("terminal", "build output", "terminal"))
                .build();
    }

    /** One decorative context chip of the upstream pill kind. */
    private static UiNode contextChip(String kind, String label, String icon) {
        return Ui.chip()
                .label(label)
                .icon(icon)
                .kind(kind)
                .action(Directives.client(List.of(
                        Directives.toast(label + " context (preview only)"))))
                .set("demo", true)
                .build();
    }

    /**
     * The context-window meter (T103.2, decorative): the plan's gradient bar
     * — green to the 50% mark, yellow to the 80% mark, red beyond — with the
     * hard colour stops at the thresholds.
     */
    private static UiNode contextMeter() {
        Map<String, Object> gradient = new LinkedHashMap<>();
        gradient.put("begin", "centerLeft");
        gradient.put("end", "centerRight");
        gradient.put("colors", List.of(
                "$color.success", "$color.success",
                "$color.warning", "$color.warning",
                "$color.error", "$color.error"));
        gradient.put("stops", List.of(0.0, 0.5, 0.5, 0.8, 0.8, 1.0));
        return Ui.box()
                .id(METER_ID)
                .height(6)
                .borderRadius(999)
                .gradient(gradient)
                .set("demo", true)
                .tooltip("Context window (preview only)")
                .build();
    }

    /**
     * The footer row (T103.1): attach, voice, the prompt-stash menu, the
     * queue indicator badge, then the stop button (while a run is live), the
     * real send button and the Direct/Queue/Steer split menu.
     */
    private static UiNode footerRow(String sessionId, boolean runLive,
                                    Map<String, Object> runPayload) {
        Ui.RowBuilder row = Ui.row()
                .id(FOOTER_ID)
                .align("center")
                .gap(4)
                .child(footerIcon("attach", "attach_file", "Attach files"))
                .child(footerIcon("voice", "mic", "Voice input"))
                .child(stashMenu())
                .child(queueBadge())
                .child(Ui.spacer().build());
        if (runLive) {
            row.child(Ui.iconButton()
                    .id(STOP_ID)
                    .icon("stop")
                    .color("$color.error")
                    .action(ActionDescriptors.of("cancel", runPayload, List.of()))
                    .tooltip("Interrupt")
                    .build());
        }
        row.child(Ui.button("Send")
                .id("composer-send")
                .style("primary")
                .icon("send")
                .action(ActionDescriptors.of("send", runPayload, List.of(MESSAGE_INPUT)))
                .build());
        row.child(sendSplitMenu());
        return row.build();
    }

    /** One decorative footer icon affordance (attach / voice). */
    private static UiNode footerIcon(String id, String icon, String tooltip) {
        return Ui.iconButton()
                .id("composer-" + id)
                .icon(icon)
                .tooltip(tooltip)
                .action(Directives.client(List.of(
                        Directives.toast(tooltip + " (preview only)"))))
                .set("demo", true)
                .build();
    }

    /**
     * The prompt stash menu (T103.2, the {@code ComposerStashMenu} shell):
     * the bookmark trigger opens the stash dialog with the {@code Stash
     * Prompt} / {@code Stash Name} inputs; saving toasts the preview notice.
     */
    private static UiNode stashMenu() {
        Ui.ColumnBuilder dialog = Ui.column()
                .id("composer-stash-dialog")
                .gap(8)
                .child(Ui.input("stash-prompt")
                        .label("Stash Prompt")
                        .build())
                .child(Ui.input("stash-name")
                        .label("Stash Name")
                        .build())
                .child(Ui.row()
                        .gap(8)
                        .child(Ui.button("Stash")
                                .action(Directives.client(List.of(
                                        Directives.dismissDialog(),
                                        Directives.toast("Prompt stashed (preview only)"))))
                                .set("demo", true)
                                .build())
                        .child(Ui.button("Cancel")
                                .action(Directives.dismissDialog())
                                .build())
                        .build());
        return Ui.menu()
                .id("composer-stash-menu")
                .trigger(Ui.iconButton()
                        .icon("bookmark")
                        .tooltip("Stash prompt")
                        .build())
                .item(Ui.menuItem("Stash prompt…")
                        .icon("bookmark")
                        .action(Directives.dialog(dialog.build()))
                        .build())
                .item(Ui.menuItem("Stashed prompts")
                        .icon("insert_drive_file")
                        .action(Directives.dialog(Ui.column()
                                .child(Ui.text("Nothing stashed yet.").build())
                                .child(dialogDone())
                                .build()))
                        .build())
                .set("demo", true)
                .build();
    }


    /**
     * The queue indicator badge (T103.1, decorative): a count fixture that
     * shows while the send split-button's dispatch mode is {@code queue} —
     * the {@code when} expression reads the same local state the split menu
     * writes.
     */
    private static UiNode queueBadge() {
        return Ui.badge()
                .id(QUEUE_BADGE_ID)
                .label("Queue")
                .count(2)
                .color("$color.warning")
                .when(STATE_DISPATCH + " == 'queue'")
                .set("demo", true)
                .build();
    }

    /** The send split-button menu: Direct / Queue / Steer, demo-marked. */
    private static UiNode sendSplitMenu() {
        return Ui.menu()
                .id("composer-send-menu")
                .trigger(Ui.iconButton()
                        .icon("expand_more")
                        .tooltip("Dispatch mode")
                        .build())
                .item(Ui.menuItem("Direct")
                        .icon("send")
                        .action(dispatchOption("direct"))
                        .build())
                .item(Ui.menuItem("Queue")
                        .icon("queue")
                        .action(dispatchOption("queue"))
                        .build())
                .item(Ui.menuItem("Steer")
                        .icon("call_split")
                        .action(dispatchOption("steer"))
                        .build())
                .set("demo", true)
                .build();
    }

    /** One send split-menu selection: setState + preview toast. */
    private static Map<String, Object> dispatchOption(String mode) {
        return Directives.client(List.of(
                Directives.setState(STATE_DISPATCH, mode),
                Directives.toast("Dispatch: " + mode + " (preview only)")));
    }

    /**
     * The invisible seed carriers of the decorative picker defaults (the §8.4
     * {@code value} seeding): the client seeds the state from them on screen
     * apply, so the picker labels interpolate the fixtures from first render.
     */
    private static UiNode seedState() {
        return Ui.container()
                .visible(false)
                .child(seed(STATE_MODEL, "Opus 4.6"))
                .child(seed(STATE_PROVIDER, "anthropic"))
                .child(seed(STATE_EFFORT, "Med"))
                .child(seed(STATE_MODE, "Ask"))
                .child(seed(STATE_WORKSPACE, "jhin"))
                .child(seed(STATE_BRANCH, "main"))
                .child(seed(STATE_HOST, "This machine"))
                .child(seed(STATE_DISPATCH, "direct"))
                .build();
    }

    /** One seed carrier: an invisible input holding a fixture default. */
    private static UiNode seed(String stateId, String value) {
        return Ui.input(stateId)
                .value(value)
                .visible(false)
                .build();
    }

    /** Parses a payload JSON object; blank text yields the empty map. */
    private static Map<String, Object> parse(String payloadJson) {
        if (payloadJson == null || payloadJson.isBlank()) {
            return Map.of();
        }
        try {
            return Json.readMap(payloadJson);
        } catch (RuntimeException e) {
            return Map.of("text", payloadJson);
        }
    }

    private static String textOf(Map<String, Object> payload, String key) {
        Object value = payload.get(key);
        return (value == null) ? "" : String.valueOf(value);
    }

    /** The raw JSON text of a payload field: strings pass through, objects re-serialize. */
    private static String jsonOf(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof String text) {
            return text;
        }
        try {
            return Json.write(value);
        } catch (RuntimeException e) {
            return String.valueOf(value);
        }
    }
}
