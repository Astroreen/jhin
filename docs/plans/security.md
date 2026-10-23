# Security plan: pairing, remote access, scoped tokens, secrets

Status: **implemented** (workstream W13 of `t3-roadmap.md`, decisions
D410–D426): PR 1 #48, PR 2 #52, PR 3 #57, PR 4a #65, PR 4b #72. The
secret store and `secretRef`s (W28, D1021–D1034): #173, #178, #180.
Pairing and remote access (W33, D1181–D1196): `jhin pair` #203, Tailscale
Serve #204, clients and `jhin client` links #208, MCP OAuth #214. What is
left is under Deferred.

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
  both layers; an unset secret stays absent. Inside a list the marker names
  its secret's place as a JSON Pointer (`••••••#/keys/1`), so a reordered
  or shortened list keeps each secret; `isRedactedSecret`
  (`@jhin/host-api`) tells either form. The walk follows `$ref` (with the keywords beside it), unions and
  intersections, `if`/`then`/`else`, `dependentSchemas`, tuples
  (`prefixItems`), `items`, `contains`, `properties`, `patternProperties`,
  `additionalProperties` and `unevaluatedProperties`. What no schema
  describes is unknown and redacted like a secret (a field that takes
  anything, `{}` as `z.unknown()` gives, holds data and is shown): every scalar of a
  section no plugin defines, a key the section's schema does not name (a
  typo in a file), an item of a list without `items`.

  `host.config.patch` and `mesh.config.patch` treat the marker as "keep
  what is stored", only where the schema has a secret (elsewhere the marker
  is a value like any other): a plain marker by its own key, an addressed
  one at its address, which must name a secret; inside a list only an
  addressed marker is taken, a plain one is refused; always from the layer
  being changed, by own keys only. A secret only another layer (or a
  default) holds is never copied into this one: its key is left out of the
  change, and the other layer keeps providing it. A marker no layer has a
  value for, or a list item only another layer holds, is refused
  (`CONFIG_SECRET_MISSING`).

  An invalid section reports `Config section <s> is invalid` with its
  issues: an issue about a secret says only that it is not valid, and the
  others have every secret's text replaced by the marker, since a
  refinement may quote it (a secret under 4 characters where it stands as
  a word; hiding a few extra characters is safe). Other errors (a section no
  plugin defines) are reported as they are.

  The settings page's `<hidden secret>` placeholder sends the marker, so a
  saved form keeps its secrets without ever receiving them. T3 keeps
  secrets in a secret store apart from the settings file; Jhin keeps them
  in the config files (D18) and redacts on the way out.

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
  (the CLI, nodes, MCP clients) are not browsers and are not checked. An
  `Origin` that is no URL (`null`, from a sandboxed frame or a `file:` page)
  is always refused. The host the client asked for comes from
  `http.server` 1.2's `requestedHost`, so a node behind a reverse proxy
  compares with the proxy's host.

### Pairing

- **D419. A pairing code is one-time, short-lived and scoped.**
  `auth.pairing.create {label?, permissions?, ttlMinutes?, baseUrl?}`
  (`ttlMinutes` at most 1440; `baseUrl`, where the device reaches the node,
  defaults to its HTTP address) returns
  `{id, code, url, expiresAt}`: twelve characters of T3's alphabet
  `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, valid 5 minutes by default, used
  once. Its permissions default to every permission the creator holds (T3's
  standard scopes) and follow D413. Only the code's SHA-256 is kept (T3
  keeps it in clear). `auth.pairing.list` and `auth.pairing.revoke {id}`
  manage open codes; both need `auth.read` / `auth.write`.
  Open codes live in the plugin's kernel-scoped state: they outlive a
  reload of `jhin.auth-token`, not a restart of the node.
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
  clears the cookie; `GET /auth/session` tells the page whether it has one.
  `POST`/`DELETE` are refused (403) from any page but the node's own. The
  WebSocket upgrade from the page then authenticates by the cookie when no
  token is offered, and such an upgrade needs the node's own or a listed
  origin even while the list is empty (D418). The endpoints need
  `http.server@^1.2`, optional for `jhin.auth-token`; without it the pairing
  commands still create codes, with no `url`. A token traded for the
  session gives an `issued` token that never outlives it and is revoked with
  it (a rotated owner token ends the sessions it opened). Each endpoint has
  its own rate-limit bucket per client address, counting failed attempts
  only, in fixed clock minutes (behind a proxy, set
  `jhin.http.trustProxy` so clients are told apart).
- **D422. The pairing URL is T3's: `<base>/pair#token=<CODE>`.** The code is
  in the fragment, so it never reaches a server log; the web client accepts
  `#token=` on any path, and also an owner or device token there (as
  before). A page that already holds a session keeps it when opened with a
  token again (no second device token per reload); to act as another token,
  forget the node first, which signs the page out. A pairing code always
  pairs. The page's node is found under the page's base path (`/jhin/`
  behind a proxy path), for `/rpc` and `/auth/session` alike. The saved
  nodes are one list in IndexedDB: two tabs saving at the same instant keep
  the later list. Opening it on the node's own page exchanges the code for the
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
  port of T3's `packages/shared/src/qrCode.ts` (Project Nayuki's encoder),
  in `apps/web/src/lib/qr-code.ts`. The connect form ("Connect a node")
  takes a pairing link in "Node URL", or a pairing code or token in
  "Pairing code or token" (placeholder "PAIRCODE"); a code pairs over
  `POST /auth/pair` (`client.connections` 1.2 `pair`). A page opened with a
  refused code says why ("… Request a new pairing link."). Reopening the
  node's page with the same `#token=` keeps its session instead of issuing
  another device token. A `jhin client` page, served by no node, keeps a
  `#token=` token in IndexedDB as before; a pairing link must be opened on
  the node's own address or pasted into the connect form.
