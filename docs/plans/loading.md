# Loading and caching

Status: **in progress** (P2 done: #304–#306). The owner asked (2026-10-24) that the web client
reach the screen faster and move fewer bytes. Three ways: compress what the
node sends, keep what a device has already received and ask only for what is
new, and load first what the first screen shows. Decisions D1581–D1620
(D1581–D1600 and D1615–D1616 used so far). Three workstreams: P1 compression, P2 the history
cache, P3 chunks and prefetch.

It continues `foundation.md` (D26 history sync, the event log), `t3-parity.md`
(D440 code splitting, D801 the timeline renders every turn) and
`mesh-streams.md` (D496–D498 trimming and gaps), and takes "History sync into
on-device storage" off foundation's Deferred list for the web client.

What the node does today (2026-10-24, `08eeb571`):

- `jhin.web-ui` sends every file uncompressed (`plugins/web-ui/src/index.ts`).
  Hashed assets are cached for a year; `index.html`, client plugin files and
  `/client/*` JSON are `no-cache` with no validator, so a reload downloads
  them again.
- `jhin.transport-ws` does not negotiate `permessage-deflate`.
- Opening a thread subscribes to `thread/<id>` with no `after`, so the whole
  history is replayed on every open and every page reload. Only a reconnect
  of a live client resumes after the last sequence (`packages/rpc`).
- The sidebar reads all of `threads.catalog` on boot, then follows the
  `threads` stream after its `head`.

## Decisions

- **D1581. Nothing here is ported from T3 Code.** T3 pages and virtualizes
  its timeline; Jhin renders every turn (D801), and changing that is out of
  this plan (Deferred). What a user sees stays the same; only how the bytes
  travel and when they are loaded changes. Every behaviour here is a
  setting that defaults to on and can be turned off.

### P1. Compression

- **D1582. The web client is compressed when it is built.** The
  `@jhin/web` build writes `<file>.br` (brotli, quality 11) and
  `<file>.gz` (gzip, level 9) next to each file in `dist/` whose type
  compresses (`.html`, `.js`, `.css`, `.json`, `.svg`, `.webmanifest`) and
  that is at least 1 KiB, using `node:zlib` (no new dependency). A
  compressed file larger than the original is not written. Images and
  fonts (`.png`, `.ico`, `.woff2`) are never compressed again.
- **D1583. `jhin.web-ui` picks the encoding the browser asks for.** It reads
  `Accept-Encoding` with its q-values and prefers `br`, then `gzip`, then
  the file itself; a `q=0` refuses an encoding. When the chosen sibling
  exists it sends that file with `content-encoding` and its own
  `content-length`. Every response of a type that compresses carries
  `vary: accept-encoding`, also when it is sent uncompressed, so a cache in
  between never hands a compressed body to a client that cannot read it.
  `index.html` served for an app route (an extensionless path) is
  negotiated the same way. `HEAD` sends the headers `GET` would send.
- **D1584. Client plugin files and `/client/*` JSON are compressed as they
  are sent.** They are not built by `@jhin/web`, so `jhin.web-ui` compresses
  them on the fly with `node:zlib` (brotli quality 5, or gzip level 6),
  under the same type and 1 KiB rules. Server-sent events
  (`/client/events`) are never compressed: a compressor buffers, and an
  event must arrive when it is written.
- **D1585. What is `no-cache` gets a validator** (file tags amended by
  D1598). `index.html`, client plugin
  files and `/client/config` carry an `etag` (a weak tag of size and
  modification time for files, a hash for JSON), and a request whose
  `if-none-match` matches gets `304` with no body. The tag names the
  representation, not the encoding: the compressed and plain bodies of a
  file share it, which `vary` makes safe.
- **D1586. `jhin.web-ui.compression` turns it off.** A boolean, default
  `true`, in the `jhin.web-ui` config section (shown in settings as
  advanced). Off, the node sends files as they are, as before this plan;
  the validators of D1585 stay. A reverse proxy that compresses on its own
  leaves a response that already has a `content-encoding` alone.
- **D1587. `jhin.transport-ws` negotiates `permessage-deflate`.** Messages
  of 1 KiB and more are deflated (zlib level 3); smaller ones are sent as
  they are. Both sides use no context takeover, so a connection holds no
  compression window between messages: memory per connection stays
  bounded, which matters with many clients and mesh links. Binary payloads
  that are already compressed (preview frames, images) are sent with
  `compress: false`. `jhin.transport-ws.compression` (boolean, default
  `true`) turns it off. The PR reports the bytes of replaying a large
  thread with and without it, and the memory of 50 idle connections.
- **D1597. Every RPC message is text, so D1587's `compress: false` has
  nothing to skip yet.** `@jhin/rpc` sends JSON text frames only; preview
  frames and images travel as base64 inside JSON, and deflate still saves
  about a quarter of base64 (it uses 6 of 8 bits per byte), so they are
  deflated like any other message of 1 KiB and more. A binary frame of
  already compressed bytes, once a plugin sends one, is sent with
  `compress: false`.
- **D1598. A file's validator is a hash of its bytes.** It replaces D1585's
  "size and modification time for files": a packed install (`npm pack`
  stamps every file with one fixed time) and a new build of the same size
  would give two versions of `index.html` one tag, and a browser would keep
  the old one on `304`. `jhin.web-ui` hashes a file once and keeps the tag
  while its size, times and inode stay the same. It is still a weak tag, so
  every encoding of the file shares it.

### P2. The history cache

- **D1588. The web client keeps the streams it has read in IndexedDB.** A
  client plugin `jhin.history-cache` stores, per node, the events of each
  thread stream it has followed and the last sequence it has, and serves
  them back through a client service (`client.history-cache@1`). It stores
  events as they came, not the timeline built from them: a change to the
  code that folds events into a timeline never makes the cache wrong. A
  cached timeline snapshot is Deferred.
- **D1589. Opening a thread shows the cache first, then asks for what is
  new.** The timeline folds the cached events and renders them at once,
  then subscribes with `after` set to the last cached sequence, and appends
  what arrives to the cache, one IndexedDB transaction per batch the
  timeline already folds per frame. With no cache entry the subscription
  starts from 0, as today.
- **D1590. A cache that cannot be trusted is dropped, never patched.** An
  entry is keyed by the node's identity and the stream. The node's identity
  must be unique to its database, so a node that was reinstalled under the
  same name is another node. If the node has no such id, P2 adds one: a
  random id its storage writes when the database is created, returned as
  `epoch` by `threads.catalog` and `threads.get` (a minor version of the
  capability that serves them). The entry is dropped and the stream
  replayed from 0 when: the epoch differs; `threads.get`'s `head` is lower
  than the cached last sequence; the first event that arrives is not the
  one after the cached last sequence (the gap rule of D498); or the thread
  is gone from the catalog.
- **D1591. The sidebar starts from its cache too.** The cache keeps the
  catalog and its `head`. On boot the sidebar shows the cached catalog and
  follows the `threads` stream after the cached head; an epoch mismatch, a
  gap or a refused subscription falls back to reading `threads.catalog`, as
  the store does today. Only a feed's first start uses the kept catalog:
  after a reconnect it still has the catalog it followed, and reads
  `threads.catalog` as before. A node that cannot be asked keeps the kept
  catalog on screen with the error, as a live one is kept. Forgetting a
  connection forgets its catalog, and a node that answers no epoch has its
  connection forgotten (D1607).
- **D1592. A device setting turns the cache off.** "Keep chat history on
  this device", default on, under the client's device settings (stored on
  the device, not in node config: one node serves many devices, and each
  decides for itself). Turning it off deletes everything the cache holds at
  once and opens threads from 0 again. The commands
  `history-cache.status` (on or off, entries, bytes) and
  `history-cache.clear` (one node, or all) make it reachable outside the
  settings page.
