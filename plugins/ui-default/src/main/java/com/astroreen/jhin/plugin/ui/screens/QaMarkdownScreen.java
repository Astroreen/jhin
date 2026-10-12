/**
 * The QA markdown probe screens (T302): {@code qa-markdown} carries the GFM
 * parity fixture (strikethrough, task list, table, autolink, alert callout,
 * fenced code) plus long and short path chips; {@code qa-degraded} carries
 * the unclosed-fence fixture that must degrade to plain text. They exist so
 * the T302 acceptance is provable over the wire. Not a product surface —
 * they resolve only when the operator sets the {@code jhin.ui} config key
 * {@code qaProbe} (default off, {@code JHIN_UI_QAPROBE=true}) and no screen
 * links here.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.plugin.uikit.text.PathDisplay;

public final class QaMarkdownScreen {

    /** A long path whose middle-truncated chip label must stay ≤ 48 chars. */
    private static final String LONG_PATH =
            "/home/astroreen/Documents/jhin/plugins/ui-default/src/main/java/"
                    + "com/astroreen/jhin/plugin/ui/screens/MessageCardBuilder.java";

    /** The acceptance path: a long path whose basename is exactly file.java. */
    private static final String FILE_JAVA_PATH =
            "/home/astroreen/Documents/jhin/plugins/ui-default/src/test/resources/"
                    + "gallery/deep/structure/file.java";

    private QaMarkdownScreen() {
    }

    /** The GFM fixture screen: one markdown node plus the path-chip row. */
    public static UiNode render() {
        return Ui.screen().title("QA markdown probe")
                .body(Ui.column()
                        .gap(12)
                        .child(Ui.markdown("""
                                # GFM parity

                                Strikethrough: ~~gone~~ stays.

                                - [x] shipped task
                                - [ ] open task

                                | Name | Value |
                                | --- | --- |
                                | a | 1 |

                                Autolink: https://example.invalid/docs

                                > [!WARNING]
                                > Careful with this path.

                                ```java
                                public class Sample {
                                    int x = 1;
                                }
                                ```
                                """).build())
                        .child(Ui.row()
                                .gap(8)
                                .align("center")
                                .child(PathDisplay.chip(LONG_PATH))
                                .child(PathDisplay.chip(FILE_JAVA_PATH))
                                .child(PathDisplay.chip("src/auth.java"))
                                .build())
                        .build())
                .build();
    }

    /** The degradation fixture: the unclosed fence must become plain text. */
    public static UiNode renderDegraded() {
        return Ui.screen().title("QA degraded markdown probe")
                .body(Ui.markdown("""
                        before

                        ```java
                        int x = 1;
                        """).build())
                .build();
    }
}