- **D425. `jhin pair` prints a pairing link and its QR code** (done in
  W33, D1185, which details it). As `t3 pair`:
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

### Leftovers (W26)

- **D961. A permission has a title and a description, from the plugin that
  needs it.** As T3's scope options ("View terminals", "Read existing
  terminal output and status."). `auth.permissions.list` runs its answer
  through the hook `auth.permissions.describe` (`PERMISSIONS_DESCRIBE_HOOK`
  in `@jhin/sdk`); a plugin adds the titles of the permissions its commands
  need with `describePermissions(context, { "terminals.read": { title,
  description } })`, an `after` hook that returns a disposable. One plugin
  describes a permission: the one whose commands own it (`preview.write` is
  `jhin.preview`'s). A permission nobody describes keeps its id as its
  title. A hook that throws is logged and the list is answered without any
  titles (every plugin's, a trade-off kept for a simple pipeline), so one
  plugin cannot keep a client from granting permissions.
  T3's wording is kept where a permission matches a T3 scope; the rest
  follows it. The pairing dialog shows a title with its description and the
  id, as T3's list. A client's granted scopes stay ids: they may be patterns
  (`git.*`, `*`).

### Secret store and `secretRef` (W28)

The reference is T3 Code at D53 (`eb7b35ac`):
`apps/server/src/auth/ServerSecretStore.ts`,
`apps/server/src/secrets/SecretRequests.ts`,
`packages/contracts/src/secretRequest.ts`, `request_secret` in
`apps/server/src/mcp/OrchestratorMcpService.ts`,
`packages/client-runtime/src/secretRequest.ts` and
`apps/web/src/components/chat/SecretRequestCard.tsx`.

- **D1021. What the store protects, and from whom.** A secret is a value a
  person types once and Jhin uses many times: an API key in a config
  section's `writeOnly` field (D417), a webhook's signing secret. What it
  promises: a secret's value never enters a config file, a thread's events
  (its transcript), the node's logs, kernel events, an RPC or MCP response,
  or an agent's context; it never leaves the node that keeps it except
  where its owner types it (from the device to that node, over the
  device's authenticated connection, and through a mesh relay when the
  thread lives on a member). So a config file can be shared, committed,
  synced to other nodes (D20) or pasted into a bug report without its
  secrets. What it does not promise: a thread's agent runs commands as the
  node's OS user, and nothing keeps a value from code running as that user
  (it can read the key file, or ask the keychain the way the node does). A
  plugin of the node receives a value through the capability (D1022) and
  must keep it the same way; a secret a plugin keeps elsewhere (the
  scheduler's signing secrets in `storage.kv`, D386) is outside the store.
- **D1022. `jhin.secrets` provides `secrets.store@1`.** Its contract is
  `@jhin/secrets-api`. Other code depends on the capability, never on the
  plugin. Every operation is a command except the two that hand out a
  value: resolving a config secret (D1025) and consuming a `secretRef`
  (D1031) are methods of the capability only, so a value is reachable from
  the node's own code and from no RPC, CLI or MCP caller. That is the one
  place rule 6 gives way: a command whose output is a secret is the leak.
  `secrets.status` (`secrets.read`) tells where the store keeps its key, how
  many config secrets and open `secretRef`s it holds, and whether it could
  be read; never a value or a name.
- **D1023. One encrypted file.** The store is `store.json` in the plugin's
  data directory (directory 0700, file 0600, written whole and renamed into
  place): `{ version: 1, key: "keychain" | "file", iv, tag, data }`, the
  entries as JSON sealed with AES-256-GCM under a 32-byte random key. The
  key sits in the OS keychain where the node finds one (D1024), else in
  `store.key` (0600) beside the store. The file records where its key is,
  so a store keeps its key where it was made. A store that cannot be
  opened (its key is gone, the file is damaged) is left as it is and
  reported (`secrets.status`: `unreadable`): nothing resolves and every
  write fails with `SECRET_STORE_UNREADABLE`, so nothing is overwritten
  and nothing falls back to clear text. T3 keeps one file per secret,
  0600, unencrypted; the key file gives the same protection against a
  local user, the keychain more, and either keeps the store opaque where it
  is copied without its key.
- **D1024. The keychain, where there is one.** macOS: `security`
  (`add-generic-password -U`, `find-generic-password -w`), the key passed on
  standard input of `security -i`, never on a command line. Linux:
  `secret-tool` (libsecret) when it is installed and a D-Bus session bus is
  set, the key on standard input. The item is service `Jhin`, account
  `jhin.secrets:<nodeId>`, so the nodes of one machine keep keys apart.
  Elsewhere, and with `jhin.secrets.keychain: "off"`, the key file.
- **D1025. A config secret is a reference in the file.** Where a config
  file held a secret it holds `"$secret:<32 hex>"`. The host resolves each
  reference through `secrets.store@1` before it applies the layer
  (`kernel.config.setLayer`), so plugins read the value as before. A
  reference is bound to where it was made: its section and its path inside
  the section (list positions as `*`); at another place it does not
  resolve, so a reference moved into a field that is not secret cannot show
  its value. A reference that does not resolve (another machine's, a
  deleted one, a store not yet active) is left out of the layer, as if the
  key were not there, and logged with its section and path. When the store
  becomes active the host applies both layers again, and plugins see the
  values through `config.onChange`. Strings only: a secret number or
  boolean stays in clear.
- **D1026. Saving moves secrets out of the file.** `host.config.patch` and
  `host.config.edit` (so the settings page and `mesh.config.patch`) put
  every string at a secret place (D417's walk) of the section they change
  into the store and write its reference. The marker still keeps what is
  stored (D417): the reference, not the value. A reference the change
  removes from a file is deleted from the store unless the other layer's
  file still names it. Without the store the change is written as before,
  in clear. `host.config.get` redacts as before, and scrubs messages of the
  resolved values.
- **D1027. Existing configs keep working; moving them is one command.** A
  secret in clear in a file is read as before. A save of its section moves
  it (D1026); `host.config.secrets.migrate {layer?}` (`host.config.write`)
  moves every one of the node and project files at once and returns where
  they were (`{ layer, section, path }`), never what. The node does not
  rewrite files on its own at start.
- **D1028. A private prompt for a secret: `secrets.request`.** T3's
  `request_secret`, as the tool `secrets_request`: `{ label, reason,
  placeholder?, timeoutMs?, clientRequestId?, threadId? }` (the thread
  defaults to the calling agent's, `Invocation.threadId`; an agent asks in
  its own thread only, `SECRET_REQUEST_OTHER_THREAD`). It needs a
  running turn in the thread (else `SECRET_REQUEST_NO_TURN`, T3's
  `parent_not_active`), appends `secrets.request.opened {requestId,
  turnId, label, reason, placeholder?}` to the thread and waits: for the
  answer, for the turn to end, or `timeoutMs` (1 s to 1 h, 10 minutes by
  default). It answers T3's union: `{ status: "saved", secretRef }` or
  `{ status: "declined" | "cancelled" | "timed_out" }`, and appends
  `secrets.request.closed {requestId, status}` (`saved`, `declined`,
  `cancelled`; a timeout closes as `cancelled`, as T3's card). A
  `clientRequestId` asked again while its request waits joins that wait,
  and after it returns that answer again (the same one-use `secretRef`;
  the answers are kept in memory, the last 200).
  Open requests are kept in `storage.kv` too, so a node that restarts closes
  the ones it left open as `cancelled`. It needs `threads.write`, which a
  thread's agent holds.
- **D1029. The answer goes to the store, not the thread.**
  `secrets.requests.answer {threadId, requestId, answer}` with `answer`
  `{ type: "save", secret }` (trimmed, not empty) or `{ type: "decline" }`
  stores the value under a new `secretRef` and only then closes the
  request; it returns `{ status }`. It needs `secrets.write`, which agents
  do not hold, so an agent cannot answer its own request. T3's failures and
  messages: `SECRET_REQUEST_NOT_FOUND` ("This secret request no longer
  exists."), `SECRET_REQUEST_ANSWERED` ("This secret request was already
  answered."): a request whose turn ended is closed, so it is answered
  already. `SECRET_REQUEST_AGENT_STOPPED`, which the first W28 PR (#173)
  listed, is withdrawn before any release or consumer used it. A value is
  at most 16 KiB. An input that fails validation
  is reported without the value.
- **D1030. A `secretRef` is one-use, bound and short-lived.**
  `secret-ref:<32 hex>`, random. It holds the value with the thread's
  project and the time it was saved; it works once, for that project, for
  24 hours (T3's `SECRET_REF_TTL_MS`). Expired ones are removed when the
  store opens and every hour after.
- **D1031. Consuming a `secretRef`** is `consumeRef({ ref, projectId })` of
  `secrets.store@1`: it removes the entry and returns the value, or fails
  with T3's reasons: `SECRET_REF_INVALID` ("That secretRef is not
  valid."), `SECRET_REF_UNAVAILABLE` ("That secretRef was already used or
  does not exist. Ask the user again with secrets_request."; also for
  another project), `SECRET_REF_EXPIRED` ("That secretRef expired. Ask the
  user again with secrets_request."). A value that could not be removed is
  not handed out. Consumers name the field that takes one `secretRef`, next
  to the field that takes the value (D1034).
- **D1032. The card, T3's `SecretRequestCard`.** The web client's builtin
  `jhin.secrets-view` contributes `jhin.secrets.request` to
  `chat.turn.item`: for `secrets.request.opened` a form with the label,
  the reason, a masked text field (not a password field, so browsers do
  not offer to save it; password managers told to ignore it), "Save
  securely", "Decline" and T3's note "Stored securely, never shown to the
  agent"; once closed, a work log row "<label> · Saved securely and kept
  private" / "Declined" / "Request ended". It follows the thread's stream
  after its event for the close, and shows a failure's message only when
  the node gave one of D1029's codes ("Could not answer the request. Try
  again." otherwise), so a typed value never reaches the page's errors.
- **D1033. Proof: the value is looked for everywhere.** Tests answer a
  request and save a config secret with a recognisable value, then search
  the thread's events, the node's log file, every kernel event, every
  command response of the exchange (over RPC; an MCP tool returns the same
  output), `host.config.get`, and the config
  files, and find it in none; only `store.json` holds it, sealed.

### Pairing and remote access (W33)

The reference is T3 Code at D53 (`eb7b35ac`): `apps/server/src/cli/pair.ts`,
`apps/server/src/startupAccess.ts`, `packages/tailscale/src/*`,
`apps/server/src/auth/utils.ts` (`deriveAuthClientMetadata`),
`apps/web/src/hostedPairing.ts`, `apps/server/src/auth/McpOAuth.ts`,
`mcpOAuthHttp.ts` and `mcpOAuthHtml.ts`. T3 Connect stays out of scope.

The threat model comes first; the decisions after it implement it.

- **D1181. Who pairing defends against.** What is protected: the owner
  token (every permission), device tokens and open pairing codes. Who is
  kept out: (1) someone who sees the owner's screen, terminal scrollback or
  a photo of a QR code; (2) someone on the network path between a device and
  the node; (3) a web page in the owner's browser (CSRF and DNS rebinding,
  D418, D421); (4) an MCP client or device the owner authorized, kept to
  what it was granted (D413); (5) another user of the node's machine, kept
  out of the home by file modes (`0600`). Not defended: someone who controls
  the node's machine or the owner's account on it, who reads the owner token
  from the home anyway. A node listening beyond loopback without TLS sends
  every token in clear: a device on such a network is reached through
  Tailscale Serve (D1189) or a TLS proxy (D426), and the pairing output says
  when a link is plain HTTP to another machine (D1185).
- **D1182. A pairing code: short-lived, used once, worth guessing never.**
  D419 stands: twelve characters of a 32-character alphabet (60 bits), 5
  minutes by default and at most 24 hours, one use (redeemed and spent in
  one synchronous step, so two devices racing get one token), kept only as
  its SHA-256, and ended with the token that created it. Guessing is bounded
  by the failed-attempt limit per client address on `/auth/pair` and
  `/auth/session` (D420, D421): at most a few hundred guesses a minute
  against 2⁶⁰ codes. The code never reaches a log: the node logs the link's
  id, `jhin pair` prints it only to its own standard output. Whoever holds
  the code during its life pairs once with the code's grants; afterwards
  the code is worth nothing, and the device it made is listed with its
  label (and D1187's metadata) and revoked with "Revoke".
- **D1183. What a QR code shows.** Exactly the pairing URL: the node's base
  address (host or MagicDNS name, port, path) and the code in the fragment
  (`#token=`, D422), so it never reaches a server's access log. It carries
  no owner token, node id or permission list. A photo of it is a pairing
  code (D1182) plus the node's address; the address stays known after the
  code is spent. The code defaults to every grant of its creator (D419), so a
  code made by the owner pairs a device equal to the owner: `jhin pair
  --permission` narrows it, and `--ttl` shortens it.
- **D1184. A running node says where it listens.** `jhin.http` writes
  `runtime.json` (`{url, pid, instance, startedAt}`, mode `0600`, written
  whole and renamed into place) in its data directory once it listens, and
  removes it when it stops. `instance` is 16 random bytes made at each
  start; `GET /.well-known/jhin` answers `{instance}` with no token, so a
  client can tell this node from another listener on the same address
  (D1189) without learning anything lasting about it. The file holds no
  token. A CLI command that needs the running node and has no `--url` reads
  it, ignores it when its process is gone (a dead node's file, its port
  maybe reused) and when the address does not answer with the same
  `instance`.
- **D1185. `jhin pair`, T3's `t3 pair`.** It finds the running node (D1184,
  or `--url` and `--token` as every remote command), calls
  `auth.pairing.create` with the home's owner token (reading it needs the
  home already) and prints T3's block: "Pairing with <host name>
  (<origin>).", the QR code in half-block characters (T3's
  `renderTerminalQrCode`: margin 2, error correction medium), `Pairing URL:`,
  `Code:`, `Expires:` (ISO time) and notes. Options: `--label` (default
  `jhin pair`), `--ttl` (minutes, default 5), repeatable `--permission`,
  `--base-url` (the address devices reach the node by), `--tailscale` and
  `--tailscale-serve-port` (D1189), `--json` (the command's output as JSON
  instead of the block). Notes, T3's wording where it has one: a loopback
  link gets "This URL is only reachable from this machine. Set
  jhin.http.host to an address other devices reach and restart the node."
  (with D1189: "Re-run with --tailscale, or set …", T3's); a plain `http:` link to another machine gets "This URL
  is plain HTTP: anyone on the network path can read the pairing code and
  the token it becomes. Prefer --tailscale or an HTTPS proxy.". No running
  node: "No running Jhin node found." with the paths it checked and "Start
  one with `jhin serve`.".
- **D1186. The QR encoder is a package, `@jhin/qr-code`.** T3's
  `packages/shared/src/qrCode.ts` (Project Nayuki's encoder) moves from the
  web client into an isomorphic package with no dependencies, next to
  `renderTerminalQrCode`; the web client's SVG and the CLI both import it.

### Clients and links (W33)

- **D1187. A paired device's metadata, T3's.** When a code is redeemed or a
  page session opened (D420, D421), the node records T3's
  `deriveAuthClientMetadata` of the request: device type (`desktop`,
  `mobile`, `tablet`, `bot`, `unknown`), OS, browser, the `User-Agent` and
  the client address (`http.server`'s `clientAddress`, so behind a proxy
  only with `jhin.http.trustProxy`). A device may present its own `deviceType`
  and `os` in `POST /auth/pair` (T3's presented metadata). All of it is what
  the device says about itself and is shown as such: it helps the owner
  recognise a device, never decides access. It stays in `clients.json`,
  read only with `auth.read`. Tokens issued by `auth.tokens.issue` carry
  none. "Authorized clients" shows it as T3 does, one line of what is
  known: "Tablet · iOS · Safari · 192.168.1.20".
- **D1188. Live updates of the authorized clients list.** T3 streams
  `clientUpserted` / `clientRemoved`. `jhin.auth-token` emits the kernel
  event `auth.clients.changed {}` after every change of `clients.json`
  or of the open pairing codes (never with a secret). The transport that
  provides `rpc.streams` already depends on `auth.verifier` (the cycle of
  security.md Deferred), so `jhin.transport-ws` turns that event into the
  live stream `auth/clients`, guarded by `auth.read`, whose items say only
  that the list changed; the settings page reads `auth.clients.list` and
  `auth.pairing.list` again on each. Expiry of a pairing code needs no
  event: the page drops it at its `expiresAt`.
- **D1189. Tailscale Serve, from `jhin pair --tailscale`.** T3's flow: read
  `tailscale status --json` for the machine's MagicDNS name ("This machine
  has no MagicDNS name. Run `tailscale up` and enable MagicDNS."), probe
  `https://<name>:<port>/.well-known/jhin` (port 443 by default,
  `--tailscale-serve-port`); a mapping that answers with this node's
  `instance` is kept, one that answers 502–504 or not at all is
  (re)created with `tailscale serve --bg --https=<port> <local url>` only
  when `tailscale serve status --json` shows the port empty or proxying
  only `/` to the target `jhin pair` last mapped on that port (kept in
  `<home>/cli/tailscale-serve.json`), and one that answers anything
  else, or a port with a TCP forward, another handler or Funnel, is never replaced ("… already serves
  something that is not this Jhin node. Pass --tailscale-serve-port …").
  What it publishes: the node's whole HTTP server (web client, `/rpc`,
  `/auth/*`, `/mcp`, `/mesh/*`) to every device of the tailnet, over HTTPS
  with Tailscale's certificate; never to the internet (Funnel is not
  offered). Access is still the node's tokens: a tailnet device without a
  token or a code gets nothing more than `/auth/pair` and
  `/.well-known/jhin`. Tailscale Serve proxies from loopback, so every
  tailnet client shares one rate-limit bucket until `jhin.http.trustProxy`
  names `127.0.0.1` (the note says so). The mapping outlives the node, as
  in T3: the output prints how to remove it (`tailscale serve
  --https=<port> off`). The node never runs `tailscale` itself.
- **D1190. Pairing links for a `jhin client` page.** T3's hosted link,
  without T3's host: `auth.pairing.create` takes `clientUrl` (where a
  `jhin client` page is served; default `jhin.auth-token.clientUrl`, unset
  by default) and then also returns `clientLink`:
  `<clientUrl>/pair?host=<node base url>#token=<CODE>` (T3's
  `buildHostedPairingUrl`, with `label` in the query when given). The page
  pairs over `POST /auth/pair` (CORS without credentials, D420) and saves
  the node (D423); a link carrying anything but a pairing code is refused,
  so a link never makes the page keep a standing token. The node's address is in the query, so the client page's
  host may log it; the code stays in the fragment. A link from someone else
  can name their own node: the page then saves that node (shown by its
  address in the node list), whose answers are data, never code: client
  plugins load only from the page's own origin (`boot.ts`). As in T3, the
  page pairs as it opens, without asking first. `host` must be an http(s)
  address without credentials, query or fragment, else the page says the
  link names no node. A `host` with plain `http:` sends the code over the
  network in clear, as the node's own `http:` pairing links do (D1181):
  pairing over HTTPS (Tailscale Serve, a proxy) avoids it. Without a base
  address (no `http.server`, no `baseUrl`) there is no `clientLink`.

### MCP OAuth (W33)

- **D1191. MCP clients sign in with OAuth, T3's `/oauth/mcp/*`, in a plugin
  of its own.** An MCP client that finds no token gets `401` with
  `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`
  and follows the MCP authorization spec: protected resource metadata,
  authorization server metadata (`/.well-known/oauth-authorization-server`),
  dynamic client registration (`/oauth/mcp/register`), the authorization
  code flow with PKCE `S256` only (`/oauth/mcp/authorize`,
  `/oauth/mcp/token`), public clients only (`token_endpoint_auth_method`
  `none`), no refresh tokens. Every URL comes from the request's origin, so
  loopback, a proxy and Tailscale Serve each answer with their own:
  `http.server` 1.3 `requestOrigin` (the requested host; `https` for TLS,
  or for `X-Forwarded-Proto: https` from a trusted proxy or loopback), the
  one derivation the 401 header and the metadata share. The
  endpoints are the plugin `jhin.mcp-oauth` (requires `http.server`,
  `auth.verifier`, `secrets.store@^1.1`): neither `jhin.auth-token` nor
  `jhin.mcp-server` can depend on the secret store, whose optional edge to
  `agent.registry` leads back to them (D14 drops an edge that closes a
  cycle). Without the plugin (or the store) `/mcp` still answers `401` with
  the header, and MCP clients keep using tokens.
- **D1192. Registration is stateless and bounded.** As T3: a client id is
  the client's metadata (name, at most 100 characters; at most 5 redirect
  URIs of at most 512 characters) signed with an HMAC key, so an
  unauthenticated caller cannot grow the node's state; requested grant
  types and auth methods are ignored, every client is public. Redirect
  URIs are `https:` or `http:` on a loopback name (`localhost`,
  `127.0.0.1`, `[::1]`), never with credentials or a fragment; a loopback
  redirect matches on everything but its port (RFC 8252 §7.3), an `https:`
  one exactly. The key is the store's random secret
  `jhin.mcp-oauth/signing-key`: `secrets.store` 1.1 adds
  `getOrCreateRandom(name, bytes)` (T3's `ServerSecretStore`), additive.
- **D1193. The owner approves in the browser, with the node's session.**
  `GET /oauth/mcp/authorize` validates the request (client id signature,
  redirect, `response_type=code`, the PKCE challenge, `resource` naming this
  node's `/mcp`): an unknown client or redirect is shown on the page (T3's
  "This sign-in cannot continue"), never redirected; anything else goes back
  to the verified redirect with `error`, `state` and `iss`. A valid request
  gets the approval page, rendered by the node itself so a node without
  the web client (`jhin serve`) approves too, with T3's wording ("Agent
  sign-in", "Connect <name>", the note naming where approval returns,
  "Approve", "Deny"). Approving needs the node's page session (the cookie
  of D421) of a caller holding `auth.write` and every permission asked
  for, and a form posted with an anti-forgery value (an HMAC of the
  session, by its token's hash, and the request, so another session of the
  same owner cannot reuse it), refused from another origin and without an
  `Origin` unless `Sec-Fetch-Site` says same-origin. The
  page is `no-store`, `frame-ancestors 'none'`, `same-origin` referrers (with `no-referrer` Chromium posts the form with `Origin: null`). Without a
  session it offers T3's "Pairing code" field, which opens the session
  through `POST /auth/session` from the same page, then approves.
- **D1194. Scopes are Jhin permissions.** A client asks with `scope`: Jhin
  grants separated by spaces (D410). An absent scope means the permissions
  agents get (`AGENT_PERMISSIONS`, `@jhin/mcp-api`), T3's default of
  orchestration read and operate; `scopes_supported` lists them. `*` and
  `auth.*` are never offered to an MCP client (`invalid_scope`): an agent
  does not get the owner's whole authority or manage access. The
  approval page lists what is asked with D961's titles; the owner approves
  or denies, never edits the list.
- **D1195. Codes and tokens.** An authorization code is 32 random bytes,
  one use, valid 60 seconds (T3), kept as its SHA-256 in the plugin's
  kernel-scoped state, and bound to the client id, the redirect URI, the
  PKCE challenge, the resource and the approver; a presented code is spent
  even when a later check fails (RFC 6749 §4.1.2). The token endpoint
  issues through `auth.tokens.issue` as the approver with its grants at
  that moment (a session revoked, expired or narrowed since issues nothing, so D413
  holds): a
  device token (`jhd1`, D411) with method `oauth` (additive), the client's
  name as label, 30 days' life at most and never past the approver's own
  expiry (`expires_in`) and the request's metadata
  (D1187). It is listed under Authorized clients, revoked there, and
  checked by `/mcp` on every request (D414). `method` and `metadata` are
  the issuer's word, as a device's own metadata is: any caller holding
  `auth.write` may pass them, and the list shows them, never decides by
  them.
- **D1196. Nothing about OAuth is a UI-only path.** Issuing goes through
  the command `auth.tokens.issue`; listing and revoking OAuth clients are
  `auth.clients.list` / `auth.clients.revoke`; the HTTP endpoints are the
  protocol MCP clients speak, as `/auth/pair` is for devices.

### Hardening (W39)

The threat model comes first; the decisions after it implement it. T3
Connect stays out of scope.

- **D1361. What W39 hardens, against whom.** D1181's list stands; W39
  closes the gaps it left, ordered by what an attacker gains:
  (1) _DNS rebinding_ (D1181's attacker 3): a page the owner visits
  re-points its own name at the node's address. Its requests then carry
  the attacker's name as `Host` and `Origin`, so D418 counts it as the
  node's own page. It gets no session cookie (the browser keeps that for
  the node's host) and holds no token, so today it reaches only what needs
  none: the web client's files, `/auth/pair` (rate limited), the OAuth
  metadata and `/.well-known/jhin`. A `Host` allowlist (D1362) refuses it
  before any route, so a later route that trusts the same-origin check
  cannot be reached from such a page. (2) _A forged `X-Forwarded-Proto`_:
  the session cookie's `Secure` flag (D421) followed the header from any
  client; a client could only change its own cookie, so the gain is
  nothing, but the node's idea of "this request came over HTTPS" must come
  from one place (D1363). (3) _Shell access_: `terminals.write` runs input
  in a shell as the node's OS user, so whoever holds it holds the machine
  as that user: a device token, a pairing code's grants, an MCP client
  (D1364). (4) _One connection holding the node's memory_: windowed
  subscriptions each hold 16 MiB of waiting events, with no bound per
  connection (D470, D1365). (5) _A stolen bearer token_: a device token
  read from a device's storage, a proxy log or a screen works from
  anywhere until it expires or is revoked (DPoP and WebSocket tickets).
  (6) _An MCP client granted too much_, and permissions guarded only on
  streams that a client cannot offer. (7) _Secrets at rest_: Windows keeps
  the store's key in a file, and number or boolean config secrets stay in
  clear. Not defended, as in D1181: whoever controls the node's machine or
  the owner's account on it.

- **D1362. The node answers only to its own names: a `Host` allowlist for
  browsers.** `jhin.http` refuses, before any route or upgrade handler,
  a request that carries a browser's marks (an `Origin`, a
  `Sec-Fetch-Site` header, or a `User-Agent` starting with `Mozilla/`, as
  every browser's does; not `Sec-Fetch-Mode`, which Node's `fetch` sends
  too) when the host it asked for
  (`requestedHost`, D418) is a name the node does not answer to: `403`
  with "Blocked request: this node does not answer to the host <host>. Add
  it to jhin.http.allowedHosts." (the upgrade gets the same status before
  the WebSocket opens), and one warning per host in the log. A node
  answers to: every IP address (IPv4 or bracketed IPv6; a rebinding page
  always uses a name), `localhost` and every name under `.localhost`, the
  machine's host name (`os.hostname()`, its first label and both with
  `.local`), Tailscale's MagicDNS names (under `.ts.net`, which Tailscale
  answers, never a page's author: Tailscale Serve keeps them as `Host`,
  D1189), the hosts of `jhin.mesh.advertise` (the mesh plugin adds them
  through `http.server` 1.4 `allowHost(host)`, which returns a
  disposable and refuses `*`), and `jhin.http.allowedHosts`: exact names, or `.example.com`
  for that name and every name under it, or `*` to turn the check off.
  Names are compared without their port and case.
  Every name a request gives is checked, never skipped: its `Host`, and
  behind a peer of `jhin.http.trustProxy` its `X-Forwarded-Host` too. A
  rebinding page in the owner's browser reaches the node over loopback,
  and loopback is the usual trusted proxy (Tailscale Serve, a local
  proxy); it may set `X-Forwarded-Host` to an allowed name on its own
  same-origin `fetch`, but its `Host` still names the rebound name. A
  proxy that passes its public name as `Host` needs it listed too, once.
  The mesh's advertised hosts are read when the mesh plugin activates
  (a config change reactivates it). Requests without a browser's marks (the CLI, nodes,
  MCP clients, `curl`) are not checked: they choose their `Host` freely
  anyway, so a check would only break a node reached by a name nobody
  listed (a program that calls itself `Mozilla/` is checked, and its name
  has to be listed). Browsers send `Sec-Fetch-Site` only to trustworthy
  origins (HTTPS, loopback) and `Origin` on every `POST` and WebSocket
  upgrade, but a page on plain `http:` makes same-origin `GET`s with
  neither; its `User-Agent` marks it. Tailscale names are allowed for any
  tailnet, not only the owner's: a page needs a tailnet name that
  resolves to the node, which only the tailnet's own members can give it. This is a change in
  behaviour: a browser that opens the node by a name outside the list (a
  LAN name such as `nas.lan`, or a reverse proxy's public name passed on
  as `Host` or `X-Forwarded-Host`) is refused until the owner lists it;
  the 403 names the setting, and the log warns once per host (at most 64
  hosts, since the header is the client's).

  Later slices of PR 6 define D1364–D1368: shell access and connection
  bounds (6b), DPoP and WebSocket tickets (6c).

- **D1363. Whether a request came over HTTPS has one answer.** The session
  cookie (D421) is `Secure` when `http.server`'s `requestOrigin` (1.3,
  D1191) says `https`: a TLS socket, or `X-Forwarded-Proto: https` from a
  peer of `jhin.http.trustProxy` or loopback (Tailscale Serve and a local
  proxy). A header from any other peer no longer counts. Without 1.3 only
  a TLS socket does.

