// The scripts menu and its "Add Action" dialog follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/ProjectScriptsControl.tsx (its toolbar mode),
// apps/web/src/components/projectScriptEditor.tsx (ProjectScriptEditorDialog, ScriptIcon) and
// apps/web/src/projectScripts.ts (buildProjectScript).
import {
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
  projectScriptMenuLabel,
  releaseClaimedRoles,
  type ProjectScript,
  type ProjectScriptIcon,
  type T3ProjectFileScript,
} from "@jhin/agent-api";
import type { NodeTarget, ProjectRecord, ThreadRecord } from "@jhin/client-api";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  Group,
  GroupSeparator,
  Input,
  Label,
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
  Popover,
  PopoverPopup,
  PopoverTrigger,
  Switch,
  Textarea,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  cn,
} from "@jhin/ui";
import {
  BugIcon,
  ChevronDownIcon,
  DownloadIcon,
  FlaskConicalIcon,
  HammerIcon,
  ListChecksIcon,
  PlayIcon,
  PlusIcon,
  SettingsIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useId, useState, type FormEvent, type KeyboardEvent } from "react";

import { keyFromEvent } from "../../lib/keybindings.ts";

const SCRIPT_ICONS: { readonly id: ProjectScriptIcon; readonly label: string }[] = [
  { id: "play", label: "Play" },
  { id: "test", label: "Test" },
  { id: "lint", label: "Lint" },
  { id: "configure", label: "Configure" },
  { id: "build", label: "Build" },
  { id: "debug", label: "Debug" },
];

function ScriptIcon({
  icon,
  className = "size-3.5",
}: {
  readonly icon: ProjectScriptIcon;
  readonly className?: string;
}) {
  if (icon === "test") return <FlaskConicalIcon className={className} />;
  if (icon === "lint") return <ListChecksIcon className={className} />;
  if (icon === "configure") return <WrenchIcon className={className} />;
  if (icon === "build") return <HammerIcon className={className} />;
  if (icon === "debug") return <BugIcon className={className} />;
  return <PlayIcon className={className} />;
}

/** What the dialog edits (T3's `NewProjectScriptInput`). */
export interface ScriptInput {
  readonly name: string;
  readonly command: string;
  readonly icon: ProjectScriptIcon;
  readonly runOnWorktreeCreate: boolean;
  readonly waitForSetup: boolean;
  readonly runOnSettle: boolean;
  /** Absent: the shortcut is left as it is. */
  readonly keybinding?: string | null;
  readonly previewUrl: string | null;
  readonly autoOpenPreview: boolean;
}

const EMPTY_INPUT: ScriptInput = {
  name: "",
  command: "",
  icon: "play",
  runOnWorktreeCreate: false,
  waitForSetup: false,
  runOnSettle: false,
  keybinding: null,
  previewUrl: null,
  autoOpenPreview: false,
};

/** T3's `buildProjectScript`. */
export function buildProjectScript(id: string, input: ScriptInput): ProjectScript {
  return {
    id,
    name: input.name,
    command: input.command,
    icon: input.icon,
    runOnWorktreeCreate: input.runOnWorktreeCreate,
    ...(input.runOnWorktreeCreate && input.waitForSetup ? { async: false } : {}),
    ...(input.runOnSettle ? { runOnSettle: true } : {}),
    ...(input.previewUrl === null
      ? {}
      : { previewUrl: input.previewUrl, autoOpenPreview: input.autoOpenPreview }),
  };
}

/**
 * The project's scripts once `input` is saved as `scriptId` (null: a new
 * one): the setup and settle roles it takes leave the script that had them.
 */
export function scriptsWith(
  scripts: readonly ProjectScript[],
  scriptId: string | null,
  input: ScriptInput,
): { readonly scripts: ProjectScript[]; readonly id: string } {
  const id =
    scriptId ??
    nextProjectScriptId(
      input.name,
      scripts.map((script) => script.id),
    );
  const saved = buildProjectScript(id, input);
  const others = (script: ProjectScript) => releaseClaimedRoles(script, saved);
  return {
    id,
    scripts:
      scriptId === null
        ? [...scripts.map(others), saved]
        : scripts.map((script) => (script.id === scriptId ? saved : others(script))),
  };
}

