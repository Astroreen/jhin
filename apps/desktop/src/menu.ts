// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/desktop/src/window/DesktopApplicationMenu.ts.
import type { DesktopMenuContribution, DesktopMenuName } from "@jhin/desktop-api";
import type { MenuItemConstructorOptions } from "electron";

export type ZoomDirection = "in" | "out" | "reset";
export type ContentsCommand = "reload" | "forceReload" | "toggleDevTools";

export interface MenuHandlers {
  checkForUpdates(): void;
  /** Runs a client command in the main window's page (D516). */
  runCommand(command: string): void;
  zoom(direction: ZoomDirection): void;
  contents(command: ContentsCommand): void;
}

const separator = { type: "separator" } as const;

/** Items plugins added to one menu, after a separator when there are any. */
function contributed(
  items: readonly DesktopMenuContribution[],
  menu: DesktopMenuName,
  handlers: MenuHandlers,
): MenuItemConstructorOptions[] {
  const mine = items.filter((item) => item.menu === menu);
  if (mine.length === 0) return [];
  return [
    separator,
    ...mine.map((item) => ({
      id: item.id,
      label: item.label,
      ...(item.accelerator === undefined ? {} : { accelerator: item.accelerator }),
      click: () => handlers.runCommand(item.command),
    })),
  ];
}

/** The application menu: T3's template, plus the items plugins contribute. */
export function buildApplicationMenu(options: {
  readonly platform: NodeJS.Platform;
  readonly appName: string;
  readonly handlers: MenuHandlers;
  readonly contributions: readonly DesktopMenuContribution[];
}): MenuItemConstructorOptions[] {
  const { platform, appName, handlers, contributions } = options;
  const mac = platform === "darwin";
  const settings: MenuItemConstructorOptions = {
    id: "jhin.settings",
    label: "Settings...",
    accelerator: "CmdOrCtrl+,",
    click: () => handlers.runCommand("settings.open"),
  };
  const checkForUpdates: MenuItemConstructorOptions = {
    id: "jhin.check-for-updates",
    label: "Check for Updates...",
    click: () => handlers.checkForUpdates(),
  };
  const zoom = (direction: ZoomDirection) => () => handlers.zoom(direction);
  const contents = (command: ContentsCommand) => () => handlers.contents(command);
  const template: MenuItemConstructorOptions[] = [];

  if (mac) {
    template.push({
      label: appName,
      submenu: [
        { role: "about", label: `About ${appName}` },
        checkForUpdates,
        separator,
        settings,
        separator,
        { role: "services" },
        separator,
        { role: "hide", label: `Hide ${appName}` },
        { role: "hideOthers" },
        { role: "unhide" },
        separator,
        { role: "quit", label: `Quit ${appName}` },
      ],
    });
  }

  template.push(
    {
      label: "File",
      submenu: [
        ...(mac ? [] : [settings, separator]),
        { role: mac ? "close" : "quit" },
        ...contributed(contributions, "file", handlers),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        separator,
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "delete" },
        separator,
        { role: "selectAll" },
        ...(mac
          ? [
              separator,
              {
                label: "Speech",
                submenu: [{ role: "startSpeaking" as const }, { role: "stopSpeaking" as const }],
              },
            ]
          : []),
      ],
    },
    {
      label: "View",
      submenu: [
        /*
          Not the reload, DevTools or zoom roles: those act on the focused
          webContents, while these act on the main window's page.
        */
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: contents("reload") },
        {
          label: "Force Reload",
          accelerator: "Shift+CmdOrCtrl+R",
          click: contents("forceReload"),
        },
        {
          label: "Toggle Developer Tools",
          accelerator: mac ? "Alt+Command+I" : "Ctrl+Shift+I",
          click: contents("toggleDevTools"),
        },
        separator,
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: zoom("reset") },
        { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: zoom("in") },
        { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", visible: false, click: zoom("in") },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: zoom("out") },
        // The numeric keypad sends its own key codes, so the number-row
        // accelerators above never match it.
        {
          label: "Actual Size",
          accelerator: "CmdOrCtrl+num0",
          visible: false,
          click: zoom("reset"),
        },
        { label: "Zoom In", accelerator: "CmdOrCtrl+numadd", visible: false, click: zoom("in") },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+numsub", visible: false, click: zoom("out") },
        separator,
        { role: "togglefullscreen" },
        ...contributed(contributions, "view", handlers),
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [checkForUpdates, ...contributed(contributions, "help", handlers)],
    },
  );
  return template;
}
