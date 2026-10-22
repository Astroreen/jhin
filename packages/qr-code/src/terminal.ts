// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): renderTerminalQrCode in
// apps/server/src/startupAccess.ts.
import { QrCode } from "./qr-code.ts";

/**
 * `value` as a QR code in half-block characters, two modules a character
 * (security.md D1185): `margin` light modules around it, error correction medium.
 */
export function renderTerminalQrCode(value: string, margin = 2): string {
  const qrCode = QrCode.encodeText(value, QrCode.Ecc.MEDIUM);
  const rows: string[] = [];
  const isDark = (x: number, y: number): boolean =>
    x >= 0 && x < qrCode.size && y >= 0 && y < qrCode.size && qrCode.getModule(x, y);

  for (let y = -margin; y < qrCode.size + margin; y += 2) {
    let row = "";
    for (let x = -margin; x < qrCode.size + margin; x += 1) {
      const topDark = isDark(x, y);
      const bottomDark = isDark(x, y + 1);
      row += topDark ? (bottomDark ? "█" : "▀") : bottomDark ? "▄" : " ";
    }
    rows.push(row);
  }
  return rows.join("\n");
}