- **D1364. Shell access is named wherever it is granted.** `terminals.write`
  runs input in a shell as the node's OS user (terminal.md D140), so
  holding it is holding the machine as that user; it stays one permission
  (a narrower "run only these commands" grant is not a shell). What
  changes is that nobody grants it unknowingly. A permission's
  description (D961) may say `shellAccess: true`
  (`PermissionDescription`, `@jhin/sdk`, additive); `jhin.terminal` says
  it of `terminals.write`, and `auth.permissions.list` returns it. Where a
  grant is chosen, a permission with shell access says so in the words
  "Shell access: runs commands on this machine as the node's user.": the
  pairing dialog (D424) under its title, and the MCP approval page (D1193)
  in its list item. `jhin pair` adds the note "This link grants shell
  access (terminals.write): the device can run commands on this machine as
  the node's user. Narrow it with --permission." when the code's grants
  cover one. The defaults stay: a code still defaults to its creator's
  grants (D419), so pairing one's own device keeps its terminals, and an
  MCP client asking for no scope still gets `AGENT_PERMISSIONS`, which has
  no shell access.
- **D1365. A connection holds at most 32 MiB of waiting events.** D470
  bounds each windowed subscription at 16 MiB; a connection now also
  bounds the sum over its windowed subscriptions (the events waiting
  beyond their windows, and those buffered while a backlog is read) at
  `MAX_CONNECTION_WAITING_CHARACTERS`, 32 MiB of JSON. The subscription
  whose event takes the sum past it ends as D470's do
  (`rpc.subscription.ended`, `SUBSCRIPTION_OVERFLOW`), or its
  `rpc.subscribe` fails with that code while its backlog is read, and its
  waiting events are freed; the client reads a snapshot again. So one
  connection opening many subscriptions it never acknowledges holds at
  most 32 MiB instead of 16 MiB each (characters of JSON, as D470 counts:
  up to about twice as many bytes). The subscription that crosses the
  bound ends, not the one holding the most: a small new one (a terminal)
  may end while an old one keeps its share, a choice kept for its
  simplicity (the client reads a snapshot again either way).
  Subscriptions without a window are unchanged (the socket's own buffer
  holds them, as before D470).

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

