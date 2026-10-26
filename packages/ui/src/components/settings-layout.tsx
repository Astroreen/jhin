// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/settings/settingsLayout.tsx
// and SettingsGroup.tsx. Public, so client plugins add settings that look like the rest (D514).
import { cn } from "../cn.ts";
import { Button } from "./button.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip.tsx";
import { Undo2Icon } from "lucide-react";
import type { ReactNode } from "react";

function SettingsGroup({
  className,
  divided = true,
  children,
}: {
  className?: string;
  divided?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative overflow-visible rounded-xl border border-border/60 bg-card/40 text-foreground shadow-xs/5",
        divided &&
          "[&>*+*]:border-t [&>*+*]:border-border/50 [&>[data-slot=settings-row]]:rounded-none",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SettingsSection(props: {
  title: string;
  icon?: ReactNode;
  headerAction?: ReactNode;
  id?: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={props.title} className="space-y-2.5" id={props.id}>
      <div className="flex min-h-7 items-start justify-between gap-4 px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-1">
          <h2 className="flex min-h-7 items-center gap-2 text-sm font-normal text-foreground/70">
            {props.icon}
            {props.title}
          </h2>
        </div>
        <div className="flex min-h-7 min-w-7 items-center justify-end">{props.headerAction}</div>
      </div>
      <SettingsGroup>{props.children}</SettingsGroup>
    </section>
  );
}

export function SettingsRow(props: {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  resetAction?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "@container/settings-row rounded-xl px-3 sm:px-4",
        props.children === undefined ? "py-3" : "pt-3 pb-1",
        props.className,
      )}
      data-slot="settings-row"
    >
      <div className="flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-8">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-sm font-medium text-foreground">{props.title}</h3>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
              {props.resetAction}
            </span>
          </div>
          {props.description === undefined ? null : (
            <p className="max-w-xl text-xs leading-normal text-muted-foreground/80">
              {props.description}
            </p>
          )}
          {props.status === undefined ? null : (
            <div className="pt-0.5 text-xs text-muted-foreground">{props.status}</div>
          )}
        </div>
        {props.control === undefined ? null : (
          <div className="flex w-full min-w-0 shrink-0 items-center gap-2 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:justify-end">
            {props.control}
          </div>
        )}
      </div>
      {props.children}
    </div>
  );
}

export function SettingResetButton({
  label,
  onClick,
  tooltip = "Reset to default",
}: {
  label: string;
  onClick(): void;
  /** T3's words for it: "Reset to inherited value" where a value is inherited. */
  tooltip?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            // "Reset <label> to default", or what the tooltip says it resets to.
            aria-label={tooltip.replace(/^Reset/, `Reset ${label}`)}
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
            size="icon-micro"
            variant="ghost-muted"
          />
        }
      >
        <Undo2Icon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export function SettingsEmpty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-12 text-center text-sm text-muted-foreground">{children}</div>;
}
