// A usage window's pace (providers.md D1144, t3-parity.md D1309). Derived from T3 Code (MIT,
// see THIRD_PARTY_NOTICES.md) at eb7b35ac: apps/web/src/components/usage/UsageLimits.tsx
// (PACE, PaceIcon).
import { Tooltip, TooltipPopup, TooltipTrigger } from "@jhin/ui";
import { GaugeIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";

import type { LimitPace } from "./usage-limits.ts";

const PACE: Record<LimitPace, { readonly label: string; readonly icon: typeof GaugeIcon }> = {
  ahead: { label: "Ahead of pace: spending faster than the window elapses", icon: TrendingUpIcon },
  on: { label: "On pace with the window", icon: GaugeIcon },
  under: { label: "Under pace: headroom left for the rest of the window", icon: TrendingDownIcon },
};

export function PaceIcon({ pace }: { readonly pace: LimitPace }) {
  const Icon = PACE[pace].icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={PACE[pace].label}
            className="inline-flex text-muted-foreground"
            role="img"
          />
        }
      >
        <Icon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{PACE[pace].label}</TooltipPopup>
    </Tooltip>
  );
}
