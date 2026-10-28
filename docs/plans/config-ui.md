# Config UI plan

Status: **implemented**, W16 (D475–D488, below) included. This file records how the settings page edits a
node's config: a form generated from each section's schema instead of
hand-edited JSON. It supersedes the JSON editor part of D66
(`t3-parity.md`); the section picker, the node picker and the mesh scope
picker (D20, D50) stay as D66 describes them.

## Goal

A plugin declares a config section with Zod (`context.config.define(section,
schema)`) and gets a settings page for it without writing UI: fields with
titles, descriptions, defaults and inline validation, saved to the node's
`config.jsonc` with its comments kept. What the form cannot render stays
editable as JSON, field by field, and the whole section can still be edited
as JSON.

## Decisions

- **D80. The node config page is a form generated from the section's JSON
  Schema** (`host.config.schema`, which is Zod's `z.toJSONSchema` of the
  section, `io: "input"`). Each key of the section becomes a field:

  | Schema                                                                            | Field                                             |
  | --------------------------------------------------------------------------------- | ------------------------------------------------- |
  | `string`                                                                          | text field                                        |
  | `boolean`                                                                         | switch                                            |
  | `number`, `integer`                                                               | number field (an integer field takes no fraction) |
  | `enum`, a union of literals (`const`)                                             | select; each literal's `title` is its label       |
  | `T \| null` (`.nullable()`)                                                       | the field of `T` with a "None" box                |
  | object with keys                                                                  | a group with its own header, recursively          |
  | array of the above leaves                                                         | an editable list                                  |
  | record (`additionalProperties`)                                                   | a key/value list; values use these rules          |
  | anything else: unions of objects, `unknown`, arrays of objects, recursive schemas | an inline JSON field                              |

  A field the form cannot render is an inline JSON field, never a reason to
  fail the whole form. Every section has an "Edit as JSON" escape hatch that
  shows the effective value and the node file's part as JSON, as D66 did; a
  section whose schema has no keys (a record, `unknown`) or whose node file
  part is not an object only has the JSON view. Keys of the node file that
  the schema does not know are listed, kept on save and editable as JSON.

- **D81. Titles and descriptions come from the schema first.** A field's
  title is the schema's `title` (`.meta({ title })`), else its key in
  sentence case (`trustProxy` → "Trust proxy"). Its description is the
  schema's `description` (`.meta({ description })` or `.describe()`), else
  **the JSONC comment directly above its key** in the node file, then in the
  project file. "Directly above" is a run of `//` or `/* */` comments ending
  on the line before the key, with no blank line in between; a comment after
  a value on the same line belongs to that value; lines of a paragraph are
  joined, an empty comment line starts a new paragraph. The same goes for
  the section: the title and description of the schema's root, else the
  comment above the section's key, else its id; the id is always shown. The
  distribution layer has no file today; when it gets one, its comments count
  too. `host.config.get` returns the comments (`comments`, additive: path
  inside the section and text), so the client never parses the files.

