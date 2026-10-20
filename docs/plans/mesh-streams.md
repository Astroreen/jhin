# Mesh live streams

Status: **in progress**. Workstream W17 of `t3-roadmap.md`: the streams of a
mesh member reach a client connected to another node, so the source control
and the terminals of threads on members work like local ones, and the event
log streams that only grow (`source-control`, `mesh/outbox`) are trimmed.
Decisions D495–D509.

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

- **D496. `storage.eventlog@1.1` can trim a stream.** `trim(stream,
  through)` forgets the events with `sequence <= through`, except the
  newest, which always stays, and resolves how many it forgot. Nothing else
  moves: the head, the sequences of what is kept, `expectedHead` and
  `streams()` are what they were, so an append after a trim continues the
  numbering. `read` after a sequence older than the first kept event starts
  at the first kept one, so a reader sees the gap (the next sequence is not
  `after + 1`). Keeping the newest event keeps the head in the data itself
  (`node:sqlite` takes it from `max(sequence)`), so trimming needs no schema
  change. The method is optional in the TypeScript contract, as it is in the
  capability: a 1.0 provider has none, and callers trim with `trim?.()`. The
  memory store and `jhin.storage-sqlite` provide 1.1, and the contract suite
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
  control feed (D118) treats an event whose sequence is not the one after the
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
  knows to fall back.
- **D500. `rpc.streams@1.1`: a source can be followed instead of read.** A
  relay has no events to read, only a subscription elsewhere. A served
  source may have `follow(stream, after, listener)`, returning the
  subscription and a promise of the head once it is attached; `rpc.subscribe`
  then uses it instead of `subscribe`, `head` and `read`, answers with that
  head, and fails with its error. To get that head from the next node, the
  RPC client's `subscribe` takes `onReady(head)` and the link's caller
  `subscribe` takes the same callbacks (both additive). `jhin.transport-ws`
  provides `rpc.streams@1.1`; `jhin.mesh` takes it optionally (`^1.1`), and
  without it there are no relays (nothing to serve them through).
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
  relays answers `COMMAND_NOT_FOUND` instead of an empty stream that never
  says anything. The command and a subscription to `relay/` need
  `mesh.call`: a relay reads what `mesh.call` could read with
  `terminals.get` or `git.status`. A node relays at most 10 000 streams at
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
  on the in-memory network (D38) with an optional test kernel behind it: its
  commands answer calls from members, its live streams and event log are
  what members read, `mesh.streams@1` is provided for its plugins to share
  through, and a client connection serves `mesh.call`, `mesh.relay` and the
  relays as the plugin does. Tests drive the real terminal and source
  control plugins on a member through it.

## Deferred

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
- Flow control through relays: every hop passes events on as they come
  (as `terminal.md` defers it for one node).
