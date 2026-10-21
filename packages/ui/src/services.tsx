// The dialog host is derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/confirmDialog.ts and apps/web/src/components/ConfirmDialogHost.tsx.
import type { Disposable } from "@jhin/sdk";
import * as React from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./components/alert-dialog.tsx";
import { Button } from "./components/button.tsx";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./components/dialog.tsx";
import { Input } from "./components/input.tsx";
import { toastManager, type ToastData } from "./components/toast.tsx";

/** `ui.toasts@1`: transient notices in the corner of the page. */
export const UI_TOASTS_CAPABILITY = "ui.toasts";
/** `ui.dialogs@1`: modal questions to the user. */
export const UI_DIALOGS_CAPABILITY = "ui.dialogs";

export interface ToastOptions {
  /** Showing a toast with the id of an open one replaces it. */
  readonly id?: string;
  readonly type?: "success" | "error" | "warning" | "info" | "loading";
  readonly title: React.ReactNode;
  readonly description?: React.ReactNode;
  /** Milliseconds until it closes by itself; 0 keeps it open. */
  readonly timeout?: number;
  readonly action?: { readonly label: string; readonly onClick: () => void };
  readonly data?: ToastData;
}

export interface Toasts {
  show(toast: ToastOptions): string;
  update(id: string, toast: Partial<ToastOptions>): void;
  close(id: string): void;
}

function toManagerOptions(toast: Partial<ToastOptions>) {
  return {
    ...(toast.id === undefined ? {} : { id: toast.id }),
    ...(toast.type === undefined ? {} : { type: toast.type }),
    ...(toast.title === undefined ? {} : { title: toast.title }),
    ...(toast.description === undefined ? {} : { description: toast.description }),
    ...(toast.timeout === undefined ? {} : { timeout: toast.timeout }),
    ...(toast.data === undefined ? {} : { data: toast.data }),
    ...(toast.action === undefined
      ? {}
      : { actionProps: { children: toast.action.label, onClick: toast.action.onClick } }),
  };
}

/** Toasts shown by the `ToastProvider` the UI host mounts. */
export function createToasts(): Toasts {
  return {
    show(toast) {
      if (toast.id !== undefined) toastManager.close(toast.id);
      return toastManager.add(toManagerOptions(toast));
    },
    update: (id, toast) => toastManager.update(id, toManagerOptions(toast)),
    close: (id) => toastManager.close(id),
  };
}

export interface ConfirmOptions {
  readonly title: string;
  readonly description?: string;
  /** Default "Confirm". */
  readonly confirmLabel?: string;
  readonly variant?: "default" | "destructive";
  /** A second way to agree, shown left of the confirm button (`choose` only). */
  readonly alternativeLabel?: string;
  readonly alternativeVariant?: "default" | "destructive" | "outline";
}

export interface PromptOptions {
  readonly title: string;
  readonly description?: string;
  /** Accessible name of the field; the title when absent. */
  readonly label?: string;
  readonly placeholder?: string;
  readonly value?: string;
  /** Default "Save". */
  readonly confirmLabel?: string;
  /** A message when the value cannot be accepted. */
  validate?(value: string): string | undefined;
}

export interface Dialogs {
  /** True when confirmed; false when cancelled or when no host is mounted. */
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** The entered value, or undefined when cancelled. */
  prompt(options: PromptOptions): Promise<string | undefined>;
  /**
   * A confirmation with two ways to agree (`alternativeLabel`): which one was
   * chosen, or undefined when cancelled or when no host is mounted.
   */
  choose?(options: ConfirmOptions): Promise<"confirm" | "alternative" | undefined>;
}

type Request = { readonly id: number } & (
  | {
      readonly kind: "confirm";
      readonly options: ConfirmOptions;
      resolve(value: "confirm" | "alternative" | undefined): void;
    }
  | {
      readonly kind: "prompt";
      readonly options: PromptOptions;
      resolve(value: string | undefined): void;
    }
);

type HostState =
  | { readonly status: "idle" }
  | { readonly status: "open" | "closing"; readonly request: Request };

/** One request at a time, the rest queued, each answered exactly once. */
export function createDialogs(): Dialogs & {
  state(): HostState;
  subscribe(listener: () => void): Disposable;
  /** `subscribe` as React's useSyncExternalStore takes it: one function, unsubscribing by return. */
  watch(listener: () => void): () => void;
  respond(value: boolean | string | undefined): void;
  closed(): void;
  register(): () => void;
} {
  let state: HostState = { status: "idle" };
  let queue: Request[] = [];
  let hosts = 0;
  let ids = 0;
  const listeners = new Set<() => void>();
  const publish = (next: HostState) => {
    state = next;
    for (const listener of Array.from(listeners)) listener();
  };
  const answer = (request: Request, value: boolean | string | undefined) => {
    if (request.kind === "confirm") {
      request.resolve(
        value === true ? "confirm" : value === "alternative" ? "alternative" : undefined,
      );
    } else request.resolve(typeof value === "string" ? value : undefined);
  };
  const enqueue = (request: Request) => {
    if (hosts === 0) {
      answer(request, undefined);
      return;
    }
    if (state.status === "idle") publish({ status: "open", request });
    else queue.push(request);
  };
  return {
    confirm: (options) =>
      new Promise((resolve) =>
        enqueue({
          id: ++ids,
          kind: "confirm",
          // A plain confirmation has one way to agree.
          options: (({ alternativeLabel: _label, ...rest }) => rest)(options),
          resolve: (value) => resolve(value === "confirm"),
        }),
      ),
    choose: (options) =>
      new Promise((resolve) => enqueue({ id: ++ids, kind: "confirm", options, resolve })),
    prompt: (options) =>
      new Promise((resolve) => enqueue({ id: ++ids, kind: "prompt", options, resolve })),
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    watch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    respond(value) {
      if (state.status !== "open") return;
      answer(state.request, value);
      publish({ status: "closing", request: state.request });
    },
    closed() {
      if (state.status !== "closing") return;
      const next = queue.shift();
      publish(next === undefined ? { status: "idle" } : { status: "open", request: next });
    },
    register() {
      hosts += 1;
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        hosts -= 1;
        if (hosts > 0) return;
        if (state.status === "open") answer(state.request, undefined);
        for (const request of queue) answer(request, undefined);
        queue = [];
        publish({ status: "idle" });
      };
    },
  };
}

