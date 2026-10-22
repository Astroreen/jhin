// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/threadNotifications.ts
// (setNotificationBadge).
import type { DesktopNotificationBadge } from "@jhin/desktop-api";

/**
 * The badge for `count` notifications. Windows has no badge count: the app
 * shows this drawn red badge as the taskbar overlay icon instead (D518).
 */
export function notificationBadge(count: number, platform: string): DesktopNotificationBadge {
  if (count === 0 || platform !== "win32") return { count, image: null };
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d");
  if (context === null) return { count, image: null };
  context.fillStyle = "#e5484d";
  context.beginPath();
  context.arc(32, 32, 28, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "white";
  context.font = `600 ${count > 9 ? 30 : 40}px "Segoe UI", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(count > 9 ? "9+" : String(count), 32, 34);
  return { count, image: canvas.toDataURL("image/png") };
}