/** A `t3.json` script as the dialog's input (T3's `importFileScript`). */
export const inputFromFile = (file: T3ProjectFileScript): ScriptInput => ({
  name: file.name,
  command: file.command,
  icon: file.icon ?? "play",
  runOnWorktreeCreate: file.runOnWorktreeCreate ?? false,
  waitForSetup: file.runOnWorktreeCreate === true && file.async === false,
  runOnSettle: file.runOnSettle ?? false,
  keybinding: null,
  previewUrl: file.previewUrl ?? null,
  autoOpenPreview: file.previewUrl === undefined ? false : (file.autoOpenPreview ?? false),
});

/** The file's scripts the project has not imported, by command or name (T3's rule). */
export const importableScripts = (
  scripts: readonly ProjectScript[],
  file: readonly T3ProjectFileScript[],
) =>
  file.filter(
    (candidate) =>
      !scripts.some(
        (script) =>
          script.command === candidate.command ||
          script.name.toLowerCase() === candidate.name.toLowerCase(),
      ),
  );

export interface ScriptsControlServices {
  /** Runs a script in the thread; failures are told by the caller. */
  run(target: NodeTarget, thread: ThreadRecord, script: ProjectScript): void;
  /** Saves the project's scripts whole; rejects with the node's refusal. */
  save(target: NodeTarget, projectId: string, scripts: readonly ProjectScript[]): Promise<void>;
  /** Reads the project's `t3.json` scripts. */
  fileScripts(
    target: NodeTarget,
    projectId: string,
    threadId: string | undefined,
  ): Promise<readonly T3ProjectFileScript[]>;
  /** The script last run in the project on this device. */
  lastRun(target: NodeTarget, projectId: string): string | undefined;
  /** The shortcut of a client command as shown, kept current as shortcuts change. */
  useShortcutLabel(command: string | undefined): string | undefined;
  shortcutKey(command: string): string | null;
  /** Sets this device's rule for the command; null unbinds it. */
  setShortcut(command: string, key: string | null): Promise<void>;
  confirmDelete(name: string): Promise<boolean>;
}

/** A script's shortcut beside it in the menu (T3's `MenuShortcut`), current as shortcuts change. */
function ScriptShortcut(props: {
  readonly command: string | undefined;
  readonly useLabel: (command: string | undefined) => string | undefined;
}) {
  const label = props.useLabel(props.command);
  return label === undefined ? null : (
    <span className="transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">
      <MenuShortcut className="ms-0">{label}</MenuShortcut>
    </span>
  );
}

interface EditorRequest {
  readonly scriptId: string | null;
  readonly initial: ScriptInput;
  readonly error?: string;
}

