/**
 * Copies text: through the Clipboard API on a secure page, else through a
 * hidden field and the `copy` command, which pages served over plain HTTP
 * (a node on the LAN) still allow. Rejects when neither worked.
 */
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard !== undefined) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  try {
    // Deprecated, but the only way to copy where the Clipboard API is missing.
    if (!document.execCommand("copy")) throw new Error("The browser did not copy the text");
  } finally {
    field.remove();
  }
}
