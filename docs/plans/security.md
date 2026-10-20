# Security plan: pairing, remote access, scoped tokens, secrets

Status: **in progress** (workstream W13 of `t3-roadmap.md`, decisions
D410–D439).

## Goal

Today every client of a node holds the node's one owner token, which holds
every permission (`*`), and mesh members call each other with `*` too
(foundation D30, Deferred). This plan gives a node T3 Code's access model on
Jhin's plugins: devices pair with a node by QR code or one-time code and get
a token of their own, every token carries the permissions it was granted,
subscriptions and mesh calls are scoped like commands, secrets in config are
redacted, browsers are held to an `Origin` allowlist and the web client keeps
tokens out of `localStorage`. Remote access works without T3's hosted relay.
Pairing through a T3 account (T3 Connect) is out of scope.

The reference is T3 Code at D53 (`eb7b35ac`): `apps/server/src/auth/*`
(`EnvironmentAuth.ts`, `PairingGrantStore.ts`, `SessionStore.ts`, `http.ts`),
`apps/server/src/cli/pair.ts`, `apps/server/src/startupAccess.ts`,
`packages/contracts/src/auth.ts`, `packages/shared/src/qrCode.ts`,
`apps/web/src/components/settings/ConnectionsSettings.tsx` and
`apps/web/src/components/auth/PairingRouteSurface.tsx`.

## Decisions

### Permissions and scoped tokens

- **D410. A permission is a scope; a grant may be a pattern.** Jhin keeps
  its permissions (dotted ids that commands declare, D17) instead of T3's
  seventeen scope names: T3's scopes are a fixed list of its server's
  features, Jhin's come from whichever plugins a node runs. A grant is a
  permission (`git.read`), a namespace pattern (`git.*`: `git` itself and
  every permission under it, at any depth) or `*` (everything). One matcher,
  `holdsPermission(granted, required)` in `@jhin/sdk`, decides for every
  check: the kernel's command registry, `rpc.subscribe` and the mesh. A
  pattern is only allowed at the end (`a.*`, never `a.*.b`); a grant that is
  not a valid permission or pattern is refused where it is given.
- **D411. A device token is a node's token for one client.** Besides the
  owner token (D30, kept: the CLI and the MCP stdio wrapper read it from the
  home), `jhin.auth-token` issues device tokens. A device token is
  `jhd1.<id>.<secret>` (32 random bytes, base64url); the node keeps only its
  record: `id`, `label`, the granted `permissions`, how it was issued
  (`pairing` or `issued`), `createdAt`, `expiresAt` and the SHA-256 of the
  secret, in `clients.json` (mode 0600) in the plugin's data directory,
  written whole and renamed into place. Like T3's sessions it expires after
  30 days (`ttlDays`, `null` = never). T3 signs its session tokens and keeps
  a row for revocation; a lookup by id with a hashed secret needs no signing
  key and gives the same: revocable, never stored in clear. Its principal is
  `client:<id>`.