- **D82. Structure follows the schema.** Fields keep the schema's key order
  (the order of the Zod object's shape); a nested object becomes a group with
  its own header. There is no separate ordering or grouping hint: reorder the
  shape or nest an object. Three optional hints in `.meta()`:
  `advanced: true` folds a field under "Advanced" at the end of its group
  (unfolded while it is set or invalid), `examples: [...]` gives the
  placeholder of an empty field without a default, and `deprecated: true`
  marks it. Defaults show as placeholders, as the selected choice or the
  switch's state while a key is unset, and "(default)" in a select.

- **D83. Secrets are marked with JSON Schema's `writeOnly`**
  (`.meta({ writeOnly: true })`), on the field or on the non-null branch of
  a nullable one; everything inside a secret (a list's items, a record's
  values, a group's keys) is one too. The page never shows them in clear:
  text and number fields are password fields, wherever they are (a nullable
  field, a list item, a record value); in an inline JSON field, the "Edit as
  JSON" view and the effective value a secret reads `<hidden secret>`, and an
  edit that leaves that placeholder in place keeps the stored value (by key,
  and by position in a list); a placeholder where nothing is stored is
  refused. An override from the project file reads "it". A switch or a
  select cannot be hidden: a secret is text or a number. This is about the
  page only; `host.config.get` redacts them since `security.md` D417, and
  the page then holds the marker `••••••`, which it saves back unchanged. No
  first-party section has a secret.

- **D84. Saving sends the change, and checks it first.** Save writes only the
  node layer (`layer: "node"`), only the top-level keys whose value changed,
  so the comments of the others stay; a field reset to its default removes
  its key from the file. For that, `host.config.patch` and `mesh.config.patch`
  take an optional `unset` list of keys (additive; a queued change carries
  it, a node older than this ignores it). The same change goes to every node
  of the scope picker (D20), queued for the offline ones (D50). Values are
  checked where they are typed against the JSON Schema keywords Zod writes
  (types, enums, bounds, lengths, patterns, items, record values), with the
  message next to the field (`aria-invalid` and `aria-describedby`); text
  that is no value yet (`1e` in a number field, broken JSON) stays in its
  field as typed and is reported too. A key the node file leaves out is not
  missing: the other layers and the defaults fill it in; inside arrays,
  which replace rather than merge, required keys are checked. Save is off
  while anything is wrong or nothing changed. What only the node can tell (a
  refinement, a value from the project file) comes back from
  `host.config.get` as `issues` (additive, by dotted path) and shows at its
  field until the field changes.

## Config and settings sync (W16)

Workstream W16 of `t3-roadmap.md` finishes the Deferred list below (except
redacting secrets, W13) and two items of `t3-parity.md`: pushing a node's
config changes to its clients, and syncing visits, drafts and device
settings across devices. The reference is T3 Code at D53 (`eb7b35ac`); where
T3 has no such thing (drafts and client settings stay per device there,
rules of the form below), the decision says so.

### Saving a change

- **D475. A change checks the node it goes to before anything is written.**
  `sendConfigChange` (`@jhin/host-api`) sends a change as edits through
  `host.config.edit` (D476) where the node has that command; a node that
  answers `COMMAND_NOT_FOUND` is older and gets the change as whole top-level
  keys through `host.config.patch`, with `unset` only when its
  `host.config.patch` declares `unset` in its input schema
  (`host.commands.list`). A removal such a node cannot do is refused with
  `CONFIG_CHANGE_UNSUPPORTED` ("too old to remove keys") and reported as
  `failed`, never as `applied` with the key left in the file. The same
  function runs for a save to the page's own node, for every target of
  `mesh.config.patch` and for every queued change when it is delivered, so a
  node that comes back older than the sender is checked then. Removing a key
  the file does not hold is `applied`: the file is as asked.
- **D476. Saves edit leaf paths, so comments inside a changed key stay.**
  `host.config.edit` (`{ layer, section, edits: [{ path, value? }], at? }`,
  additive, permission `host.config.write`) applies each edit at its path
  inside the section with `jsonc-parser`'s `modify`; an edit without `value`
  removes its key. Where the file has no object at an edit's parent (another
  node of the scope whose file differs), the change's whole top-level key
  (`values`, sent along) is written instead, so the target ends with what
  the sender's form showed; without `values`, the missing objects are
  created around the edit. The form computes the edits with `configEdits`: plain
  objects on both sides are compared key by key down to the deepest path that
  changed; a value, an array (its items have no identity but their place) or
  a type change is written whole at its path. A change carries both forms
  (`values`/`unset` and `edits`), so it reaches nodes of either age;
  `mesh.config.patch` takes `edits` (additive) and its outbox keeps them. The
  D50 write time stays per layer and section.
- **D477. The page edits the node file or the project file.** A "File"
  select above the form (T3 keeps settings per scope the same way, with its
  "Inherit" state per scope) picks the layer: "Node file" (the node's
  `config.jsonc`, the default) or "Project file" (`.jhin/config.jsonc` of
  the project the node was started in). The form, the JSON view, comments
  and the saved change follow the chosen layer; the other file's value shows
  under the field: in the node file, "The project file sets X, which wins."
  as before; in the project file, "The node file sets X; this file wins over
  it." The mesh scope picker sends the change to the same layer of every
  target. Changing the file with unsaved edits asks first, as changing the
  section does.

### The form

- **D478. Empty text follows the schema's `clearWhenEmpty`, as in T3**
  (`ProviderSettingsForm`'s `clearWhenEmpty: "omit" | "persist"`, D53).
  `.meta({ clearWhenEmpty: "persist" })` keeps an emptied text field as `""`
  in the file; the default, `"omit"`, removes its key as before. A text field
  whose file value is `""` (whatever the hint) shows empty with the
  placeholder "Empty" and its reset button, not the default. Numbers have no
  empty value: an emptied number field removes its key, and `null` stays
  the "None" box of a nullable field.
- **D479. Arrays of objects are lists of groups.** An array whose items are
  objects with keys the form renders (keybinding rules) is a list: each item
  a bordered group of its fields under "Title N", with "Move up", "Move down"
  and "Remove" (`Remove <title> N`), and "Add" at the end, which appends an
  empty item (`{}`): keys with a default take it when the section is read,
  and required keys without one are reported at their fields until they are
  filled in. (Amended in the PR that implements it: an earlier draft had Add
  write the defaults into the item.) Required keys inside items are
  checked (D84) and errors show at the item's fields. An item that is no
  object, or items the form cannot render, keep the inline JSON field. T3
  has no generic editor for these; its lists (`Arguments`, D53) add and
  remove rows the same way.
- **D480. A record's key is renamed in place.** The key of an entry is a text
  field: Enter or leaving it renames the entry, keeping its value and its
  place; Escape gives the old key back. An empty key or one already taken is
  refused next to it ("That key is there already", "A key cannot be empty")
  and the entry keeps its old key.
- **D481. Fields shown only when another has a value.** `.meta({ when: {
  mode: "custom" } })` shows a field only while its sibling `mode` (in the
  same group) is `"custom"`; an array lists the values that show it
  (`{ mode: ["a", "b"] }`), several keys must all match. The sibling's value
  is the one in effect for the edited file: the edit, else the other file
  that wins over it, else the default. A hidden field that is set or wrong
  stays shown, as an advanced one does (D82); hidden or not, its value is
  kept on save. This is T3's custom-only fields (branch naming instructions
  shown for `branchNamingMode: "custom"`, D53) as a schema hint.
- **D482. Plugins contribute field controls.** `.meta({ control: "color" })`
  asks for the control named `color`: the form renders the first visible
  contribution of the slot `settings.config.control.color` with
  `ConfigControlProps` (`@jhin/client-api`: the field's key, path, title,
  schema, default, example and whether it is a secret, the value, `onChange`
  with `undefined` to remove the key, the label, `invalid`, `describedBy`,
  `disabled`). Without a contribution the field gets its built-in control,
  so a section never depends on a plugin being there. Slot rules hide,
  reorder and replace them like any contribution (D12). T3's pickers
  (`ThemeColorPicker`, `FontFamilyPicker`, D53) are this kind of control;
  porting them is their workstreams' business.

### Pushing config changes to clients

- **D483. A node tells its clients when its config changes,** as T3's
  `subscribeServerConfig` sends `settingsUpdated` after a write and on a
  watched file change. The node host emits `host.config.changed`
  (`{ layer, sections }`, the sections whose part of that file changed)
  whenever it applies a config file: a save, a change from another node of
  the mesh, an edit by hand the watcher sees. The builtin
  `jhin.host-streams` (in `@jhin/node-host`, optional `rpc.streams@^1`)
  serves those as the live stream `host/config` (permission
  `host.config.read`); it keeps nothing, so a client subscribes for what
  comes next and reads the current state itself.
- **D484. Clients follow it.** The builtin client plugin
  `jhin.node-config-feed` follows `host/config` on every connection and
  emits the client event `node.config.changed` (`{ connection, layer,
  sections, all? }`, `@jhin/client-api`); a connection that opens again
  emits it with `all: true`, since nothing is replayed while it was away. `client.machines@1` asks a connection's
  `host.identity` again when `jhin.host` changed there (D132 asked only on
  reconnect and after this page saved). The node config page reads the
  shown section again when it changed: an editor without changes shows the
  new file; one with changes keeps them, rebased onto the new file (each
  edited path set again on top of it), and says "Changed on the node while
  you edited; your changes are kept on top of it." (T3 keeps a field's
  draft while it is focused and shows the new value after, D53). A member of
  a connection's mesh is not followed: its streams do not cross the mesh
  yet (W17).

