/**
 * The QA timeline probe screen (T101): one row of each of the 14 timeline
 * row kinds, each carrying a fixed {@code rowKind} the QA scripts assert on,
 * plus the continuation pairs (two adjacent {@code work:log} rows and an
 * assistant message followed by its {@code assistant-meta} row) that prove
 * the no-gap grouping over the wire. It exists so the row-kind contract is
 * provable without an agent run: the same builders the chat screen and the
 * live frames use render the fixture. Not a product surface — it resolves
 * only while the {@code jhin.ui} config key {@code qaProbe} is set (the
 * switch the {@code qa-level3} probe shares) and no screen links here.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.ArrayList;
import java.util.List;

public final class QaTimelineScreen {

    private QaTimelineScreen() {
    }

    /** The probe tree: {@code screen} → the 14 rows in the plan order. */
    public static UiNode render() {
        return Ui.screen()
                .title("QA timeline probe")
                .body(Ui.column()
                        .id("qa-timeline")
                        .children(new ArrayList<>(MessageCardBuilder.applyContinuation(rows())))
                        .build())
                .build();
    }

    /** One row of each of the 14 kinds, in the plan section 4.5 order. */
    private static List<UiNode> rows() {
        return List.of(
                MessageCardBuilder.userMessageRow("Fix the login bug", 1),
                MessageCardBuilder.assistantMessageRow(2, "On it — reading the auth flow."),
                MessageCardBuilder.assistantMetaRow(3, List.of("sonnet-4", "high effort")),
                MessageCardBuilder.eventRow(16, "compaction", "Context compacted",
                        "12k → 4k tokens", "muted"),
                MessageCardBuilder.workRow(4, "read src/auth.java",
                        List.of(MessageCardBuilder.toolArgumentsNode("{\"path\":\"src/auth.java\"}", 4))),
                // The continuation pair: a second work row directly after the
                // first — the two close with no gap.
                MessageCardBuilder.workRow(5, "write src/auth.java result",
                        List.of(MessageCardBuilder.toolResultNode("patched", false, 5))),
                MessageCardBuilder.workLiveRow(6, "Running tests"),
                MessageCardBuilder.workToggleRow(7, "Read 4 files", 4),
                MessageCardBuilder.thinkingRow(8, "The token expiry needs a clock injection."),
                MessageCardBuilder.proposedPlanRow(9, "1. Inject the clock\n2. Fix the expiry check"),
                MessageCardBuilder.workingRow(10),
                MessageCardBuilder.worktreeSetupRow(11, "running", "Creating the worktree"),
                MessageCardBuilder.turnFoldRow(12, "1 earlier turn"),
                MessageCardBuilder.attemptFoldRow(13, "Superseded attempt"),
                MessageCardBuilder.contextCompactionRow(14, "Context compacted", false),
                MessageCardBuilder.unknownRow(15, "holo"));
    }
}