- **D1593. What a device forgets, the cache forgets.** Removing a saved node,
  signing out of it or a refused token (`401`) deletes that node's entries.
  Entries of threads not opened for 30 days are deleted at boot. When a
  write hits the quota, the least recently opened threads are deleted and
  the write is tried once more; if it still fails, the cache stops writing
  for the session and threads open from 0. The cache does not ask for
  persistent storage: the browser may evict it, which costs one full
  replay.
- **D1594. The cache is as private as the browser profile.** IndexedDB is
  per origin and not encrypted; anyone with the device's profile can read
  the chats. The setting's description says so. The desktop app keeps its
  cache in its own profile the same way.

#### P2's own decisions

- **D1606. Only threads of the connected node open from the cache.** A
  thread of another mesh node is read through this node's copy or relay of
  it (D26, D499), whose sequences and epoch are not the ones `threads.get`
  answers through `mesh.call`. It opens from 0, as before this plan
  (Deferred).
- **D1607. The epoch is written with an append, and `threads.epoch` answers
  it.** `jhin.threads` writes the epoch the first time it is asked
  (a database never asked has none yet): one
  event `threads.epoch.created { epoch }` in the stream `threads/epoch`,
  appended with `expectedHead: 0` together with the record `epoch`
  (`storage.eventlog@1.1` records), so two processes sharing the storage
  agree on one. `agent.registry` 1.7 adds `epoch` to `threads.catalog` and
  `threads.get`, and the command `threads.epoch` (`{ epoch, head }`, the
  head of the `threads` index): the cheap question the sidebar asks before
  it follows the index from a cached catalog (D1591). A node from before
  1.7 answers no epoch, and nothing of it is cached.