/** T3's scripts control in its toolbar mode (D1473). */
export function ProjectScriptsControl(props: {
  readonly target: NodeTarget;
  readonly thread: ThreadRecord | undefined;
  readonly project: ProjectRecord;
  readonly services: ScriptsControlServices;
}) {
  const { target, thread, project, services } = props;
  const scripts = (project.scripts ?? []) as readonly ProjectScript[];
  const [fileScripts, setFileScripts] = useState<readonly T3ProjectFileScript[]>([]);
  const [editor, setEditor] = useState<EditorRequest | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const fileKey = `${target.node}:${target.remote ?? ""}:${project.id}:${thread?.worktreePath ?? ""}`;
  useEffect(() => {
    let current = true;
    void services
      .fileScripts(target, project.id, thread?.id)
      .then((next) => current && setFileScripts(next))
      .catch(() => current && setFileScripts([]));
    return () => {
      current = false;
    };
  }, [fileKey]);

  const last = services.lastRun(target, project.id);
  const primary =
    (last === undefined ? undefined : scripts.find((script) => script.id === last)) ??
    primaryProjectScript(scripts);
  const importable = importableScripts(scripts, fileScripts);
  const run = (script: ProjectScript) => {
    if (thread !== undefined) services.run(target, thread, script);
  };

  const submit = async (scriptId: string | null, input: ScriptInput) => {
    const next = scriptsWith(scripts, scriptId, input);
    await services.save(target, project.id, next.scripts);
    const command = commandForProjectScript(next.id);
    if (command !== undefined && input.keybinding !== undefined) {
      await services.setShortcut(command, input.keybinding);
    }
  };
  const remove = async (scriptId: string) => {
    await services.save(
      target,
      project.id,
      scripts.filter((script) => script.id !== scriptId),
    );
  };
  const importFile = async (file: T3ProjectFileScript) => {
    const input = inputFromFile(file);
    try {
      await submit(null, input);
    } catch (error) {
      setEditor({
        scriptId: null,
        initial: input,
        error: error instanceof Error ? error.message : "Failed to import action.",
      });
    }
  };
  const edit = (script: ProjectScript) => {
    setMenuOpen(false);
    const command = commandForProjectScript(script.id);
    setEditor({
      scriptId: script.id,
      initial: {
        name: script.name,
        command: script.command,
        icon: script.icon,
        runOnWorktreeCreate: script.runOnWorktreeCreate,
        waitForSetup: script.runOnWorktreeCreate && script.async === false,
        runOnSettle: script.runOnSettle === true,
        keybinding: command === undefined ? null : services.shortcutKey(command),
        previewUrl: script.previewUrl ?? null,
        autoOpenPreview: script.autoOpenPreview === true,
      },
    });
  };
  const add = () => setEditor({ scriptId: null, initial: EMPTY_INPUT });

  const items = (
    <>
      {scripts.map((script) => {
        return (
          <MenuItem
            className="group"
            disabled={thread === undefined}
            key={script.id}
            onClick={() => run(script)}
          >
            <ScriptIcon className="size-4" icon={script.icon} />
            <MenuItemLabel>{projectScriptMenuLabel(script)}</MenuItemLabel>
            <span className="relative ms-auto flex h-6 min-w-6 items-center justify-end">
              <ScriptShortcut
                command={commandForProjectScript(script.id)}
                useLabel={services.useShortcutLabel}
              />
              <span className="pointer-events-none absolute top-1/2 right-0 flex -translate-y-1/2 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-visible:pointer-events-auto group-focus-visible:opacity-100">
                <Button
                  aria-label={`Edit ${script.name}`}
                  className="size-6"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    edit(script);
                  }}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <SettingsIcon className="size-3.5" />
                </Button>
              </span>
            </span>
          </MenuItem>
        );
      })}
      {importable.length === 0 ? null : (
        <>
          {scripts.length > 0 ? <MenuSeparator /> : null}
          <MenuGroup>
            <MenuGroupLabel>From t3.json</MenuGroupLabel>
            {importable.map((file) => (
              <MenuItem key={`${file.name} ${file.command}`} onClick={() => void importFile(file)}>
                <ScriptIcon className="size-4" icon={file.icon ?? "play"} />
                <MenuItemLabel>{file.name}</MenuItemLabel>
                <MenuShortcut>
                  <DownloadIcon aria-label="Import" className="size-3.5" />
                </MenuShortcut>
              </MenuItem>
            ))}
          </MenuGroup>
        </>
      )}
      <MenuItem onClick={add}>
        <PlusIcon className="size-4" />
        <MenuItemLabel>Add action</MenuItemLabel>
      </MenuItem>
    </>
  );

  return (
    <>
      {primary !== undefined ? (
        <Group aria-label="Project scripts" className="shrink-0" role="group">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={`Run ${primary.name}`}
                  disabled={thread === undefined}
                  onClick={() => run(primary)}
                  size="xs"
                  variant="outline"
                />
              }
            >
              <ScriptIcon icon={primary.icon} />
              <span className="sr-only lg:not-sr-only lg:ml-0.5">{primary.name}</span>
            </TooltipTrigger>
            <TooltipPopup side="top">{`Run ${primary.name}`}</TooltipPopup>
          </Tooltip>
          <GroupSeparator className="hidden lg:block" />
          <Menu onOpenChange={setMenuOpen} open={menuOpen}>
            <MenuTrigger
              render={<Button aria-label="Script actions" size="icon-xs" variant="outline" />}
            >
              <ChevronDownIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">{items}</MenuPopup>
          </Menu>
        </Group>
      ) : scripts.length > 0 || importable.length > 0 ? (
        <Menu onOpenChange={setMenuOpen} open={menuOpen}>
          <MenuTrigger render={<Button aria-label="Project actions" size="xs" variant="outline" />}>
            <WrenchIcon className="size-3.5" />
            <span className="sr-only lg:not-sr-only lg:ml-0.5">Actions</span>
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">{items}</MenuPopup>
        </Menu>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={<Button aria-label="Add action" onClick={add} size="xs" variant="outline" />}
          >
            <PlusIcon className="size-3.5" />
            <span className="sr-only lg:not-sr-only lg:ml-0.5">Add action</span>
          </TooltipTrigger>
          <TooltipPopup side="top">Add action</TooltipPopup>
        </Tooltip>
      )}
      <ScriptEditorDialog
        onClose={() => setEditor(null)}
        onDelete={async (scriptId, name) => {
          if (!(await services.confirmDelete(name))) return false;
          await remove(scriptId);
          return true;
        }}
        onSubmit={submit}
        request={editor}
        scripts={scripts}
      />
    </>
  );
}