- **D412. Access commands, T3's operations.** `auth.tokens.issue
  {label, permissions, ttlDays?}` returns `{id, token, expiresAt}` once
  (T3's `t3 auth session issue`, "a scoped bearer access token for headless
  or remote clients"); `auth.clients.list` lists every device token without
  its secret and marks the caller's own (`current`); `auth.clients.revoke
  {id}` revokes one, never the caller's own
  (`CURRENT_CLIENT_REVOKE_NOT_ALLOWED`, T3's `current_session_revoke_not_allowed`);
  `auth.clients.revoke-others` revokes all but the caller's. A caller
  revokes only tokens whose grants it holds (D413), so a narrow token cannot
  revoke the owner's devices. A token lives at most 3650 days, or forever
  when issued with `ttlDays: null`. Reading needs
  `auth.read`, changing `auth.write` (T3's `access:read` / `access:write`);
  `auth.token.show` and `auth.token.rotate` keep `auth.admin`. A rotated
  owner token drops only the owner's connections, no longer every device's.
- **D413. A caller grants only what it holds.** Issuing a token (or, D420,
  a pairing code) with a permission the caller's grants do not cover fails
  with `PERMISSION_NOT_HELD` (T3: "the caller can only delegate scopes it
  already has"); a pattern is held only by a grant that covers all of it.
  `auth.permissions.list` returns every permission the node's commands need,
  with the commands that need each, plus `events.read` (D415), so a client
  offers them as checkboxes without a hard-coded list. Every first-party
  stream guard names a permission some command needs too (`threads.read`,
  `mesh.read`, `mesh.admin`, `git.read`, `terminals.read`), so the list has
  them; a plugin that guards a stream with a permission no command uses
  does not show in it (Deferred).
- **D414. Revoking takes effect at once; expiry too.** A revoked or expired
  device token is refused at the next connect, and its open connections are
  closed with 4401: the kernel event `auth.client.revoked {principal}` tells
  the transports, which close the connections of principal `client:<id>`.
  The MCP endpoint checks the token on every request, so it needs nothing
  more. `Principal` gains an optional
  `expiresAt` (additive, `auth.verifier@1.1`); the WebSocket transport
  closes a connection when its principal expires.

### Subscriptions and mesh calls

- **D415. Subscriptions to the event log need a permission.** `rpc.streams`
  1.1 adds `guard(name, permissions)`: a stream of the event log (or every
  stream under a prefix ending in `/`) needs these permissions (or what a
  function of the stream returns) to subscribe,
  checked like a live stream's (D141). A stream nobody guards needs
  `events.read`. First-party guards: `threads` and `thread/` need
  `threads.read`, `mirror/<owner>/<stream>` (copies of members' streams,
  D26) needs what the copied stream needs, `mesh` needs `mesh.read`, `mesh/outbox` needs
  `mesh.admin`, `source-control` needs `git.read`; terminal streams keep
  `terminals.read` (D141). A plugin guards its streams through the optional
  `rpc.streams@^1.1`. The owner's `*` holds them all, so nothing changes for
  it.
- **D416. Mesh calls carry the caller's scope.** `mesh.call` forwards the
  permissions of its caller (`scope`, `*` for in-process code) with the
  request; the target runs the command as `node:<origin>` with the
  intersection of that scope and what it grants members,
  `jhin.mesh.memberPermissions` (default `["*"]`: one owner's trust domain,
  D22). A scoped token that may call `mesh.call` therefore reaches other
  nodes with no more than it holds here. A forward without `scope` (a node
  older than this) runs with `memberPermissions`. The link protocol's own
  methods (`mesh.gossip`, `mesh.mirror`, foundation PR 10 notes) are
  unchanged. A `scope` that is not a list of grants holds nothing. An absent
  one is trusted to the member grants on purpose: members are one owner's
  nodes (D22), and a node that wants less from them narrows
  `memberPermissions`. The settings fan-out (`mesh.config.patch`, D20) is
  such a call: its changes are queued and delivered later, when the
  caller's grants are gone, so they run with the node's own authority; the
  command therefore needs `host.config.write` itself, besides `mesh.admin`.

### Secrets

- **D417. `host.config.get` redacts secrets.** Every value under a
  `writeOnly` field of a section's JSON Schema (config-ui D83) is replaced
  by T3's marker `••••••` (`SECRET_REDACTED`) in the effective value and in
  both layers; an unset secret stays absent. `host.config.patch` and
  `mesh.config.patch` treat the marker as "keep what is stored": by key, by
  position in a list. A marker where nothing is stored is refused
  (`CONFIG_SECRET_MISSING`). The settings page's `<hidden secret>`
  placeholder sends the marker, so a saved form keeps its secrets without
  ever receiving them. T3 keeps secrets in a secret store apart from the
  settings file; Jhin keeps them in the config files (D18) and redacts on
  the way out.

### Browsers

- **D418. An `Origin` allowlist on the WebSocket transport.** A WebSocket
  upgrade that carries an `Origin` is accepted when it is the node's own
  origin (the `Host` header, or `X-Forwarded-Host` from a
  `jhin.http.trustProxy` peer, T3's rule) or listed in
  `jhin.transport-ws.allowedOrigins`. A connection authenticated by the
  session cookie (D421) always needs that; one that presents a token in the
  subprotocol is accepted from any origin while the list is empty, so
  `jhin client` and other nodes' web clients still connect cross-origin
  (D21), and only from listed origins once the owner lists any. A refused
  upgrade gets 403 before the WebSocket opens. Requests without `Origin`
  (the CLI, nodes, MCP clients) are not browsers and are not checked.

### Pairing

- **D419. A pairing code is one-time, short-lived and scoped.**
  `auth.pairing.create {label?, permissions?, ttlMinutes?}` returns
  `{id, code, url, expiresAt}`: twelve characters of T3's alphabet
  `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, valid 5 minutes by default, used
  once. Its permissions default to every permission the creator holds (T3's
  standard scopes) and follow D413. Only the code's SHA-256 is kept (T3
  keeps it in clear). `auth.pairing.list` and `auth.pairing.revoke {id}`
  manage open codes; both need `auth.read` / `auth.write`.
