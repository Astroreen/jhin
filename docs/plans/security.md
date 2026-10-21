# Security plan: pairing, remote access, scoped tokens, secrets

Status: **implemented** (workstream W13 of `t3-roadmap.md`, decisions
D410–D426): PR 1 #48, PR 2 #52, PR 3 #57, PR 4a #65, PR 4b #72. The
secret store and `secretRef`s (W28, D1021–D1034): #173, #178, #180. What is
left is under Deferred, `jhin pair` (D425) first.

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
- **D425. `jhin pair` prints a pairing link and its QR code** (Deferred:
  until then `jhin auth.pairing.create --label <name>` prints the link and
  the code as JSON). As `t3 pair`:
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

`jhin pair` (D425) is in Deferred.

## Deferred

- DNS rebinding (D418): a page on a name re-pointed at the node's address
  sends `Origin` and `Host` with that name, so it counts as the node's own
  page. It gets no session cookie (the browser keeps the node's cookie for
  the node's own host) and has no token, so it can call nothing; a `Host`
  allowlist (`jhin.http.allowedHosts`: loopback names, the bound and
  advertised addresses) would refuse it outright.
- The session cookie's `Secure` flag (D421) follows `x-forwarded-proto`
  from any client; a client can only change its own cookie this way. Read
  only from a trusted proxy once `http.server` tells the protocol it trusts,
  next to the `Host` allowlist.
- A secret whose real value starts with the marker and `#`
  (`••••••#note`) reads as an addressed marker and is refused on save
  (D417); such a value has to be changed to be saved.
- `host.config.get` and `host.config.patch` convert every section's schema
  (`config.jsonSchema()`) to pick one; a kernel call for one section's
  schema, or a cache cleared on `kernel.config.changed`, would avoid it.
- `jhin pair` (D425): a CLI subcommand printing T3's "Pairing with <label>
  (<origin>)." block with a terminal QR code. The encoder lives in the web
  client; the CLI would need it in a shared package.
- Pairing links for a `jhin client` page (T3's hosted-app link
  `…/pair?host=<node>#token=<CODE>`): today the link names the node's own
  address only.
- A paired device's metadata (T3's device type, OS, browser, IP) in the
  list of authorized clients; Jhin keeps a label only.

- The secret store (W28): Windows keeps the store's key in the key file
  (no Credential Manager yet, D1024); an existing store cannot move its key
  between the keychain and the file, and an unreadable one has no reset
  command: it has to be moved aside by hand (D1023).
- Config secrets that are numbers or booleans stay in clear (D1025); a
  reference removed from a file by hand stays in the store (only changes
  through the host delete them, D1026).
- A plugin that reads a config secret only while it activates, before
  `jhin.secrets` is active, sees it absent until `config.onChange` (D1025).
- Secret requests (W28): T3's "Waiting for an answer in the original
  thread" for a card inherited by a fork, its redirect of typing near a card
  away from the composer, and its metrics of requests and consumed refs are
  not ported. Answering a card of a mesh member's thread goes through
  `threads.call`'s relay and is not covered by a test.
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
