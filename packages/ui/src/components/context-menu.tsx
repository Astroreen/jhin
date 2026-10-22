// Styled like T3 Code's menu popup (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/ui/menu.tsx.
// T3 Code shows context menus natively or through a DOM fallback; Jhin uses Base UI's ContextMenu.
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";

import { cn } from "../cn.ts";

const ContextMenu = ContextMenuPrimitive.Root;

function ContextMenuTrigger(props: ContextMenuPrimitive.Trigger.Props) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

/** The menu at the pointer; its items are the regular `MenuItem`, `MenuSeparator`, … */
function ContextMenuPopup({ children, className, ...props }: ContextMenuPrimitive.Popup.Props) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="z-[130]" data-slot="menu-positioner">
        <ContextMenuPrimitive.Popup
          className={cn(
            "dropdown-glass relative flex origin-(--transform-origin) rounded-lg shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] outline-none focus:outline-none dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]",
            "min-w-[min(10rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)]",
            className,
          )}
          data-slot="menu-popup"
          {...props}
        >
          <div className="max-h-(--available-height) w-full overflow-y-auto p-1">{children}</div>
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

export { ContextMenu, ContextMenuPopup, ContextMenuTrigger };