Implements D419–D425, in two layers:

- **PR 4a — the node** (D419–D421): pairing codes and commands, `POST
  /auth/pair`, the `/auth/session` cookie and the transport accepting it.
  **Done when:** tests over real HTTP and WebSocket exchange a code for a
  scoped token, refuse it a second time, open a session cookie only from the
  node's own page and accept it on the socket only from there.
- **PR 4b — the web client** (D422–D424): the pairing link, tokens out of
  `localStorage`, the Authorized clients settings and the QR code. **Done
  when:** Playwright pairs a second browser context with a node by its
  pairing URL, the page's token is not readable by scripts, and revoking the
  client disconnects it.

`jhin pair` (D425) is done in PR 5.

### PR 5 — Pairing and remote access (W33)

A stack, one slice a PR:

- **PR 5a — `jhin pair`** (D1181–D1186): the threat model, `runtime.json`
  and `/.well-known/jhin` in `jhin.http`, `@jhin/qr-code`, `jhin pair`.
  **Done when:** a test starts a node, runs `jhin pair` from its home, reads
  T3's block with a QR code whose modules match the encoder's, pairs once
  over `POST /auth/pair` with the code's grants and is refused the second
  time, finds the code in no log, and sees `runtime.json` (`0600`, no
  token) gone after the node stops.
