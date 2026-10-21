// The custom snooze dialog follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/CustomSnoozeDialog.tsx. T3 picks the date with a calendar
// popover and the amount with a number field; here they are the browser's date and
// number inputs.
import { useEffect, useSyncExternalStore } from "react";

import { lazyChunk } from "./lazy-chunk.tsx";

/** Who asked for a custom snooze; one at a time, a new request cancels the previous one. */
export function createCustomSnoozeRequests() {
  let current:
    | {
        readonly id: number;
        resolve(until: string | undefined): void;
        reject(error: Error): void;
      }
    | undefined;
  let ids = 0;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  return {
    /** The chosen wake time, or undefined when cancelled. */
    request(): Promise<string | undefined> {
      current?.resolve(undefined);
      return new Promise((resolve, reject) => {
        current = { id: ++ids, resolve, reject };
        changed();
      });
    },
    finish(until: string | undefined) {
      const request = current;
      current = undefined;
      request?.resolve(until);
      changed();
    },
    /** Ends the request with an error, which reaches whoever asked (a toast, a caller). */
    fail(error: Error) {
      const request = current;
      current = undefined;
      request?.reject(error);
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

/** Fails the request whose dialog could not load: its snooze says so instead of waiting. */
function Cancelled({ requests }: { requests: CustomSnoozeRequests }) {
  useEffect(() => requests.fail(new Error("Couldn't load the custom snooze dialog.")), [requests]);
  return null;
}

// A chunk of its own (D440): the page's entry stays small.
const CustomSnoozeDialog = lazyChunk(
  () => import("./custom-snooze-dialog.tsx").then((module) => module.CustomSnoozeDialog),
  { loading: () => null, failed: (props) => <Cancelled {...props} /> },
);
