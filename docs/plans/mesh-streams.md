# Mesh live streams

Status: **in progress**. Workstream W17 of `t3-roadmap.md`: the streams of a
mesh member reach a client connected to another node, so the source control
and the terminals of threads on members work like local ones, and the event
log streams that only grow (`source-control`, `mesh/outbox`) are trimmed.
Decisions D495–D505.

It continues `foundation.md` (D26 history sync, D47 the client reaching a
member through its connection), `source-control.md` (D114, D118) and
`terminal.md` (D141, D142), and takes these items off their Deferred lists:
trimming the `mesh/outbox` history (foundation), live source control of mesh
members and trimming the `source-control` stream (source-control), and
terminals of threads on mesh members (terminal).

## Decisions

- **D495. T3 Code (D53, `eb7b35ac`) has nothing to port here.** T3 has no
  mesh: a client connects to every environment itself, and an environment's
  terminals and git status come over that environment's own connection. In
  Jhin a client reaches a member through the node it is connected to (D47),
  so the member's streams have to come through that node. What the client
  shows stays T3's (the drawer, the card's indicators, the branch toolbar);
  only the way the events travel is Jhin's. No file here derives from T3.

### Trimming the event log

- **D496. `storage.eventlog@1.2` can trim a stream.** `trim(stream,
  through)` forgets the events with `sequence <= through`, except the
  newest, which always stays, and resolves how many it forgot. Nothing else
  moves: the head, the sequences of what is kept, `expectedHead` and
  `streams()` are what they were, so an append after a trim continues the
  numbering. `read` after a sequence older than the first kept event starts
  at the first kept one, so a reader sees the gap (the next sequence is not
  `after + 1`). Keeping the newest event keeps the head in the data itself
  (`node:sqlite` takes it from `max(sequence)`), so trimming needs no schema
  change. The method is optional in the TypeScript contract, as it is in the
  capability: an older provider has none, and callers trim with `trim?.()`. The
  memory store and `jhin.storage-sqlite` provide 1.2 (1.1 is `t3-parity.md` D208,
  records written with an append), and the contract suite
  (`@jhin/storage-api/contract`) covers it.
- **D497. Only streams that are followed from a snapshot are trimmed.**
  `jhin.source-control` keeps the newest 1000 events of its `source-control`
  stream: clients read `git.status` and follow the stream after its head
  (D114), so older events are never read. It trims at start and after every
  100th append, so trimming costs one statement per hundred changes.
  `jhin.mesh` keeps the newest 1000 events of `mesh/outbox`: the changes
  still waiting live in `storage.kv` (foundation, PR 10 hardening), so the
  stream is only history, and it trims once the pending set is built from
  it (an outbox from before that is read whole first) and after every 100th
  append. Thread streams, the thread index and everything a mirror copies
  (D26) are never trimmed: a mirror copies a stream gap-free from sequence 1.
- **D498. A follower that finds a gap starts over.** The client's source
  control feed of a connected node (D118; a member's follows a stream only
  with D503) treats an event whose sequence is not the one after the
  last it applied as a sign that it missed some (the stream was trimmed past
  where it resumed after a disconnect), and reads `git.status` again, then
  follows the stream after the new head, as after a refused subscription.

### Relays

- **D499. A node relays a member's stream to its own subscribers.**
  `relay/<owner>/<stream>` is served by `jhin.mesh` through `rpc.streams@1`:
  each subscription to it opens one subscription to `<stream>` on `<owner>`
  from the same `after`, and passes its events on with the owner's
  sequences. Nothing is stored: a relay is a live stream (D141), unlike the
  copies D26 keeps in the event log, since terminal output and statuses are
  worth nothing later. A node next to the owner reads the stream itself; a
  node further away subscribes to the next hop's `relay/<owner>/<stream>`,
  so every hop forwards and none caches. When the route changes (a link
  drops, a shorter one appears) the relay subscribes again after the last
  sequence it passed on; with no route it waits, and resumes when one
  returns. A subscription made while the owner cannot be reached fails at
  once with `NODE_UNREACHABLE`, and one the owner refuses fails with the
  owner's error (`STREAM_NOT_SHARED`, `PERMISSION_DENIED`), so a client
  knows to fall back. A relay the owner refuses later, when it attaches
  again (the owner stopped sharing while the route was away), ends with that
  error (`rpc.subscription.ended`, D500), hop by hop to the subscriber. A relay whose
  route would lead back to the neighbor that asked for it fails with
  `RELAY_LOOP`, so routes that briefly disagree do not make two nodes relay
  to each other.
