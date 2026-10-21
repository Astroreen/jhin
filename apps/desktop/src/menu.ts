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

/**
 * Shortcuts of the built-in items, explicit or of their roles: a plugin's item
 * cannot take them (D516).
 */
const BUILT_IN_ACCELERATORS = [
  "CmdOrCtrl+,",
  "CmdOrCtrl+R",
  "Shift+CmdOrCtrl+R",
  "Alt+Command+I",
  "Ctrl+Shift+I",
  "CmdOrCtrl+0",
  "CmdOrCtrl+=",
  "CmdOrCtrl+Plus",
  "CmdOrCtrl+-",
  "CmdOrCtrl+num0",
  "CmdOrCtrl+numadd",
  "CmdOrCtrl+numsub",
  "CmdOrCtrl+Z",
  "Shift+CmdOrCtrl+Z",
  "CmdOrCtrl+X",
  "CmdOrCtrl+C",
  "CmdOrCtrl+V",
  "CmdOrCtrl+A",
  "CmdOrCtrl+Q",
  "CmdOrCtrl+W",
  "CmdOrCtrl+M",
  "CmdOrCtrl+H",
  "F11",
];

/** A shortcut's keys, whatever their order and case: `Shift+CmdOrCtrl+R` is `cmdorctrl+r+shift`. */
function keys(accelerator: string): string {
  return accelerator.toLowerCase().split("+").toSorted().join("+");
}

/**
 * The plugins' items the menu can show: the first item of an id, and no
 * shortcut that a built-in item or an earlier item already has.
 */
function usableContributions(items: readonly DesktopMenuContribution[]): DesktopMenuContribution[] {
  const ids = new Set<string>();
  const taken = new Set(BUILT_IN_ACCELERATORS.map(keys));
  const usable: DesktopMenuContribution[] = [];
  for (const item of items) {
    if (ids.has(item.id)) continue;
    ids.add(item.id);
    if (item.accelerator === undefined) {
      usable.push(item);
      continue;
    }
    const shortcut = keys(item.accelerator);
    if (taken.has(shortcut)) {
      const { accelerator: _taken, ...rest } = item;
      usable.push(rest);
    } else {
      taken.add(shortcut);
      usable.push(item);
    }
  }
  return usable;
}

/** The application menu: T3's template, plus the items plugins contribute. */
export function buildApplicationMenu(options: {
  readonly platform: NodeJS.Platform;
  readonly appName: string;
  readonly handlers: MenuHandlers;
  readonly contributions: readonly DesktopMenuContribution[];
}): MenuItemConstructorOptions[] {
  const { platform, appName, handlers } = options;
  const contributions = usableContributions(options.contributions);
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
