// The labels are T3 Code's (MIT, see THIRD_PARTY_NOTICES.md):
// packages/shared/src/t3McpToolPresentation.ts. docs/plans/preview.md, D1681.
import type { ChatToolGroup, ChatToolPresentation, ChatTools } from "@jhin/client-api";
import type { Disposable } from "@jhin/sdk";
import { Globe2Icon } from "lucide-react";

const times = (count: number) => `${count} ${count === 1 ? "time" : "times"}`;

/** "Used browser 3 times" (D1682). */
const BROWSER: ChatToolGroup = {
  id: "browser",
  past: "Used",
  infinitive: "use",
  object: (count) => `browser ${times(count)}`,
  icon: Globe2Icon,
};

/** The agent's browser tools (T3's `preview_*`, `t3_preview_list` and `t3_preview_close`). */
const LABELS: Readonly<Record<string, ChatToolPresentation["labels"]>> = {
  "preview.status": ["Get", "Getting", "Got", "preview browser status"],
  "preview.open": ["Open", "Opening", "Opened", "a page in the preview browser"],
  "preview.navigate": ["Navigate", "Navigating", "Navigated", "the preview browser"],
  "preview.dialog": ["Respond", "Responding", "Responded", "to a preview browser dialog"],
  "preview.snapshot": [
    "Take a snapshot of",
    "Taking a snapshot of",
    "Took a snapshot of",
    "the preview page",
  ],
  "preview.click": ["Click", "Clicking", "Clicked", "in the preview browser"],
  "preview.press": ["Press", "Pressing", "Pressed", "a key in the preview browser"],
  "preview.type": ["Type", "Typing", "Typed", "in the preview browser"],
  "preview.hover": ["Hover", "Hovering", "Hovered", "in the preview browser"],
  "preview.select": ["Choose", "Choosing", "Chose", "an option in the preview browser"],
  "preview.drag": ["Drag", "Dragging", "Dragged", "in the preview browser"],
  "preview.upload": ["Upload", "Uploading", "Uploaded", "files to the preview browser"],
  "preview.scroll": ["Scroll", "Scrolling", "Scrolled", "the preview browser"],
  "preview.resize": ["Resize", "Resizing", "Resized", "the preview browser"],
  "preview.evaluate": ["Evaluate", "Evaluating", "Evaluated", "script in the preview browser"],
  "preview.wait.for": ["Wait", "Waiting", "Waited", "for the preview page"],
  "preview.set.appearance": ["Set", "Setting", "Set", "preview browser appearance"],
  "preview.recording.start": ["Start", "Starting", "Started", "recording the preview browser"],
  "preview.recording.stop": ["Stop", "Stopping", "Stopped", "recording the preview browser"],
  "preview.list": ["List", "Listing", "Listed", "preview tabs"],
  "preview.close": ["Close", "Closing", "Closed", "a preview tab"],
};

/** Names the agent's browser tools in the work log; disposing takes them back. */
export function describePreviewTools(tools: ChatTools): Disposable[] {
  return Object.entries(LABELS).map(([command, labels]) =>
    tools.describe(command, { labels, group: BROWSER }),
  );
}