- **PR 5b — Tailscale Serve** (D1189): `jhin pair --tailscale`.
  **Done when:** tests with a fake `tailscale` create a mapping where
  nothing answers, keep one fronting this node, never replace one that
  answers as something else, a funneled port, a TCP forward, another path
  or a target `jhin pair` did not map last on that port, say why when
  Tailscale fails (repeating what it said, and how to remove a mapping
  left behind), and `probeNode` is tested against real listeners.
- **PR 5c — clients** (D1187, D1188, D1190): device metadata, the live
  `auth/clients` stream, pairing links for a `jhin client` page. **Done
  when:** tests record a paired device's metadata (presented values win),
  tell `auth.read` subscribers of every change and refuse others, build
  T3's client-page link, and Playwright sees the open settings page follow
  a pairing made elsewhere and a `jhin client` page pair by its link.
- **PR 5d — MCP OAuth** (D1191–D1196): `jhin.mcp-oauth`, `secrets.store`
  1.1 `getOrCreateRandom`, `auth.tokens.issue` method `oauth`. **Done
  when:** a test over real HTTP registers a client, approves it with a
  page session opened by a pairing code, refuses a forged or foreign
  approval, exchanges the code once, calls `/mcp` with the token, sees the
  client listed and revoked, and never lets a session approve more than it
  holds.

