/**
 * The bottom terminal drawer of the shell (T106): the decorative
 * {@code ThreadTerminalDrawer} chrome — a grip handle, the {@code Terminal}
 * title, a close {@code X} and a fixture transcript rendered as a
 * {@code code_block}.
 *
 * <p><b>No PTY.</b> This is a decorative surface (plan section 14.1): there
 * is no shell process and no terminal session. The body is the deterministic
 * {@code fixtures/terminal-fixtures.json} transcript (a few {@code jhin} CLI
 * lines) loaded at build time, never fetched at runtime (plan section 4.8).
 * Every affordance beyond open / resize / close carries {@code demo: true}
 * (plan section 14.10).
 *
 * <p><b>Chrome.</b> The drawer is a {@code container} gated by the chat
 * header's {@code setState} toggle ({@link ChatScreen#STATE_TERMINAL}): the
 * node carries {@code when: chat_terminal == true}, so the toggle (or the
 * {@code terminal.toggle} command) opens it and the close {@code X} hides it
 * again. The surface paints the terminal token pair — the upstream
 * {@code --terminal-background}/{@code --terminal-foreground} aliases resolve
 * to the {@code code-background}/{@code code-foreground} pair (t3code
 * {@code apps/web/src/index.css:1127-1128}, commit {@code 37de6cb}) — with
 * the {@code border-t} hairline. The header carries the {@code GripVertical}
 * equivalent ({@code drag_indicator}, the upstream grip glyph) and the
 * {@code Terminal} title; the body carries the transcript plus the terminal
 * cursor and selection colour tokens.
 *
 * <p><b>Resize.</b> The drawer height is owned by the client shell
 * (the web runtime's terminal slot): the grip drag resizes it between
 * {@value #MIN_HEIGHT} px and {@value #MAX_RATIO} of the viewport, persisted
 * under {@value #PERSIST_KEY} through the same store seam {@code split}
 * uses (T90). {@code Escape} and {@code mod+w} close the focused terminal
 * first (the upstream precedence, {@code packages/shared/src/keybindings.ts:30-31}:
 * {@code mod+w} is {@code terminal.close} while {@code terminalFocus}, and
 * {@code rightPanel.close} otherwise).
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.ui.Directives;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.json.Json;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

public final class TerminalDrawerBuilder {

    /** The drawer container id (the height / persistence carrier). */
    public static final String DRAWER_ID = "terminal-drawer";

    /** The header row id. */
    public static final String HEADER_ID = "terminal-drawer-header";

    /** The grip handle id (the resize affordance). */
    public static final String GRIP_ID = "terminal-drawer-grip";

    /** The close {@code X} id. */
    public static final String CLOSE_ID = "terminal-drawer-close";

    /** The transcript {@code code_block} id. */
    public static final String TRANSCRIPT_ID = "terminal-drawer-transcript";

    /** The drawer title (the upstream {@code Terminal} label). */
    public static final String TITLE = "Terminal";

    /** The client store key the drawer height persists under (T90 seam). */
    public static final String PERSIST_KEY = "terminal_height";

    /** The default drawer height in px. */
    public static final int DEFAULT_HEIGHT = 240;

    /** The minimum drawer height in px (the plan's clamp floor). */
    public static final int MIN_HEIGHT = 100;

    /** The maximum drawer height as a fraction of the viewport. */
    public static final double MAX_RATIO = 0.5;

    /** The fixture transcript resource (plan section 4.8). */
    private static final String FIXTURE = "fixtures/terminal-fixtures.json";

    private TerminalDrawerBuilder() {
    }

    /**
     * Builds the terminal drawer node of the shell.
     *
     * @return the drawer container, gated by the terminal open state
     */
    public static UiNode build() {
        return Ui.container()
                .id(DRAWER_ID)
                .direction("column")
                .gap(0)
                .when(ChatScreen.STATE_TERMINAL + " == true")
                .color("$color.code")
                .border("$color.border")
                .borderWidth(1)
                .set("initialHeight", DEFAULT_HEIGHT)
                .set("minDrawerHeight", MIN_HEIGHT)
                .set("maxDrawerRatio", MAX_RATIO)
                .set("persistKey", PERSIST_KEY)
                .set("closeState", ChatScreen.STATE_TERMINAL)
                .set("cursorColor", "$color.foreground")
                .set("selectionColor", "$color.accent")
                .child(header())
                .child(body())
                .build();
    }

    /**
     * The header row: the grip handle, the {@code Terminal} title and the
     * close {@code X}. The grip is the resize affordance the client shell
     * wires to the drag; the close {@code X} is the real inline
     * {@code setState} that hides the drawer (open / resize / close are the
     * three real affordances, plan section 14.10).
     */
    private static UiNode header() {
        return Ui.row()
                .id(HEADER_ID)
                .align("center")
                .gap(8)
                .padding(List.of(4, 8))
                .child(Ui.icon()
                        .id(GRIP_ID)
                        .icon("drag_indicator")
                        .size(16)
                        .color("$color.code-foreground")
                        .build())
                .child(Ui.text(TITLE)
                        .fontSize(12)
                        .fontWeight(600)
                        .color("$color.code-foreground")
                        .build())
                .child(Ui.spacer().build())
                .child(Ui.iconButton()
                        .id(CLOSE_ID)
                        .icon("close")
                        .iconSize(16)
                        .constraints(Map.of("minWidth", 24, "minHeight", 24))
                        .tooltip("Close terminal")
                        .action(Directives.setState(ChatScreen.STATE_TERMINAL, false))
                        .build())
                .build();
    }

    /** The body: the fixture transcript as a syntax-coloured code block. */
    private static UiNode body() {
        return Ui.expanded()
                .flex(1)
                .child(Ui.scroll()
                        .item(Ui.codeBlock(transcript())
                                .id(TRANSCRIPT_ID)
                                .language("shell")
                                .wrap(false)
                                .set("syntax", true)
                                .build())
                        .build())
                .build();
    }

    /**
     * The fixture transcript: the {@code lines} of
     * {@code fixtures/terminal-fixtures.json} joined with newlines. Loaded
     * from the classpath at build time; a missing resource is an authoring
     * bug and fails the build.
     *
     * @return the transcript text
     */
    static String transcript() {
        try (InputStream in = TerminalDrawerBuilder.class.getClassLoader()
                .getResourceAsStream(FIXTURE)) {
            if (in == null) {
                throw new IllegalStateException("missing classpath resource: " + FIXTURE);
            }
            Map<String, Object> fixture =
                    Json.readMap(new String(in.readAllBytes(), StandardCharsets.UTF_8));
            Object lines = fixture.get("lines");
            if (lines instanceof List<?> list) {
                StringBuilder text = new StringBuilder();
                for (Object line : list) {
                    if (text.length() > 0) {
                        text.append('\n');
                    }
                    text.append(String.valueOf(line));
                }
                return text.toString();
            }
            return "";
        } catch (IOException e) {
            throw new UncheckedIOException("cannot read " + FIXTURE, e);
        }
    }
}