- **D500. `rpc.streams@1.2`: a source can be followed instead of read.** A
  relay has no events to read, only a subscription elsewhere. A served
  source may have `follow(stream, after, listener)`, returning the
  subscription and a promise of the head once it is attached; `rpc.subscribe`
  then uses it instead of `subscribe`, `head` and `read`, answers with that
  head, and fails with its error. A followed source may also end an attached
  subscription with an error; the server tells the subscriber with
  `rpc.subscription.ended {subscription, error}` (the notification
  `terminal.md` D470 brought for overflow), and the RPC client and the link's
  caller hand that to `onError`, as for a refusal. A followed source's
  events go as they come: no window (D470) is kept for them. To get that head from the next node, the
  RPC client's `subscribe` takes `onReady(head)` and the link's caller
  `subscribe` takes the same callbacks (both additive). `jhin.transport-ws`
  provides `rpc.streams@1.2` (1.1 is `security.md` D415's guards); `jhin.mesh`
  takes it optionally (`^1.2`), and without it there are no relays and no
  `mesh.relay`. Since 1.2 a served stream's permissions may be a function of
  the stream.
- **D501. A plugin shares a stream with the mesh: `mesh.streams@1`.** Members
  may read only the streams D26 names (threads, the thread index, `mesh`, and
  copies of them); the mesh cannot know which other streams are safe to
  share. `jhin.mesh` now provides `mesh.streams@1` (contract in
  `@jhin/mesh-api`): `share(name)` (a stream, or every stream under a prefix
  ending in `/`) returns a disposable, and while it holds, members may
  subscribe to the stream over a link and relay it: from `rpc.streams@1`
  when a plugin serves it there, otherwise from the event log.
  `jhin.source-control` shares `source-control`; `jhin.terminal` shares
  `terminals` and `terminal/`. Both take the capability optionally. A shared
  stream is relayed, not mirrored (`mesh.open` still copies only D26's).
- **D502. `mesh.relay {node, stream}` names the stream to subscribe to.** It
  answers `{stream}`: `relay/<node>/<stream>`, or the stream itself for this
  node, as `mesh.open` does. Clients call it first, so a node without
  relays (no `rpc.streams@1.2`) answers `COMMAND_NOT_FOUND` instead of an
  empty stream that never says anything. The command needs `mesh.call`; a
  subscription to `relay/<owner>/<stream>` needs `mesh.call` and what
  `<stream>` needs on this node (its served or guarded permissions, else
  `events.read`, `security.md` D415): one owner's nodes run the same
  plugins, so a relay never reads more than its subscriber could read here. A node relays at most 10 000 streams at
  once, its own subscribers' and its neighbors' together; one more fails
  with `RELAY_LIMIT`.

### Client

- **D503. Live source control of members.** The feed of a member (D118)
  reads `git.status` through `mesh.call`, then follows the member's stream
  through the connected node's relay after that head, as for the connected
  node itself, gaps included (D498). It falls back to D118's re-read on
  every change of the member's thread catalog when the connection has no
  relays (`COMMAND_NOT_FOUND`) or the member does not share the stream
  (`STREAM_NOT_SHARED`, a member without D501).
- **D504. Terminals of threads on members.** The drawer and the card's
  indicator work for a thread on a member as for one on the connected node:
  `terminals.*` go through `mesh.call` and the `terminal/…` and `terminals`
  streams through relays, behind one interface the attach code already uses
  (`call`, `subscribe`, the connection's state). The toast "Terminal
  unavailable" is gone; a connection without relays says so in the
  terminal's own `[terminal]` line instead. The node's terminal list feed
  (D148) is kept per target (connection and member), not per connection.

### Testing

- **D505. The in-memory mesh gets nodes wired as `jhin.mesh` wires them.**
  `@jhin/testing`'s `startMeshNode(network, id, options)` runs a mesh node
  on the in-memory network (D38) with a test kernel: `rpc.streams@1.2`,
  memory storage and `mesh.streams@1`, the plugin's own `mesh.call` and
  `mesh.relay` and its relays (`meshCallCommand`, `meshRelayCommand`,
  `serveRelays` from `@jhin/mesh-core`, which `jhin.mesh` registers too),
  and the plugins a test gives it. `connect(caller?)` is a client of it. Tests drive the real terminal and source
  control plugins on a member through it.

## PR plan

A stack of three PRs, each based on the one before:

1. **Trimming** (`feat/w17-mesh-streams`): D495–D498. Done when the storage
   contract trims memory and `node:sqlite` streams keeping their head,
   `source-control` and `mesh/outbox` keep their newest 1000 events, and the
   client's feed starts over on a gap.
2. **Relays** (`feat/w17-mesh-relays`): D499–D502, D505. Done when a client
   of a reads a terminal's output and the `source-control` stream of c,
   two hops away, through relays, with the real plugins on c on the
   in-memory mesh, and an unshared stream is refused.
3. **Client** (`feat/w17-member-streams-ui`): D503, D504. Done when the
   card, the branch toolbar and the terminal drawer of a thread on a member
   are live, proven against the in-memory mesh and in Playwright over real
   node processes, with screenshots.

## Deferred

- Trimming on a `storage.eventlog` provider older than 1.2: `keepNewest`
  trims nothing there, so `source-control` and `mesh/outbox` grow as before.
- Relay loops longer than one hop back: `RELAY_LOOP` stops a relay sent
  back to the neighbor that asked; a cycle through three nodes whose routes
  disagree at once is only bounded by `RELAY_LIMIT`.
- Subscriptions over a mesh link run with every permission on the owner, as
  mirrors do (`security.md` D416 caps calls, not subscriptions); relays are
  checked where the subscriber connects (D502).

- Mirrors of trimmed streams: a mirror copies from sequence 1 and treats a
  gap as a failed append (D26), so a stream that may be trimmed must not be
  mirrorable. Nothing mirrorable is trimmed today (D497).
- Trimming by age or size instead of a fixed count, and a config setting for
  the counts.
- A terminal of a member re-attaching after the route to the member comes
  back: the relay resumes the stream (D499), but the attach (D142) reads the
  session again only when the client's own connection comes back, so a
  member that restarted while the route was away leaves the tab silent until
  then.
- Flow control through relays: every hop passes events on as they come; a
  subscriber's window (`terminal.md` D470) is not kept for a followed source.