### PR 6 — Hardening (W39)

A slice a PR, in the order of D1361's risks:

- **PR 6a — names and HTTPS** (D1361–D1363): the threat model, the `Host`
  allowlist, `http.server` 1.4 `allowHost`, the mesh's advertised names and
  the cookie's `Secure` from `requestOrigin`. **Done when:** tests over real
  HTTP refuse a browser's request and upgrade for a rebound name with 403
  before any route, answer non-browsers, addresses, loopback, the machine's
  and Tailscale's names, listed and advertised ones, check a trusted
  proxy's forwarded host, and set `Secure` only for HTTPS as `http.server`
  tells it (a TLS socket, a forwarded `https` from a trusted or loopback
  peer, never from another one, and only TLS without `requestOrigin`).

- **PR 6b — shell access and connection bounds** (D1364, D1365).
  **Done when:** `auth.permissions.list` marks `terminals.write`, the
  pairing dialog and the approval page say "Shell access", `jhin pair`
  notes it for a code that grants it, and a test opening many windowed
  subscriptions on one connection ends the one that takes it past 32 MiB
  while the others go on.

## Deferred

- A secret whose real value starts with the marker and `#`
  (`••••••#note`) reads as an addressed marker and is refused on save
  (D417); such a value has to be changed to be saved.
