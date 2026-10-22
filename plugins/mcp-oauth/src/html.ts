// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/server/src/auth/mcpOAuthHtml.ts
// (the page shell and error page) and the wording of
// apps/web/src/components/auth/ConnectAgentSurface.tsx (the approval page).
// Rendered by the node itself, so a node without the web client approves too (security.md D1193).

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

const STYLES = `
  :root { color-scheme: light dark; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px 16px; background: #f6f7f9; color: #17191f; }
  main { width: min(100%, 440px); }
  h1 { margin: 0 0 8px; font-size: 20px; }
  p { margin: 0 0 12px; line-height: 1.5; color: #4b5060; }
  .eyebrow { font-size: 11px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: #3b5bdb; margin: 0 0 8px; }
  .note { font-size: 12px; }
  ul { list-style: none; margin: 0 0 16px; padding: 0; border: 1px solid #d9dce3; border-radius: 8px; }
  li { padding: 8px 12px; border-top: 1px solid #d9dce3; font-size: 13px; }
  li:first-child { border-top: 0; }
  li span { display: block; color: #4b5060; font-size: 12px; }
  code { font-size: 11px; color: #4b5060; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 0 0 6px; }
  input[type=text] { box-sizing: border-box; width: 100%; padding: 8px 10px; border: 1px solid #c4c8d2; border-radius: 6px; font: inherit; margin-bottom: 6px; }
  .actions { display: flex; gap: 8px; margin-top: 16px; }
  button { font: inherit; font-size: 13px; padding: 7px 14px; border-radius: 6px; border: 1px solid #c4c8d2; background: transparent; color: inherit; cursor: pointer; }
  button.primary { background: #3b5bdb; border-color: #3b5bdb; color: #fff; }
  [role=alert] { color: #c92a2a; font-size: 13px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #e6e8ee; }
    p, li span, code { color: #a0a6b4; }
    ul, li { border-color: #2a2e38; }
    input[type=text] { background: #171a21; border-color: #2a2e38; color: inherit; }
  }
`;

function shell(title: string, body: string, nonce?: string, script?: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>${escapeHtml(title)}</title>
    <style>${STYLES}</style>
  </head>
  <body>
    <main>${body}</main>${script === undefined || nonce === undefined ? "" : `\n    <script nonce="${nonce}">${script}</script>`}
  </body>
</html>`;
}

/** The page's security headers: nothing cached, framed, referred or run but the page's own script. */
export const pageHeaders = (nonce?: string): Record<string, string> => ({
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'${nonce === undefined ? "" : `; script-src 'nonce-${nonce}'; connect-src 'self'`}`,
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  // `same-origin`: the page's own form post carries its `Origin` (with
  // `no-referrer` Chromium sends `Origin: null`), and nothing leaks to the client.
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
});

export function renderErrorPage(description: string): string {
  return shell(
    "Sign-in failed",
    `<p class="eyebrow">Agent sign-in</p>
    <h1>This sign-in cannot continue</h1>
    <p>${escapeHtml(description)}</p>
    <p>Close this page and start the sign-in again from your agent.</p>`,
  );
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface ApprovalPage {
  readonly clientName: string;
  readonly redirectHost: string;
  readonly nodeHost: string;
  /** The request's own parameters, posted back with the decision. */
  readonly params: Readonly<Record<string, string>>;
  readonly permissions: readonly {
    readonly permission: string;
    readonly title?: string;
    readonly description?: string;
  }[];
  /** Set when the page's session may approve: its anti-forgery value. */
  readonly csrf?: string;
  /** Why the session cannot approve, when it has one. */
  readonly sessionProblem?: string;
  readonly nonce: string;
}

export function renderApprovalPage(page: ApprovalPage): string {
  const hidden = Object.entries(page.params)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`,
    )
    .join("");
  const redirectsHere = LOOPBACK.has(page.redirectHost.replace(/:\d+$/u, ""));
  const note = redirectsHere
    ? `The name is chosen by the agent. Approval returns to ${escapeHtml(page.redirectHost)} on the computer that opened this page. Only approve a sign-in you just started.`
    : `The name is chosen by the agent. Approval gives access to whoever runs <strong>${escapeHtml(page.redirectHost)}</strong>. Only approve a sign-in you just started there.`;
  const permissions = page.permissions
    .map(
      (entry) =>
        `<li>${escapeHtml(entry.title ?? entry.permission)}${
          entry.description === undefined ? "" : `<span>${escapeHtml(entry.description)}</span>`
        }${entry.title === undefined ? "" : `<code>${escapeHtml(entry.permission)}</code>`}</li>`,
    )
    .join("");
  const decide =
    page.csrf === undefined
      ? `${page.sessionProblem === undefined ? "" : `<p role="alert">${escapeHtml(page.sessionProblem)}</p>`}
    <form id="sign-in">
      <label for="pairing-code">Pairing code</label>
      <input id="pairing-code" type="text" autocomplete="one-time-code" autocapitalize="none" spellcheck="false" placeholder="Paste a one-time pairing code" />
      <p class="note">Create one in Settings → Authorized clients, or run <code>jhin pair</code> on this machine.</p>
      <p id="sign-in-error" role="alert"></p>
      <div class="actions"><button class="primary" type="submit">Continue</button></div>
    </form>
    <form method="post" action="/oauth/mcp/authorize">${hidden}
      <div class="actions"><button type="submit" name="decision" value="deny">Deny</button></div>
    </form>`
      : `<form method="post" action="/oauth/mcp/authorize">${hidden}
      <input type="hidden" name="csrf" value="${escapeHtml(page.csrf)}" />
      <div class="actions">
        <button class="primary" type="submit" name="decision" value="approve">Approve</button>
        <button type="submit" name="decision" value="deny">Deny</button>
      </div>
    </form>`;
  // Without a session, a pairing code opens one through the node's own
  // `POST /auth/session` (D421), then the page asks again with it.
  const script =
    page.csrf === undefined
      ? `document.getElementById("sign-in").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.getElementById("sign-in-error");
  error.textContent = "";
  const credential = document.getElementById("pairing-code").value.trim();
  if (credential === "") return;
  try {
    const response = await fetch("/auth/session", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential }) });
    if (response.ok) { location.reload(); return; }
    const body = await response.json().catch(() => ({}));
    error.textContent = body.message || "The code could not be checked. Try again.";
  } catch { error.textContent = "Could not reach this node. Try again."; }
});`
      : undefined;
  return shell(
    `Connect ${page.clientName}`,
    `<p class="eyebrow">Agent sign-in</p>
    <h1>Connect ${escapeHtml(page.clientName)}</h1>
    <p>This agent wants to use <strong>${escapeHtml(page.nodeHost)}</strong> with these permissions:</p>
    <ul aria-label="Permissions asked for">${permissions}</ul>
    <p class="note">${note}</p>
    ${decide}`,
    page.nonce,
    script,
  );
}
