import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vite-plus/test";

import { buildApplicationMenu, type MenuHandlers } from "../src/menu.ts";

function recorder() {
  const calls: string[] = [];
  const handlers: MenuHandlers = {
    checkForUpdates: () => void calls.push("check"),
    runCommand: (command) => void calls.push(`command:${command}`),
    zoom: (direction) => void calls.push(`zoom:${direction}`),
    contents: (command) => void calls.push(`contents:${command}`),
  };
  return { calls, handlers };
}

/** Labels (or roles) of the visible items, separators as "-". */
function outline(items: readonly MenuItemConstructorOptions[]): unknown[] {
  return items
    .filter((item) => item.visible !== false)
    .map((item) => {
      const name = item.type === "separator" ? "-" : (item.label ?? item.role);
      return Array.isArray(item.submenu) ? { [String(name)]: outline(item.submenu) } : name;
    });
}

const find = (
  items: readonly MenuItemConstructorOptions[],
  id: string,
): MenuItemConstructorOptions =>
  items
    .flatMap((item) => [item, ...(Array.isArray(item.submenu) ? item.submenu : [])])
    .find((item) => item.id === id)!;

const click = (item: MenuItemConstructorOptions) => (item.click as unknown as () => void)();

describe("buildApplicationMenu", () => {
  it("is T3's template on Linux and Windows", () => {
    const { handlers } = recorder();
    const menu = buildApplicationMenu({
      platform: "linux",
      appName: "Jhin",
      handlers,
      contributions: [],
    });
    expect(outline(menu)).toEqual([
      { File: ["Settings...", "-", "quit"] },
      { Edit: ["undo", "redo", "-", "cut", "copy", "paste", "delete", "-", "selectAll"] },
      {
        View: [
          "Reload",
          "Force Reload",
          "Toggle Developer Tools",
          "-",
          "Actual Size",
          "Zoom In",
          "Zoom Out",
          "-",
          "togglefullscreen",
        ],
      },
      "windowMenu",
      { help: ["Check for Updates..."] },
    ]);
  });

  it("has the app menu on macOS, with Settings... there and Close in File", () => {
    const { handlers } = recorder();
    const menu = buildApplicationMenu({
      platform: "darwin",
      appName: "Jhin",
      handlers,
      contributions: [],
    });
    expect(outline(menu)[0]).toEqual({
      Jhin: [
        "About Jhin",
        "Check for Updates...",
        "-",
        "Settings...",
        "-",
        "services",
        "-",
        "Hide Jhin",
        "hideOthers",
        "unhide",
        "-",
        "Quit Jhin",
      ],
    });
    expect(outline(menu)[1]).toEqual({ File: ["close"] });
    expect(menu.find((item) => item.label === "View")).toMatchObject({
      submenu: expect.arrayContaining([
        expect.objectContaining({ label: "Toggle Developer Tools", accelerator: "Alt+Command+I" }),
      ]),
    });
  });

  it("runs commands in the page and acts on the main window's contents", () => {
    const { calls, handlers } = recorder();
    const menu = buildApplicationMenu({
      platform: "linux",
      appName: "Jhin",
      handlers,
      contributions: [],
    });

    click(find(menu, "jhin.settings"));
    click(find(menu, "jhin.check-for-updates"));
    const view = menu.find((item) => item.label === "View")!
      .submenu as MenuItemConstructorOptions[];
    for (const item of view.filter((entry) => entry.click !== undefined)) click(item);

    expect(calls).toEqual([
      "command:settings.open",
      "check",
      "contents:reload",
      "contents:forceReload",
      "contents:toggleDevTools",
      "zoom:reset",
      "zoom:in",
      "zoom:in",
      "zoom:out",
      "zoom:reset",
      "zoom:in",
      "zoom:out",
    ]);
  });

  it("adds the items plugins contribute to their menu, after a separator", () => {
    const { calls, handlers } = recorder();
    const menu = buildApplicationMenu({
      platform: "linux",
      appName: "Jhin",
      handlers,
      contributions: [
        { id: "acme.report", menu: "help", label: "Report a Problem", command: "acme.report" },
        {
          id: "acme.palette",
          menu: "view",
          label: "Command Palette",
          command: "palette.toggle",
          accelerator: "CmdOrCtrl+Shift+P",
        },
      ],
    });

    expect(outline(menu).at(-1)).toEqual({
      help: ["Check for Updates...", "-", "Report a Problem"],
    });
    expect(find(menu, "acme.palette")).toMatchObject({
      label: "Command Palette",
      accelerator: "CmdOrCtrl+Shift+P",
    });
    click(find(menu, "acme.palette"));
    expect(calls).toEqual(["command:palette.toggle"]);
  });

  it("keeps the first item of an id and drops shortcuts already taken", () => {
    const { handlers } = recorder();
    const menu = buildApplicationMenu({
      platform: "linux",
      appName: "Jhin",
      handlers,
      contributions: [
        {
          id: "acme.one",
          menu: "view",
          label: "One",
          command: "a",
          accelerator: "CmdOrCtrl+Shift+P",
        },
        { id: "acme.one", menu: "help", label: "Again", command: "b" },
        {
          id: "acme.two",
          menu: "view",
          label: "Two",
          command: "c",
          accelerator: "Shift+CmdOrCtrl+p",
        },
        {
          id: "acme.reload",
          menu: "view",
          label: "Reload",
          command: "d",
          accelerator: "cmdorctrl+r",
        },
        {
          id: "acme.alias",
          menu: "view",
          label: "Alias",
          command: "e",
          accelerator: "CommandOrControl+Z",
        },
      ],
    });

    expect(outline(menu).at(-1)).toEqual({ help: ["Check for Updates..."] });
    expect(find(menu, "acme.one")).toMatchObject({ accelerator: "CmdOrCtrl+Shift+P" });
    expect(find(menu, "acme.two")).not.toHaveProperty("accelerator");
    expect(find(menu, "acme.reload")).not.toHaveProperty("accelerator");
    expect(find(menu, "acme.alias")).not.toHaveProperty("accelerator");
  });
});
