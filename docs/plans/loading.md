# Loading and caching

Status: **in progress**. The owner asked (2026-10-24) that the web client
reach the screen faster and move fewer bytes. Three ways: compress what the
node sends, keep what a device has already received and ask only for what is
new, and load first what the first screen shows. Decisions D1581–D1620
(D1581–D1600 used so far). Three workstreams: P1 compression, P2 the history
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
- **D1585. What is `no-cache` gets a validator.** `index.html`, client plugin
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
  the store does today.
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

## Workstreams

| Id  | Scope                                                  | Decisions   |
| --- | ------------------------------------------------------ | ----------- |
| P1  | HTTP compression and validators, WebSocket compression | D1582–D1587 |
| P2  | the history cache: threads, the sidebar, its setting   | D1588–D1594 |
| P3  | chunks for routes off the first screen, idle prefetch  | D1595–D1596 |

D1597–D1620 are free for decisions the workstreams find they need.

## Deferred

- Paging the timeline: render the newest turns first and load older ones as
  the user scrolls up, with a virtualized list (T3's way). It replaces D801's
  "renders every turn" and the page-wide find (D801), so it needs its own
  decisions first.
- A cached timeline snapshot (D1588 stores raw events).
- `permessage-deflate` with context takeover, if P1's numbers show a large
  gain worth the memory.
- `zstd` content encoding.
- Compressing the responses of other plugins' HTTP routes.
- A service worker that serves the app shell offline.