- **D420. Pairing exchanges the code for a device token over HTTP.**
  `POST /auth/pair {code, label?}` (no token: the device has none yet)
  returns `{id, token, permissions, expiresAt}` with
  `cache-control: no-store`; the code's label wins over the device's, as in
  T3. It is rate limited per client address like `/mesh/join` and answers
  CORS without credentials, so a `jhin client` page pairs with a node on
  another origin.
- **D421. The page's own node uses an httpOnly session cookie.** As T3's
  primary environment: `POST /auth/session {credential}` takes a pairing
  code or a token, and answers with the cookie `jhin_session_<port>`
  (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` on HTTPS) holding a device
  token the page's scripts never see; `DELETE /auth/session` revokes it and
  clears the cookie. The WebSocket upgrade from the page then authenticates
  by the cookie, under D418's origin rule.
- **D422. The pairing URL is T3's: `<base>/pair#token=<CODE>`.** The code is
  in the fragment, so it never reaches a server log; the web client accepts
  `#token=` on any path, and also an owner or device token there (as
  before). Opening it on the node's own page exchanges the code for the
  session cookie (D421); in a `jhin client` page it pairs and saves the node
  (D423).

### Web client and CLI

- **D423. Tokens leave `localStorage`.** The web client keeps the tokens of
  other nodes in IndexedDB (`jhin.connections`), as T3 keeps saved remote
  environments; the page's own node needs no token (D421). Nodes saved in
  `localStorage` (`jhin.nodes`) move to IndexedDB once and the old key is
  removed. IndexedDB is still readable by scripts of the page's origin,
  including user client plugins; the session cookie is not.
- **D424. Settings: "Authorized clients", T3's wording.** A settings page
  lists device tokens and open pairing links ("Authorized clients",
  "Connected", "Not connected yet.", "Granted scopes", "Revoke", "Revoke
  others", "No pairing links or client sessions."). "Create link" opens
  "Create pairing link" ("Generate a one-time link that another device can
  use to pair with this backend as an authorized client.", "Client label
  (optional)", placeholder "e.g. Living room iPad", "Permissions", "Limit
  what the paired client can do.", "Select at least one permission.") and
  shows the QR code ("Pairing link — scan to open on another device") with
  "Reach this machine via" over the node's addresses. The QR encoder is a
  port of T3's `packages/shared/src/qrCode.ts`. The "Add node" form accepts
  a pairing code or pairing URL instead of a token ("Pairing code",
  placeholder "PAIRCODE").
- **D425. `jhin pair` prints a pairing link and its QR code.** As `t3 pair`:
  `--label` (default `jhin pair`), `--ttl` (minutes, default 5),
  repeatable `--permission`; it prints "Pairing with <label> (<origin>).",
  the QR code in half-block characters, `Pairing URL:`, `Code:` and
  `Expires:`, and, when the node only listens on loopback, T3's note "This
  URL is only reachable from this machine." with the setting that changes
  it.

### Remote access

- **D426. Remote access without a relay is the node's own address.** A node
  is reached directly: `jhin.http.host` binds it (`127.0.0.1` by default,
  `0.0.0.0` or a Tailnet address for others), a reverse proxy may sit in
  front (`jhin.http.trustProxy`), and pairing links use the node's
  advertised URLs (`jhin.mesh.advertise`) or its listening address. T3's
  hosted relay and T3 Connect are not ported.

## PR plan

A stack, each layer branched from the one before.

### PR 1 — Scoped tokens and permissions

Implements D410–D416.

- `holdsPermission` and `intersectPermissions` in `@jhin/sdk`; the kernel
  and `@jhin/rpc` use them.
- `rpc.streams@1.1` `guard`; first-party guards; `events.read`.
- Device tokens in `jhin.auth-token`: `auth.tokens.issue`,
  `auth.clients.*`, `auth.permissions.list`, revocation and expiry closing
  connections.
- Scoped mesh calls, `jhin.mesh.memberPermissions`.
- **Done when:** tests show a token with `threads.read` reading threads
  and refused `threads.send`, `git.*` covering `git.read`, a subscription
  to an unguarded stream refused without `events.read`, a revoked token's
  open connection closed with 4401, a token unable to grant more than it
  holds, and a scoped `mesh.call` refused on the target.

### PR 2 — Secrets in config

Implements D417. **Done when:** `host.config.get` never returns a
`writeOnly` value, and saving the settings form unchanged keeps it.

### PR 3 — `Origin` allowlist

Implements D418. **Done when:** an upgrade from a foreign origin is refused
with 403 when the list names others, and accepted from the node's own page
and from listed origins.

### PR 4 — Pairing

Implements D419–D425. **Done when:** Playwright pairs a second browser
context with a node by its pairing URL, the page's token is not readable by
scripts, revoking the client disconnects it, and `jhin pair` prints the link
and QR code.

## Deferred

- Secrets stay in the config files in clear (D417): T3 keeps them in a
  secret store apart from its settings. A key store (the OS keychain, an
  encrypted file) would let a config file be shared without them.
- A fan-out (`mesh.config.patch`) that carries a marker resolves it on each
  target against that node's own stored value; a target with none refuses
  the change (`CONFIG_SECRET_MISSING`), recorded as `mesh.config.failed`.

- T3 Connect: pairing and remote access through a T3 account, the hosted
  relay and the hosted-app pairing link (out of scope, `t3-roadmap.md`).
- Tailscale Serve (`--tailscale-serve`, `t3 pair --tailscale`): publishing
  the node over Tailscale HTTPS is not done by the node itself.
- DPoP-bound tokens and T3's WebSocket tickets: a device token is a bearer
  token.
- MCP OAuth (T3's `/oauth/mcp/*`): MCP clients use the owner token or an
  issued device token.
- Live updates of the list of authorized clients (T3 streams
  `clientUpserted` / `clientRemoved`): `jhin.auth-token` cannot guard a
  stream of its own through `rpc.streams`, because the transport that
  provides it depends on `auth.verifier` (an optional edge that closes a
  cycle is dropped, D14). The settings page reads the list again after its
  own changes.
- `auth.permissions.list` reads commands only: a stream guarded with a
  permission no command needs is not offered (the token plugin cannot see
  `rpc.streams`, as above).
- An unreadable `clients.json` is moved aside to `clients.json.corrupt` and
  no device token works until new ones are issued; nothing repairs it.
- `lastSeenAt` is kept in memory and written with the next change of
  `clients.json`, so a restart may lose the latest ones. Expired tokens are
  dropped from the file with the next write.
- Titles for permissions in the UI (T3's "View terminals", "Use
  terminals", …): the permission list shows ids grouped by namespace.
