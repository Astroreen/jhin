// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/ContextChip.tsx
// and the shell and popover of apps/web/src/components/contextChipParts.tsx at eb7b35ac.
//
// A context chip: a file, skill, pull request, thread or terminal excerpt shown inline, in the
// composer and in a message, tinted by its kind (t3-parity.md D1002).
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import type { ReactNode } from "react";

import { cn } from "../cn.ts";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "./popover.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip.tsx";

const ACCENTED_KINDS = [
  "image",
  "video",
  "file",
  "mention",
  "terminal",
  "element",
  "preview-annotation",
  "review-comment",
  "pull-request",
  "pr-open",
  "pr-draft",
  "pr-merged",
  "pr-closed",
  "skill",
  "thread",
  "citation",
] as const;

const contextChipVariants = cva(
  "inline-flex h-[1.41em] max-w-full items-center gap-[0.33em] rounded-[0.5em] border px-[0.5em] align-middle font-medium text-[0.86em] leading-none [&_svg]:block [&_svg]:size-[1.17em] [&_svg]:shrink-0 [&_svg]:self-center [button&,a&,[data-popup-open]&]:cursor-pointer [button&,a&]:transition-colors [button&,a&]:motion-reduce:transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground disabled:cursor-default",
  {
    defaultVariants: { kind: "neutral" },
    variants: {
      kind: {
        neutral: "border-border/70 bg-accent/40 text-foreground",
        image: "[--context-chip-accent:oklch(0.62_0.16_16)]",
        video: "[--context-chip-accent:oklch(0.62_0.16_48)]",
        file: "[--context-chip-accent:oklch(0.62_0.136_237)]",
        mention: "[--context-chip-accent:oklch(0.62_0.11_215)]",
        terminal: "[--context-chip-accent:oklch(0.62_0.134_163)]",
        element: "[--context-chip-accent:oklch(0.62_0.134_70)]",
        "preview-annotation": "[--context-chip-accent:oklch(0.62_0.134_70)]",
        "review-comment": "[--context-chip-accent:oklch(0.62_0.16_292)]",
        "pull-request": "[--context-chip-accent:oklch(0.62_0.16_277)]",
        "pr-open": "[--context-chip-accent:oklch(0.62_0.134_163)]",
        "pr-draft": "[--context-chip-accent:oklch(0.62_0.02_259)]",
        "pr-merged": "[--context-chip-accent:oklch(0.62_0.16_292)]",
        "pr-closed": "[--context-chip-accent:oklch(0.62_0.16_16)]",
        skill: "[--context-chip-accent:oklch(0.62_0.16_322)]",
        thread: "[--context-chip-accent:oklch(0.62_0.12_190)]",
        citation: "[--context-chip-accent:oklch(0.62_0.16_259)]",
      },
      state: {
        unresolved: "border-dashed",
        invalid: "",
      },
    },
    compoundVariants: [
      {
        kind: [...ACCENTED_KINDS],
        className:
          "[--context-chip-border:color-mix(in_oklab,var(--context-chip-accent)_34%,var(--contrast-border))] [--context-chip-border-hover:color-mix(in_oklab,var(--context-chip-accent)_48%,var(--contrast-border))] [--context-chip-foreground:color-mix(in_oklab,var(--context-chip-accent)_22%,var(--contrast-foreground))] border-(--context-chip-border) bg-(--context-chip-accent)/11 text-(--context-chip-foreground) [button:enabled&,a&]:hover:border-(--context-chip-border-hover) [button:enabled&,a&]:hover:bg-(--context-chip-accent)/17",
      },
      { state: "unresolved", className: "text-foreground" },
      { state: "invalid", className: "border-destructive/35 bg-destructive/8 text-destructive" },
    ],
  },
);

type ContextChipKind = NonNullable<VariantProps<typeof contextChipVariants>["kind"]>;

interface ContextChipProps extends useRender.ComponentProps<"span"> {
  kind?: ContextChipKind;
  state?: "unresolved" | "invalid";
}

function ContextChip({ className, kind, state, render, ...props }: ContextChipProps) {
  const defaultProps = {
    className: cn(contextChipVariants({ kind, state }), className),
    "data-slot": "context-chip",
    "data-state": state,
  };
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}

function ContextChipLabel({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("block min-w-0 self-center truncate leading-tight", className)}
      data-slot="context-chip-label"
      {...props}
    />
  );
}

/** A chip with an icon and a label, and its details in a tooltip when it has any. */
function ContextChipShell({
  icon,
  label,
  tooltip,
  ...props
}: Omit<ContextChipProps, "className" | "render"> & {
  icon: ReactNode;
  label: string;
  tooltip?: ReactNode;
}) {
  const chip = (
    <ContextChip
      data-context-unresolved={props.state === "unresolved" ? "true" : undefined}
      tabIndex={tooltip ? 0 : undefined}
      {...props}
    >
      {icon}
      <ContextChipLabel>{label}</ContextChipLabel>
    </ContextChip>
  );
  if (!tooltip) return chip;
  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup side="top" className="whitespace-pre-wrap">
        {tooltip}
      </TooltipPopup>
    </Tooltip>
  );
}

/** A chip that is a button: pressed, it shows its details in a popover above it. */
function ContextChipPopover(props: {
  kind: ContextChipKind;
  icon: ReactNode;
  label: string;
  accessibleLabel: string;
  copyMarkdown?: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <ContextChip
            kind={props.kind}
            render={<button type="button" />}
            aria-label={`${props.accessibleLabel}. Show details`}
            data-markdown-copy={props.copyMarkdown}
          />
        }
      >
        {props.icon}
        <ContextChipLabel>{props.label}</ContextChipLabel>
      </PopoverTrigger>
      <PopoverPopup side="top" width="lg" padding="compact">
        <PopoverTitle className="sr-only">{props.accessibleLabel}</PopoverTitle>
        {props.children}
      </PopoverPopup>
    </Popover>
  );
}

export {
  ContextChip,
  ContextChipLabel,
  ContextChipPopover,
  ContextChipShell,
  contextChipVariants,
  type ContextChipKind,
};
