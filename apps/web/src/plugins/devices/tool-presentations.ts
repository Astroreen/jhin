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

/**
 * The agent's device tools: T3's `device_*`, and Jhin's input and detail commands, which T3's
 * agents reach through `agent-device` instead, in the same group (D1681).
 */
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
  "device.detail": ["Read", "Reading", "Read", "the device's details"],
  "device.action": ["Run", "Running", "Ran", "a device action"],
  "device.tap": ["Tap", "Tapping", "Tapped", "the device"],
  "device.swipe": ["Swipe", "Swiping", "Swiped", "on the device"],
  "device.type": ["Type", "Typing", "Typed", "on the device"],
  "device.button": ["Press", "Pressing", "Pressed", "a device button"],
};

/** Names the agent's device tools in the work log; disposing takes them back. */
export function describeDeviceTools(tools: ChatTools): Disposable[] {
  return Object.entries(LABELS).map(([command, labels]) =>
    tools.describe(command, { labels, group: DEVICE }),
  );
}