### Syncing across devices

- **D485. Visits live on the thread's node, as T3's `thread.visit`.** A
  thread record gets `lastVisitedAt` (additive): `threads.visit` (`{
  threadId, at }`) moves it forward only and changes nothing else (no
  `updatedAt`, as T3's comment says: a read receipt is not activity), and
  `threads.mark-unread` sets it to 1 ms before the latest turn's end, when
  that turn completed (T3's `thread.mark-unread`; the record keeps only its
  latest turn, so a thread whose latest turn did not complete is refused). A
  visit from a clock ahead of the node's counts as the node's now, unless it
  is exactly the thread's own snooze wake time (dismissing "Woke"). Both go
  out through the `threads` index, so every client and device of the node
  sees them. `client.visits@1` reads the record's value where the node keeps
  one and the device's own visit otherwise (an older node, a thread never
  visited anywhere), as T3's `resolveThreadLastVisitedAt` does; a visit is
  sent when it moves the record forward, to a mesh member through
  `mesh.call`.
- **D486. Drafts follow the thread to every device.** T3 keeps drafts per
  device; here a draft's text is also kept on the node of its thread (or of
  its project, for a new thread): `threads.draft.get` and
  `threads.draft.set` (`{ key, prompt, at }`, key `thread:<id>` or
  `project:<id>`; an empty prompt is kept as cleared, so an older text
  cannot come back) keep it in `storage.kv`, the later `at` winning, and the live stream
  `threads/drafts` tells a node's clients of a change (all three need
  `threads.drafts` since D1704). A composer takes the
  node's draft when it is later than its own and the composer is not
  focused, so typing is never overwritten under the cursor; it reads the
  node's draft when it opens, and a draft of a mesh member's thread is read
  only then (its stream does not cross the mesh). Pasted images
  stay on the device that has them (they travel as data URLs, D54).