- **D1608. What is kept starts at 1 and has no gap.** The cache keeps a
  stream only as its events 1 to its last sequence, in the IndexedDB
  database `jhin.history-cache` (stores `streams` and `events`, keyed by
  connection, stream and sequence; version 2 adds `catalogs`, one per
  connection, for D1591, and upgrades a version 1 database keeping its
  streams). A write that would leave a gap drops the
  stream; one that repeats kept events skips them, so two tabs following
  the same thread write it once. A read that finds fewer events than its
  last sequence (a write cut short) drops it. A thread whose own stream says
  it was deleted is dropped as the event arrives. The entry's size is the
  UTF-8 size of its events' JSON: an estimate, as `history-cache.status` says.

- **D1609. The setting is the device section `jhin.history-cache`.** One
  key, `enabled` (default `true`), defined by `jhin.history-cache` and shown
  as a row of the general settings' Behavior section
  (`settings.general.behavior`, contribution `jhin.history-cache.setting`),
  with how many threads are kept and about how large they are. Device sync
  never shares it (D488's rule for `jhin.sync`): each device decides for
  itself. Turned off, here or in another tab, everything is deleted;
  turned on again, threads are kept from their next open.
- **D1610. Room is made a quarter at a time.** A write over the quota deletes
  the least recently opened quarter (at least one) of the other kept
  streams, then is tried once more. The 30 days of D1593 count from when a
  thread last opened from the cache, kept per stream; the sidebar's catalog
  of a node goes only with the node (D1593) or the setting.
- **D1611. Writes and clears take turns.** The cache runs its writes and
  clears one after another, and a write checks the setting when its turn
  comes: one in flight when the setting goes off or a node is forgotten
  lands before the clear and goes with it, and none lands after. Drops,
  the boot's eviction and `history-cache.status` take their turn too, so the
  status says what is kept once the queued work is done. The queue is per
  tab; every tab sees the setting change and clears after its own writes, so
  no tab's write outlives the setting. Signing
  out of a node is removing it in this client (removing the page's own node
  ends its session), so D1593's "signing out" is that removal. Without
  IndexedDB the plugin provides no service, but `history-cache.status` and
  `history-cache.clear` still answer (nothing kept, nothing cleared).
- **D1612. A cache stopped over the quota says so.** `history-cache.status`
  answers `enabled: false` while the setting is on, and the settings row says
  the cache is paused for this session because the browser has no room left.
  What is kept stays: the next session reads it and makes room again. A browser
  without IndexedDB is told apart: the row says the browser does not let
  the page store the history.

### P3. Chunks and prefetch

- **D1595. What the first screen does not show is a chunk of its own.** The
  first screen is the sidebar, the thread view and the composer. Settings
  pages, the scheduled tasks page and other routes and panels a user opens
  later load through the chunk loader of D440. The PR reports the size of
  the entry chunk, raw and brotli, before and after.
- **D1596. Chunks the user will likely open are fetched while the page is
  idle.** After the first screen has rendered, in `requestIdleCallback`
  (where the browser has it), the client calls the loaders of the settings
  page and of the panels in the right panel, so opening them later does
  not wait for the network. It fetches nothing when the browser asks to save
  data (`navigator.connection.saveData`).
- **D1615. The idle fetches wait their turn.** They start after the page's
  `load` event, one chunk per idle callback, the next once the last has
  settled, so the first screen has the network and the main thread first.
  Where the browser has no `requestIdleCallback` (Safari) the next task takes
  its place. The queue holds the settings page's first section (General),
  the browser panel, the diff panel, the pull requests panel and the file
  preview. Not the terminal: D440 proves a thread never fetches xterm.js
  until a terminal opens. Not the device panel: it opens only with a device.
  A fetch that fails is forgotten: the chunk loads again when it first
  renders, and only a failure there shows its "Try again" (D440). Chromium
  keeps a failed `import()` in its module map, though: a prefetch that
  failed on a flaky network fails the first open too, until the retry of the
  Deferred list below imports a fresh URL. The idle fetches also widen a race
  that was there before: "New thread" is enabled once the node's connection
  opens, but did nothing while its projects were still loading (#324 makes
  it wait). A chunk is
  fetched ahead through its `preload` (`apps/web/src/lib/lazy-chunk.tsx`), and
  `prefetchWhenIdle` (`apps/web/src/lib/idle-prefetch.ts`) returns a disposable
  that takes it off the queue.
- **D1616. What P3 moved off the first screen.** The settings page's Browser
  section with its import wizard (`preview/profiles.tsx`; the profiles
  themselves stay in `preview/profile-settings.ts`, which the panel reads),
  the worktree setup card (`source-control/worktree-setup.tsx`, loaded by
  `worktree-setup-header.tsx` for a thread that has a setup) and the Usage page
  (`usage-page.tsx`). The desktop app's webviews stay in the first load: as a
  chunk their host subscribed late, and a tab the agent opened right after
  start went headless (the desktop E2E, D1321–D1324, caught it). The
  settings sections, the scheduled tasks page, the panels and the dialogs
  that were already chunks (D440) stay as they are.

## Workstreams

| Id  | Scope                                                  | Decisions                                      |
| --- | ------------------------------------------------------ | ---------------------------------------------- |
| P1  | HTTP compression and validators, WebSocket compression | D1582–D1587, D1597, D1598; landed (#303, #309) |
| P2  | the history cache: threads, the sidebar, its setting   | D1588–D1594                                    |
| P3  | chunks for routes off the first screen, idle prefetch  | D1595–D1596, D1615–D1616                       |

D1597–D1620 are free for decisions the workstreams find they need.

P4, every config section on one page and read at once, is in
`config-ui.md` (D1621–D1640): it is a settings page change that is also a
loading one.

## Deferred

- Paging the timeline: render the newest turns first and load older ones as
  the user scrolls up, with a virtualized list (T3's way). It replaces D801's
  "renders every turn" and the page-wide find (D801), so it needs its own
  decisions first.
- A cached timeline snapshot (D1588 stores raw events).
- Forgetting at boot a node removed while no tab ran: `client.connections`
  has no "loaded" moment to compare against, so such streams go with D1593's
  30-day eviction, and its catalog with the next clear.
- A thread followed from the cache while its node could not be asked checks
  the head on every acceptance and asks again once; a database reset whose
  stream has grown past the kept sequence is caught only at the next open.
- The settings row's "Now N threads" is read when the page opens, when
  the setting changes and after a clear; it does not follow writes made
  while the settings page stays open.
- Opening a remote mesh node's thread from the cache (D1606): it needs the
  epoch of the copy the connected node reads it from.
- `permessage-deflate` with context takeover, if P1's numbers show a large
  gain worth the memory.
- A smaller `maxPayload` for `jhin.transport-ws` (today `ws`'s 100 MiB,
  counted after inflation), and fewer bytes held per connection
  (`memLevel`, `serverMaxWindowBits`): P1 measured about 100 KiB per
  connection that has received one compressed message. A lower limit needs
  the largest legitimate request first (inline images of `threads.send`).
- `zstd` content encoding.
- Compressing the responses of other plugins' HTTP routes.
- A service worker that serves the app shell offline.
- The rest of the first load is shared modules, not the entry chunk:
  `@jhin/ui` re-exports every component (Base UI, about 530 kB raw) and
  `@jhin/sdk` the whole `z` namespace with every Zod locale (about 210 kB),
  because user plugins import them by bare name (D16). Splitting them needs
  a decision on what a user plugin may import.
- "Try again" after a real network failure (D440). Chromium keeps a failed
  `import()` in its module map: the retry rejects again without a request,
  as P3's Playwright run shows (one request for the aborted chunk). The
  failed view and its button show; recovering needs a retry that imports
  the chunk's URL afresh (a query of its own), for every chunk's loader.
- The file icon sprite (`lib/pierre-icons.ts`, about 60 kB raw) loads with the
  first file chip's module; it could load on first use, with Lucide's file
  icon in its place until then.
