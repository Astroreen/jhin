// The custom snooze dialog follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/CustomSnoozeDialog.tsx. T3 picks the date with a calendar
// popover and the amount with a number field; here they are the browser's date and
// number inputs.
import { useEffect, useSyncExternalStore } from "react";

import { lazyChunk } from "./lazy-chunk.tsx";

/** Who asked for a custom snooze; one at a time, a new request cancels the previous one. */
export function createCustomSnoozeRequests() {
  let current: { readonly id: number; resolve(until: string | undefined): void } | undefined;
  let ids = 0;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  return {
    /** The chosen wake time, or undefined when cancelled. */
    request(): Promise<string | undefined> {
      current?.resolve(undefined);
      return new Promise((resolve) => {
        current = { id: ++ids, resolve };
        changed();
      });
    },
    finish(until: string | undefined) {
      const request = current;
      current = undefined;
      request?.resolve(until);
      changed();
    },
    current: () => current?.id,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type CustomSnoozeRequests = ReturnType<typeof createCustomSnoozeRequests>;

/** Mounted once (in `app.global`): shows the dialog while a request is open. */
export function CustomSnoozeDialogHost({ requests }: { requests: CustomSnoozeRequests }) {
  const id = useSyncExternalStore(requests.subscribe, requests.current);
  return id === undefined ? null : <CustomSnoozeDialog key={id} requests={requests} />;
}

/** Cancels the request whose dialog could not load, so its snooze does not wait forever. */
function Cancelled({ requests }: { requests: CustomSnoozeRequests }) {
  useEffect(() => requests.finish(undefined), [requests]);
  return null;
}

// A chunk of its own (D440): the page's entry stays small.
const CustomSnoozeDialog = lazyChunk(
  () => import("./custom-snooze-dialog.tsx").then((module) => module.CustomSnoozeDialog),
  { loading: () => null, failed: (props) => <Cancelled {...props} /> },
);