- `host.config.get` and `host.config.patch` convert every section's schema
  (`config.jsonSchema()`) to pick one; a kernel call for one section's
  schema, or a cache cleared on `kernel.config.changed`, would avoid it.

- The secret store (W28): Windows keeps the store's key in the key file
  (no Credential Manager yet, D1024); an existing store cannot move its key
  between the keychain and the file, and an unreadable one has no reset
  command: it has to be moved aside by hand (D1023).
- A list item whose reference does not resolve is left out of the applied
  list, so the items after it move up one place in the effective value (the
  files and their addressed markers keep their places, D417).
- Config secrets that are numbers or booleans stay in clear (D1025); a
  reference removed from a file by hand stays in the store (only changes
  through the host delete them, D1026).
- A plugin that reads a config secret only while it activates, before
  `jhin.secrets` is active, sees it absent until `config.onChange` (D1025).
- Secret requests (W28): T3's "Waiting for an answer in the original
  thread" for a card inherited by a fork, its redirect of typing near a card
  away from the composer, and its metrics of requests and consumed refs are
  not ported. The card is a lazy chunk (D440) that renders nothing if it
  fails to load: the agent's call then times out. Answering a card of a mesh member's thread goes through
  `threads.call`'s relay and is not covered by a test.
- A fan-out (`mesh.config.patch`) that carries a marker resolves it on each
  target against that node's own stored value; a target with none refuses
  the change (`CONFIG_SECRET_MISSING`), recorded as `mesh.config.failed`.