- **D487. Device settings follow the owner to every device.** The device
  layer (`client.settings@1`) is also kept by every node the device is
  connected to: `host.device-settings.get` and `host.device-settings.patch`
  (`{ section, values, at }`, the whole section as the device has it) write
  `device-settings.json` in the node's home, per section, the later `at`
  winning; the live stream `host/device-settings` tells its clients. A
  device sends each change to its open connections and, when a connection
  opens, takes every section that node holds later than its own and sends
  the ones it holds later (`client.settings@1.1` adds `sections`,
  `changedAt`, `apply` and `onDidChange`; the builtin `jhin.device-sync`
  does the rest). Devices
  that share a node agree. What is not a device setting stays per device:
  the sidebar's width, the shelf and filter state, saved connections.
- **D488. Syncing is turned on per device.** General settings get
  "Sync settings across devices" and "Sync drafts across devices" (section
  `jhin.sync`), both off by default: T3 keeps client settings and drafts per
  device, so a device shares them only once its owner asks. That section is
  never synced itself; with a switch off, the device neither sends nor takes
  that kind of state.
  Visits are thread state on the node (D485) and always shared, as in T3.
- **D1704. A draft is read and kept with `threads.drafts`** (W48,
  `security.md` D1701 (1)). A draft is what a person typed and has not
  sent (a pasted key, a note to self), not thread state, yet D486 guarded
  it with `threads.read` and `threads.write`, which every thread's agent
  and MCP client holds (`AGENT_PERMISSIONS`): an agent could read every
  draft of every thread and project, and overwrite one. `threads.draft.get`,
  `threads.draft.set` and the stream `threads/drafts` now need
  `threads.drafts` ("Sync drafts", "Read and keep what was typed and not
  sent yet, for every device."), as device settings need
  `host.device-settings` (D487). `AGENT_PERMISSIONS` does not get it; the
  owner and devices paired with the owner's grants hold it through `*` or
  `threads.*`. A device whose grants name `threads.read` and
  `threads.write` only keeps its drafts to itself, as with an older node
  (its calls are refused and ignored, D486) or with the switch off (D488).
  A token's grants never change in place (`security.md` D412), so such a
  device gets draft sync by pairing again with "Sync drafts" ticked in the
  pairing dialog, which lists every permission (D424). Pairing presets
  are not in code: a code defaults to its creator's grants (D419).

## Project settings and multi-line text (W42)

W42 of `t3-roadmap.md` (round 5, D1461–D1480) gives settings a project
scope, as T3's per-project settings (`projectSettingsOverrides`,
`packages/shared/src/projectSettings.ts`, and the settings page's scope
sentence, `SettingsScopeSentence.tsx`, `SettingInheritance.tsx`, D53), and
the form its multi-line text. What source control keeps per project, the
checked-in `t3.json` and the scripts are `source-control.md`'s
([W42](source-control.md#project-settings-t3json-and-scripts-w42-d1461d1480)).

- **D1461. Multi-line text.** `.meta({ multiline: true })` on a text field
  renders it as a text area (T3's `Textarea`, rows growing with the text)
  instead of a one-line input; everything else about the field (its
  placeholder, `clearWhenEmpty`, its errors) stays as D80, D478 say.
  Branch naming instructions use it (`source-control.md` D1466).
- **D1462. A section's project settings are its `projects` key.** A section
  that keeps some of its settings per project has a key `projects`: a
  record from a project's id (T3 keys them by id too) to an object of some
  of the section's own top-level keys, each optional, and marks the record
  `.meta({ projectSettings: true })`. A key an entry sets replaces the
  node's value of that key whole (T3: "every other key replaces its
  `ServerSettings` field whole"); a key it leaves out is the node's. A
  project's key may have a schema of its own where T3's does (worktree
  cleanup's Inherit, Off and Custom, `source-control.md` D1468); the plugin
  resolves such a key itself. `@jhin/agent-api` exports
  `projectSettingsRecord(shape)`, the record with the marker, and
  `resolveProjectSettings(config, projectId, keys)`, the section's values
  for a project. The key `projects` and the marker are public API: plugins
  and the settings page build on them. The threads section's settle
  settings (`t3-parity.md` D1173) are one.
- **D1463. The node config page has T3's project scope.** Above the form,
  T3's scope sentence: "Applying settings for [All projects ▾]", the
  projects of the chosen node (T3's project axis; Jhin's node picker is its
  environment axis, D20) with a search. With a project chosen, a section
  with project settings shows every field, and only those its `projects`
  value has edit that project's entry (`projects.<id>.<key>` of the node
  file, saved as any change, D84); the others follow, inert, under
  "Node-wide settings" with T3's words for them ("Node-wide setting. Choose
  All projects to change it.", T3's "Environment-wide setting. Select an
  environment to change it."). A choice the project has no value for, and
  nothing to inherit as its default, offers T3's "Inherit" (worktree
  cleanup's mode); what a reset leaves empty goes, up to the record. A
  project field shows the value it inherits as its default and T3's layers
  button (`SettingInheritance`): Project, Node, `t3.json` for a key it
  backs (`.meta({ t3File: "<field>" })` on the project's key,
  `source-control.md` D1467), Default (the node key's default, else the
  project key's `builtIn`, T3's), the one in effect checked;
  "Reset to inherited value" removes the project's key, and an entry left
  empty goes. A section without project settings says so ("This section
  has no project settings."). With All projects chosen, the `projects`
  record is not a field of its own: each field it holds keys of says in
  its layers button's label how many projects override it (T3's "· N
  project overrides"). The JSON view (D80) still shows the whole file.

## Every section on one page (P4)

The owner asked (2026-10-24) for the node config page to stop making them
pick one section from a dropdown and wait for it. The page shows every section
at once, with the section list under the page's name in the settings
navigation, and a click scrolls to the section. Decisions D1621–D1640
(D1621–D1627 used so far); the speed part continues `loading.md`. It builds on
W42's project scope (D1463) and must land on top of it, never undo it.

- **D1621. Why one section is slow is measured before anything changes.**
  The workstream times `host.config.schema`, `host.config.get` and the
  render of the form on a node with every first-party plugin, names where
  the time goes, and fixes that cause. The PR reports the timings before and
  after.
- **D1622. The page shows every section, in the picker's order.** Each
  section is a settings section of its own, titled as the picker titled it
  (its name in mono next to a title that differs), with its own form or JSON,
  "Edit as JSON", Save and outcomes, as one section had before. The section
  dropdown goes. The node picker, the mesh scope (D20, D50) and W42's
  project scope (D1463) stay above all sections and apply to the whole page.
- **D1623. The sections are listed under "Node config" in the settings
  navigation.** The settings navigation gets sub-entries that a page
  contributes while it is open, with stable ids (`node-config/<section>`).
  It is a contribution shape every settings page can use, not a node config
  special case (AGENTS.md rule 7). A click scrolls the section into view and
  focuses its heading. The entry of the section in view is marked current as
  the page scrolls. The URL hash names the section (`#jhin.web-ui`), so a
  link or a reload opens at it. On a narrow screen, where the navigation
  folds away, the same list is a "Jump to section" menu at the top of the
  page.
- **D1624. All sections are read at once.** A new command
  `host.config.sections` (permission `host.config.read`) returns what
  `host.config.get` returns, keyed by section, for every section or for the
  ones named. It reads each config file and its comments once, not once per
  section. Secrets are redacted as in `host.config.get` (`security.md`
  D417). A node without the command gets one `host.config.get` per
  section, all in flight together, and each section renders as its answer
  lands.
- **D1625. Sections off screen cost little.** A section's form is rendered
  when it comes near the viewport (an `IntersectionObserver` with a margin),
  with a placeholder of its last height before that. The find of the
  browser and the hash link of D1623 still reach every section: a section a
  link or a jump names is rendered first.
- **D1626. Edits belong to their section.** Each section keeps its own
  unsaved edits and saves alone. A change the node reports (D484) rebases
  only the section it covers. Choosing another node, another file (D477) or
  another project scope with unsaved edits asks once, naming the sections
  that would lose their edits. Leaving the page with unsaved edits asks the
  same way.
- **D1627. Nothing of the form itself changes.** Fields, validation, layers,
  comments and the plugin controls stay as W16 built them. Only where the
  forms are placed and how they are loaded changes.

## How to write a config schema (for plugin authors)

The settings page renders the section a plugin declares; the schema is all
it reads.

```ts
const Config = z
  .object({
    host: z.string().default("127.0.0.1").meta({
      title: "Host",
      description: "Interface to listen on; 0.0.0.0 accepts any.",
    }),
    port: z.number().int().min(0).max(65_535).default(7777).describe("0 picks a free port."),
    history: z
      .union([
        z.literal("on-open").meta({ title: "When a thread is opened" }),
        z.literal("eager").meta({ title: "Every thread, eagerly" }),
      ])
      .default("on-open")
      .meta({ title: "Copy threads of other nodes" }),
    tls: z
      .object({
        cert: z.string().optional().meta({ title: "Certificate file" }),
        key: z.string().optional().meta({ title: "Key", writeOnly: true }),
      })
      .optional()
      .meta({ title: "TLS", description: "Serve HTTPS with these files." }),
    trustProxy: z.array(z.string()).default([]).meta({ title: "Trusted proxies", advanced: true }),
  })
  .meta({ title: "HTTP server", description: "Where this node listens." });

context.config.define("acme.http", Config);
```

- Give the section a `title` and `description` with `.meta()` on the object
  you pass to `define`: they are the header of its page.
- Give every field a `title` and a `description` (`.meta({ title,
  description })`; `.describe()` sets only the description). Without them
  the title is the key in sentence case, and the description is whatever
  comment the user wrote above the key in their `config.jsonc`.
- Order the keys of `z.object` as they should appear. Put related keys in a
  nested `z.object`: it gets a header of its own. Give a nested object
  `.optional()` or a `.default()`, so the node file may leave it out.
- Give a field a `.default()` when it has one: the page shows it while the
  key is unset, and "Reset to default" removes the key.
- Prefer `z.enum([...])` or a union of `z.literal(...)` (with a `title`
  each) for choices, `z.boolean()` for switches, `.int()` and bounds for
  numbers: the page renders and checks them. An array of objects is a list
  of groups (D479); a union of objects or `unknown` is edited as JSON in
  place.
- `.meta({ advanced: true })` folds a field the user rarely needs;
  `.meta({ examples: ["…"] })` gives an empty field a placeholder;
  `.meta({ deprecated: true })` marks one on its way out.
- Mark a secret with `.meta({ writeOnly: true })`: it shows as a password
  field, and `host.config.get` returns `••••••` in its place; saving the
  marker back keeps the stored value (`security.md` D417). The value is
  still in the config file in clear.
- Refinements (`.refine`) are checked by the node only: their message shows
  next to the field after a save.
- `.meta({ clearWhenEmpty: "persist" })` keeps an emptied text field as `""`
  instead of removing its key, where an empty value means something (D478).
- `.meta({ when: { mode: "custom" } })` shows a field only while its sibling
  `mode` is `"custom"` (an array lists several values, D481).
- `.meta({ control: "color" })` asks for a control another plugin
  contributes to the slot `settings.config.control.color` with
  `ConfigControlProps`; without one the built-in control shows (D482).
- `.meta({ multiline: true })` makes a text field a text area (D1461).
- Settings a user may set per project go into a `projects` key built with
  `projectSettingsRecord({ … })` from `@jhin/agent-api`, and are read with
  `resolveProjectSettings(config, projectId, keys)`; the settings page then
  offers them in its project scope (D1462, D1463).

## Deferred

- A fan-out through a connected node older than D475: the page sends
  `mesh.config.patch` to its own node, which delivers the change as that
  node's version does (without `edits`, and with `unset` dropped by nodes
  older than D84).
- A secret list item moved in the JSON view takes the stored value of
  its new position: the view shows `<hidden secret>` without the address
  `host.config.get` gives it (`security.md` D417, which redacts secrets
  before they reach the browser). Left by W48 for after P4's rework of
  the page (D1621–D1640).
- A device whose grants lack `threads.drafts` (D1704) is not told why its
  drafts stay on it: the `jhin.sync` section shows no hint when the node
  refuses its draft calls.
- Comments inside a changed array: an array is written whole (D476), so a
  comment between its items is lost when any item changes.
- An explicitly empty text value for a field without
  `clearWhenEmpty: "persist"`: such a field's emptied input removes its key;
  `""` is set through JSON (D478 follows T3, where the schema decides).
- First-party contributed controls: the slot exists (D482), but no
  first-party section asks for a control yet; T3's color and font pickers
  come with the workstreams that port their settings.
- Drafts and device settings through mesh members: a device shares them
  with the nodes it is connected to (D486, D487); two devices that share no
  node do not agree, and a member's `threads/drafts` is not followed.
- Sending a draft again after its node could not take it (D486): the text
  goes to the node when it is typed; if the call fails, the node has it
  only after the next edit of that draft.
- Review notes left from #132 (D486, D487): a text another device saved
  while this composer is in use is kept but shown only when the composer
  opens again (not on blur); two devices sending the same `at` keep the
  first text and the second is not told; `host.device-settings.get` reads a
  damaged file as empty while `patch` refuses it; the per-key draft queue's
  test does not hold a write open to force the interleaving.
- Pruning kept drafts (D486): a node keeps a draft per thread and project
  until it is cleared, also after its thread is deleted.
- Clock skew between devices: a draft's and a device setting's `at` is
  the typing device's clock (D486, D487), so a device whose clock is
  behind loses a change it made after another device's.
- Pasted images of a draft on other devices (D486): attachments stay on
  the device they were pasted on.
- Following a mesh member's `host/config`: a client hears of config
  changes of its connections only (D484); a member's change shows after its
  next read. W17's relayed live streams could carry it.
- Moving items of a list of groups by dragging: "Move up" and "Move down"
  only (D479).

## Landing

One PR. Public API it changes, all additive: `host.config.get` returns
`comments` and, for an invalid section, `issues`; `host.config.patch` and
`mesh.config.patch` take `unset`; `@jhin/kernel` exports `configComments`.
First-party sections (`jhin.example`, `jhin.http`, `jhin.mesh`,
`jhin.threads`, `jhin.storage-sqlite`, `jhin.web-ui`, `jhin.ui`,
`jhin.keybindings`, `jhin.agent-claude`) carry titles and descriptions;
`jhin.mesh`'s `history` is a union of titled literals instead of an enum
(same values), and `jhin.agent-claude`'s `env` is marked `writeOnly` (D83).

**Done when:** every first-party section renders as a form with titles and
descriptions; a boolean, a string and an enum edited and saved land in the
node file with its comments kept; a reset key leaves the file; a wrong value
is reported next to its field and blocks the save; the mesh scope picker
sends the same change (with `unset`) to every target.

The proof:

- `packages/kernel/test/config-comments.test.ts`: comments above keys.
- `apps/web/test/config-form.test.ts`: schema → form mapping, comment
  descriptions, validation, the change a save sends.
- `apps/web/test/node-config.browser.test.tsx` (browser mode): editing a
  switch, a text field and a select, lists, inline errors, resets, inline
  JSON, the node's issues; reading back after a save.
- `packages/node-host/test/host.test.ts`: `comments`, `issues`, titles in
  `host.config.schema`, `unset` keeping comments.
- `plugins/mesh/test/outbox.test.ts`, `apps/jhin/test/mesh-sync.test.ts`:
  `unset` through the mesh and the outbox.
- Playwright `e2e/tests/config.spec.ts` (with screenshots) and the adapted
  "node config editor asks before …" in `e2e/tests/mesh.spec.ts`.

### W16 landing

A stack of PRs, each on the previous one. Public API, all additive:

1. Saving (D475–D477): the command `host.config.edit`; `edits` on
   `mesh.config.patch` and on queued changes; `@jhin/host-api` exports
   `configEdits`, `configChange` and `sendConfigChange`. The proof:
   `packages/host-api/test/config-change.test.ts` (leaf edits, both forms,
   nodes of three ages, a removal an old node would drop refused before
   anything is written), `packages/node-host/test/host.test.ts` ("edits leaf
   paths, keeping the comments inside a changed key"),
   `apps/jhin/test/mesh-sync.test.ts` (edits through the mesh),
   `apps/web/test/node-config.browser.test.tsx` (which file wins, the change
   a save sends) and Playwright "D477: edits the project file" in
   `e2e/tests/config.spec.ts`.
2. The form (D478–D482): `ConfigControlProps` and `configControlSlot` in
   `@jhin/client-api`; `Slot`'s `first` and `useOptionalSlot` in
   `@jhin/ui`; `jhin.keybindings` rules have titles and keep an empty key
   (`clearWhenEmpty: "persist"`). The proof:
   `apps/web/test/config-form.test.ts` (the hints, `shown`, `renameKey`),
   `apps/web/test/config-form-sync.browser.test.tsx` (empty values, a list
   of groups with move, remove, add and required keys, renaming keys,
   conditional fields following the file that wins, a contributed control)
   and Playwright "D479: edits keybinding rules as a list of groups".
3. Pushing config changes (D483, D484): the kernel event and live stream
   `host/config` (`host.config.changed`) served by `jhin.host-streams`; the
   client event `node.config.changed` from `jhin.node-config-feed`. The
   proof: `apps/jhin/test/config-push.test.ts` (sections of which file, no
   event for a write that changes nothing), `apps/web/test/node-config-feed.test.ts`,
   `apps/web/test/machines.browser.test.tsx` (asking again on
   `node.config.changed`), `apps/web/test/node-config.browser.test.tsx`
   (`rebase`) and Playwright "D483, D484: a change made elsewhere reaches the
   open page".
4. Visits shared by every device (D485): `threads.visit`,
   `threads.mark-unread`, `ThreadRecord.lastVisitedAt` and `lastVisitOf` in
   `@jhin/client-api`. The proof: `plugins/threads/test/arrangement.test.ts`
   ("visits shared by every device"), `apps/web/test/thread-status.test.ts`
   ("visits shared through the thread's node").
5. Drafts and device settings across devices (D486–D488):
   `threads.draft.get`, `threads.draft.set` and the stream `threads/drafts`
   (permission `threads.drafts`, D1704);
   `host.device-settings.get`, `host.device-settings.patch` and the stream
   `host/device-settings` (permission `host.device-settings`);
   `client.settings@1.1`; the section `jhin.sync`. The proof:
   `plugins/threads/test/arrangement.test.ts` ("drafts kept for every
   device"), `apps/jhin/test/config-push.test.ts` ("device settings kept for
   the owner's devices"), `apps/web/test/composer.test.ts` ("drafts shared
   through their thread's node"), `apps/web/test/device-sync.test.ts` and
   Playwright `e2e/tests/device-sync.spec.ts`.