/** T3's `ProjectScriptEditorDialog`, its form and words (D1474). */
function ScriptEditorDialog(props: {
  readonly request: EditorRequest | null;
  readonly scripts: readonly ProjectScript[];
  readonly onSubmit: (scriptId: string | null, input: ScriptInput) => Promise<void>;
  readonly onDelete: (scriptId: string, name: string) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const { request } = props;
  const formId = useId();
  const [shown, setShown] = useState<EditorRequest | null>(null);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [icon, setIcon] = useState<ProjectScriptIcon>("play");
  const [iconsOpen, setIconsOpen] = useState(false);
  const [runOnWorktreeCreate, setRunOnWorktreeCreate] = useState(false);
  const [waitForSetup, setWaitForSetup] = useState(false);
  const [runOnSettle, setRunOnSettle] = useState(false);
  const [keybinding, setKeybinding] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [autoOpenPreview, setAutoOpenPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // A new request starts the form from its own values and error.
  if (request !== shown) {
    setShown(request);
    if (request !== null) {
      setName(request.initial.name);
      setCommand(request.initial.command);
      setIcon(request.initial.icon);
      setIconsOpen(false);
      setRunOnWorktreeCreate(request.initial.runOnWorktreeCreate);
      setWaitForSetup(request.initial.waitForSetup);
      setRunOnSettle(request.initial.runOnSettle);
      setKeybinding(request.initial.keybinding ?? "");
      setPreviewUrl(request.initial.previewUrl ?? "");
      setAutoOpenPreview(request.initial.autoOpenPreview);
      setError(request.error ?? null);
      setSaving(false);
    }
  }
  const editing = request?.scriptId != null;

  const capture = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    if (event.key === "Backspace" || event.key === "Delete") return setKeybinding("");
    const key = keyFromEvent(event.nativeEvent);
    if (key !== null) setKeybinding(key);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (request === null || saving) return;
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (trimmedName === "") return setError("Name is required.");
    if (trimmedCommand === "") return setError("Command is required.");
    const trimmedUrl = previewUrl.trim();
    const changesKeybinding =
      (keybinding.trim() || null) !== (request.initial.keybinding?.trim() || null);
    setError(null);
    setSaving(true);
    try {
      await props.onSubmit(request.scriptId, {
        name: trimmedName,
        command: trimmedCommand,
        icon,
        runOnWorktreeCreate,
        waitForSetup: runOnWorktreeCreate && waitForSetup,
        runOnSettle,
        ...(request.scriptId === null || changesKeybinding
          ? { keybinding: keybinding.trim() || null }
          : {}),
        previewUrl: trimmedUrl === "" ? null : trimmedUrl,
        autoOpenPreview: trimmedUrl === "" ? false : autoOpenPreview,
      });
      props.onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Failed to save action.");
    } finally {
      setSaving(false);
    }
  };

  const toggleRow =
    "flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035]";
  return (
    <Dialog
      onOpenChange={(open: boolean) => {
        if (!open) props.onClose();
      }}
      open={request !== null}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Action" : "Add Action"}</DialogTitle>
          <DialogDescription>
            Actions are project-scoped commands you can run from the top bar or keybindings.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form id={formId} onSubmit={(event) => void submit(event)}>
            <fieldset className="space-y-4" disabled={saving}>
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-name`}>Name</Label>
                <div className="flex items-center gap-2">
                  <Popover onOpenChange={setIconsOpen} open={iconsOpen}>
                    <PopoverTrigger
                      render={
                        <Button
                          aria-label="Choose icon"
                          className="size-9 shrink-0"
                          type="button"
                          variant="outline"
                        />
                      }
                    >
                      <ScriptIcon className="size-4.5" icon={icon} />
                    </PopoverTrigger>
                    <PopoverPopup align="start">
                      <div className="grid grid-cols-3 gap-2">
                        {SCRIPT_ICONS.map((entry) => (
                          <button
                            className={cn(
                              "relative flex flex-col items-center gap-2 rounded-md border px-2 py-2 text-xs dark:border-transparent",
                              entry.id === icon
                                ? "border-primary/70 bg-primary/10 ring-inset dark:ring-1 dark:ring-primary/30"
                                : "border-border/70 hover:bg-accent/60 dark:bg-white/[0.035]",
                            )}
                            key={entry.id}
                            onClick={() => {
                              setIcon(entry.id);
                              setIconsOpen(false);
                            }}
                            type="button"
                          >
                            <ScriptIcon className="size-4" icon={entry.id} />
                            <span>{entry.label}</span>
                          </button>
                        ))}
                      </div>
                    </PopoverPopup>
                  </Popover>
                  <Input
                    autoFocus
                    id={`${formId}-name`}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Test"
                    value={name}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-keybinding`}>Keybinding</Label>
                <Input
                  id={`${formId}-keybinding`}
                  onKeyDown={capture}
                  placeholder="Press shortcut"
                  readOnly
                  value={keybinding}
                />
                <p className="text-xs text-muted-foreground">
                  Press a shortcut. Use <code>Backspace</code> to clear. Shortcuts belong to this
                  device. Projects using the same action share its shortcut.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-command`}>Command</Label>
                <Textarea
                  id={`${formId}-command`}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder="pnpm test"
                  value={command}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-preview`}>Preview URL (optional)</Label>
                <Input
                  id={`${formId}-preview`}
                  onChange={(event) => setPreviewUrl(event.target.value)}
                  placeholder="http://localhost:5173"
                  value={previewUrl}
                />
                <p className="text-xs text-muted-foreground">
                  Open this URL in the in-app preview when this action runs.
                </p>
              </div>
              <label className={toggleRow}>
                <span>Run automatically on worktree creation</span>
                <Switch
                  checked={runOnWorktreeCreate}
                  onCheckedChange={(checked) => setRunOnWorktreeCreate(Boolean(checked))}
                />
              </label>
              <label className={cn(toggleRow, !runOnWorktreeCreate && "opacity-60")}>
                <span>Wait for it to finish before the agent starts</span>
                <Switch
                  checked={waitForSetup}
                  disabled={!runOnWorktreeCreate}
                  onCheckedChange={(checked) => setWaitForSetup(Boolean(checked))}
                />
              </label>
              <label className={toggleRow}>
                <span>Run in the thread's worktree when the thread settles</span>
                <Switch
                  checked={runOnSettle}
                  onCheckedChange={(checked) => setRunOnSettle(Boolean(checked))}
                />
              </label>
              <label className={cn(toggleRow, previewUrl.trim() === "" && "opacity-60")}>
                <span>Open preview automatically when this action runs</span>
                <Switch
                  checked={autoOpenPreview}
                  disabled={previewUrl.trim() === ""}
                  onCheckedChange={(checked) => setAutoOpenPreview(Boolean(checked))}
                />
              </label>
              {error === null ? null : (
                <p className="text-sm text-destructive-foreground" role="alert">
                  {error}
                </p>
              )}
            </fieldset>
          </form>
        </DialogPanel>
        <DialogFooter>
          {editing ? (
            <Button
              className="mr-auto"
              disabled={saving}
              onClick={() => {
                if (request?.scriptId == null) return;
                const scriptId = request.scriptId;
                void props.onDelete(scriptId, name).then(
                  (deleted) => {
                    if (deleted) props.onClose();
                  },
                  (failure: unknown) =>
                    setError(
                      failure instanceof Error ? failure.message : "Failed to delete action.",
                    ),
                );
              }}
              type="button"
              variant="destructive-outline"
            >
              Delete
            </Button>
          ) : null}
          <Button onClick={props.onClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button disabled={saving} form={formId} type="submit">
            {saving ? "Saving…" : editing ? "Save changes" : "Save action"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