- The `Host` allowlist (D1362) allows every `*.ts.net` name: on a tailnet
  shared with members the owner does not trust, one of them could give a
  page a name that resolves to the node. No setting narrows it to the
  owner's tailnet yet.
- T3 Connect: pairing and remote access through a T3 account, the hosted
  relay and the hosted-app pairing link (out of scope, `t3-roadmap.md`).
- Tailscale Serve (D1189) is `jhin pair --tailscale` only: T3's
  `t3 serve --tailscale-serve` (publishing at every start) is not ported,
  since the node never runs `tailscale` itself. The flow is tested with a
  fake `tailscale` and fake probes; no automated test runs a real tailnet.
  It was checked by hand once (PR 5b): the mapping answered with the node's
  instance, and `POST /auth/session` from the tailnet page's own origin got
  its `Secure` cookie, so Tailscale Serve keeps the `Host` D418 checks.
  `<home>/cli/tailscale-serve.json` is read, merged and renamed without a
  lock: two `jhin pair --tailscale` runs at once may lose one target, which
  only makes a later run refuse to repair that mapping.
  Ownership is per Jhin home while Tailscale Serve is per machine: a
  mapping another home made is refused, not repaired. When `jhin pair
  --tailscale` fails after `auth.pairing.create` succeeded (printing, an
  unreachable node mid-run), the mapping's notes are not repeated.
- DPoP-bound tokens and T3's WebSocket tickets: a device token is a bearer
  token.
- MCP OAuth (D1191–D1196) leaves out T3's access levels (its runtime
  modes): a client asks for Jhin permissions instead. No refresh tokens: a
  client signs in again after 30 days. The approval page is the node's own
  HTML, not a web client route, and assumes the node at the root of its
  origin (a proxy path prefix breaks its form and its `/auth/session`
  call). A pairing code opens a page session to approve with; T3's
  separate "approval code" check is not ported.
  A registered client id cannot be revoked on its own (registration is
  stateless, D1192): it grants nothing without an approval, its tokens are
  revoked under Authorized clients, and only rotating
  `jhin.mcp-oauth/signing-key` voids every id at once (no command does it).
- A `jhin client` link (D1190) pairs as the page opens, as T3's hosted
  page does; a confirmation naming the node before it is saved is not
  added.
- Live updates of the authorized clients list (D1188) say only that the
  list changed; T3's per-session "Connected" dot is not ported: a client's
  `lastSeenAt` changes with no event, so "Connected …" updates with the next
  change or reload, and a device that paired but has not connected yet
  reads "Not connected yet.".
- `auth.permissions.list` reads commands only: a stream guarded with a
  permission no command needs is not offered (the token plugin cannot
  depend on `rpc.streams`: the transport that provides it depends on
  `auth.verifier`, D1188).
- Shell access (D1364) marks `terminals.write` only. Other permissions
  that end in commands run as the node's user are not marked yet:
  `projects.write` with project scripts needs `terminals.write` already,
  but `threads.write` (an agent in full access runs commands),
  `git.write` (hooks) and `editors.open` are not described as such.
- An unreadable `clients.json` is moved aside to `clients.json.corrupt` and
  no device token works until new ones are issued; nothing repairs it.
- `lastSeenAt` is kept in memory and written with the next change of
  `clients.json`, so a restart may lose the latest ones. Expired tokens are
  dropped from the file with the next write.
