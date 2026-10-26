// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/desktop/src/preview-pip-preload.ts.
// The pop-out window's own preload (docs/plans/desktop.md, D1493): it paints the frames the main
// process sends into the page's one image. Built into one CommonJS file, as the app's preload.
import { ipcRenderer } from "electron";

import { POP_OUT_FRAME_CHANNEL } from "@jhin/desktop-api/channels";

ipcRenderer.on(POP_OUT_FRAME_CHANNEL, (_event, frame: unknown) => {
  if (typeof frame !== "string" || !frame.startsWith("data:image/jpeg;base64,")) return;
  const image = document.querySelector("img");
  if (image !== null) image.src = frame;
});
