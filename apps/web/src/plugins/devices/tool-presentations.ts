// The labels are T3 Code's (MIT, see THIRD_PARTY_NOTICES.md):
// packages/shared/src/t3McpToolPresentation.ts. docs/plans/preview.md, D1681.
import type { ChatToolGroup, ChatToolPresentation, ChatTools } from "@jhin/client-api";
import type { Disposable } from "@jhin/sdk";
import { SmartphoneIcon } from "lucide-react";

/** "Used device controls 2 times" (D1682). */
const DEVICE: ChatToolGroup = {
  id: "device",
  past: "Used",
  infinitive: "use",
  object: (count) => `device controls ${count} ${count === 1 ? "time" : "times"}`,
  icon: SmartphoneIcon,
};

/** The agent's device tools (T3's `device_*`). */
const LABELS: Readonly<Record<string, ChatToolPresentation["labels"]>> = {
  "device.list": ["List", "Listing", "Listed", "simulators and emulators"],
  "device.open": ["Open", "Opening", "Opened", "a device in the Device panel"],
  "device.screenshot": [
    "Take a screenshot of",
    "Taking a screenshot of",
    "Took a screenshot of",
    "the device",
  ],
  "device.close": ["Close", "Closing", "Closed", "a device"],
};

/** Names the agent's device tools in the work log; disposing takes them back. */
export function describeDeviceTools(tools: ChatTools): Disposable[] {
  return Object.entries(LABELS).map(([command, labels]) =>
    tools.describe(command, { labels, group: DEVICE }),
  );
}
