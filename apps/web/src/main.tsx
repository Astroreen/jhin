import "./index.css";

import { boot } from "./boot.ts";

const kernel = await boot();
// For the browser console and agents driving the page (D36): the live client kernel.
Object.assign(globalThis, { jhin: { kernel } });
