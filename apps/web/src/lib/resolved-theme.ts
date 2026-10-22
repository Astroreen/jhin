import { useSyncExternalStore } from "react";

const subscribe = (listener: () => void) => {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
};

/** The app's colour mode, from the `dark` class the UI host puts on the document. */
export function useResolvedTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribe, () =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
}