function PromptForm(props: {
  options: PromptOptions;
  onSubmit(value: string): void;
  onCancel(): void;
}) {
  const { options } = props;
  const [value, setValue] = React.useState(options.value ?? "");
  const error = options.validate?.(value);
  // An error shows once the value was changed.
  const shownError = error !== undefined && value !== (options.value ?? "") ? error : undefined;
  const errorId = React.useId();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (error === undefined) props.onSubmit(value);
      }}
    >
      <DialogHeader>
        <DialogTitle>{options.title}</DialogTitle>
        {options.description === undefined ? null : (
          <DialogDescription>{options.description}</DialogDescription>
        )}
      </DialogHeader>
      <DialogPanel>
        <Input
          aria-describedby={shownError === undefined ? undefined : errorId}
          aria-invalid={shownError !== undefined}
          aria-label={options.label ?? options.title}
          autoFocus
          onChange={(event) => setValue(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          placeholder={options.placeholder}
          value={value}
        />
        {shownError === undefined ? null : (
          <p className="text-destructive-foreground text-xs" id={errorId} role="alert">
            {shownError}
          </p>
        )}
      </DialogPanel>
      <DialogFooter>
        <Button onClick={props.onCancel} type="button" variant="outline">
          Cancel
        </Button>
        <Button disabled={error !== undefined} type="submit">
          {options.confirmLabel ?? "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Shows the requests of `dialogs`; the UI host mounts one. */
export function DialogHost({ dialogs }: { dialogs: ReturnType<typeof createDialogs> }) {
  const state = React.useSyncExternalStore(dialogs.watch, dialogs.state);
  React.useEffect(() => dialogs.register(), [dialogs]);
  const request = state.status === "idle" ? undefined : state.request;
  const open = state.status === "open";

  return (
    <>
      <AlertDialog
        open={open && request?.kind === "confirm"}
        onOpenChange={(next) => {
          if (!next) dialogs.respond(false);
        }}
        onOpenChangeComplete={(next) => {
          if (!next) dialogs.closed();
        }}
      >
        {request?.kind === "confirm" ? (
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>{request.options.title}</AlertDialogTitle>
              {request.options.description === undefined ? null : (
                <AlertDialogDescription className="whitespace-pre-line">
                  {request.options.description}
                </AlertDialogDescription>
              )}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
              {request.options.alternativeLabel === undefined ? null : (
                <Button
                  onClick={() => dialogs.respond("alternative")}
                  variant={request.options.alternativeVariant ?? "outline"}
                >
                  {request.options.alternativeLabel}
                </Button>
              )}
              <Button
                onClick={() => dialogs.respond(true)}
                variant={request.options.variant ?? "default"}
              >
                {request.options.confirmLabel ?? "Confirm"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        ) : null}
      </AlertDialog>
      <Dialog
        open={open && request?.kind === "prompt"}
        onOpenChange={(next) => {
          if (!next) dialogs.respond(undefined);
        }}
        onOpenChangeComplete={(next) => {
          if (!next) dialogs.closed();
        }}
      >
        {request?.kind === "prompt" ? (
          <DialogPopup showCloseButton={false}>
            <PromptForm
              key={request.id}
              onCancel={() => dialogs.respond(undefined)}
              onSubmit={(value) => dialogs.respond(value)}
              options={request.options}
            />
          </DialogPopup>
        ) : null}
      </Dialog>
    </>
  );
}

/** `ui.settings@1`: the sections of the settings page; plugins add their own. */
export const UI_SETTINGS_CAPABILITY = "ui.settings";

export interface SettingsSectionDefinition {
  /** Stable id, public API; also the route section (`#p=settings&s=<id>`). */
  readonly id: string;
  readonly label: string;
  readonly icon?: React.ComponentType<{ className?: string }>;
  /** Lower comes first; ties sort by label. Default 0. */
  readonly order?: number;
  readonly component: React.ComponentType;
}

export interface SettingsPages {
  addSection(section: SettingsSectionDefinition): Disposable;
  /** Opens the settings page, at a section when given. */
  open(section?: string): void;
}
