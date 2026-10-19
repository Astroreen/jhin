// The custom snooze dialog follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/CustomSnoozeDialog.tsx. T3 picks the date with a calendar
// popover and the amount with a number field; here they are the browser's date and
// number inputs.
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  ToggleGroup,
  ToggleGroupItem,
} from "@jhin/ui";
import { useId, useState, useSyncExternalStore } from "react";

import {
  localSnoozeDate,
  localSnoozeTime,
  resolveCustomSnooze,
  type CustomSnoozeInput,
} from "./snooze.ts";

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

function CustomSnoozeDialog({ requests }: { requests: CustomSnoozeRequests }) {
  const id = useId();
  const [initial] = useState(() => new Date(Date.now() + 3_600_000));
  const [mode, setMode] = useState<CustomSnoozeInput["mode"]>("date");
  const [date, setDate] = useState(() => localSnoozeDate(initial));
  const [time, setTime] = useState(() => localSnoozeTime(initial));
  const [amount, setAmount] = useState("2");
  const [unit, setUnit] = useState<"minutes" | "hours" | "days">("hours");
  const [error, setError] = useState<string | null>(null);
  const input: CustomSnoozeInput = mode === "date" ? { mode, date, time } : { mode, amount, unit };
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) requests.finish(undefined);
      }}
      open
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const until = resolveCustomSnooze(input, new Date());
            if (until === null) {
              setError(
                mode === "date"
                  ? "Choose a valid date and time in the future."
                  : "Enter a positive duration.",
              );
              return;
            }
            requests.finish(until);
          }}
        >
          <DialogHeader>
            <DialogTitle>Custom snooze</DialogTitle>
            <DialogDescription>Choose when snoozed threads return to your inbox.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <ToggleGroup
                aria-label="Schedule type"
                className="w-full *:flex-1"
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "date" || value === "duration") setMode(value);
                  setError(null);
                }}
                value={[mode]}
              >
                <ToggleGroupItem value="date">Date and time</ToggleGroupItem>
                <ToggleGroupItem value="duration">Duration</ToggleGroupItem>
              </ToggleGroup>
              {mode === "date" ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-date`}>
                    Date
                    <Input
                      className="h-9 sm:h-8"
                      id={`${id}-date`}
                      min={localSnoozeDate(new Date())}
                      nativeInput
                      onChange={(event) => {
                        setDate(event.target.value);
                        setError(null);
                      }}
                      required
                      type="date"
                      value={date}
                    />
                  </Label>
                  <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-time`}>
                    Time
                    <Input
                      className="h-9 sm:h-8"
                      id={`${id}-time`}
                      nativeInput
                      onChange={(event) => {
                        setTime(event.target.value);
                        setError(null);
                      }}
                      required
                      type="time"
                      value={time}
                    />
                  </Label>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-amount`}>
                    Snooze for
                    <Input
                      className="h-9 sm:h-8"
                      id={`${id}-amount`}
                      min={0}
                      nativeInput
                      onChange={(event) => {
                        setAmount(event.target.value);
                        setError(null);
                      }}
                      required
                      step="any"
                      type="number"
                      value={amount}
                    />
                  </Label>
                  <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-unit`}>
                    Unit
                    <Select
                      items={{ minutes: "Minutes", hours: "Hours", days: "Days" }}
                      onValueChange={(value) => {
                        if (value === "minutes" || value === "hours" || value === "days") {
                          setUnit(value);
                        }
                        setError(null);
                      }}
                      value={unit}
                    >
                      <SelectTrigger className="min-w-0" id={`${id}-unit`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="minutes">Minutes</SelectItem>
                        <SelectItem value="hours">Hours</SelectItem>
                        <SelectItem value="days">Days</SelectItem>
                      </SelectPopup>
                    </Select>
                  </Label>
                </div>
              )}
            </div>
            {error === null ? null : (
              <p className="mt-3 text-destructive text-sm" role="alert">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button onClick={() => requests.finish(undefined)} type="button" variant="outline">
              Cancel
            </Button>
            <Button type="submit">Snooze</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
