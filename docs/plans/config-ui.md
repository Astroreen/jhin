# Config UI plan

Status: **implemented**. This file records how the settings page edits a
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
  (`.meta({ writeOnly: true })`). The form renders them as password fields
  and never shows them in clear, an override from the project file included.
  `host.config.get` still returns the files as written (so the JSON view and
  `host.config.read` see them); redacting them there stays deferred, as the
  Deferred list of `t3-parity.md` says. No first-party section has a secret.

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
  numbers: the page renders and checks them. A union of objects, `unknown`
  or an array of objects is edited as JSON in place.
- `.meta({ advanced: true })` folds a field the user rarely needs;
  `.meta({ examples: ["…"] })` gives an empty field a placeholder;
  `.meta({ deprecated: true })` marks one on its way out.
- Mark a secret with `.meta({ writeOnly: true })`: it shows as a password
  field. `host.config.get` still returns it to anyone holding
  `host.config.read`, so keep real secrets out of config until redaction
  lands (Deferred).
- Refinements (`.refine`) are checked by the node only: their message shows
  next to the field after a save.

## Deferred

- Redacting secrets in `host.config.get` and keeping them when the JSON view
  saves (see `t3-parity.md`); the marker (D83) is in place.
- Arrays of objects (keybinding rules) as lists of groups: edited as JSON
  today.
- Comments inside a changed top-level key: a save rewrites that key's value
  whole, so comments inside a nested object that changed are lost. Patching
  leaf paths would keep them.
- Editing the project layer from the page: the form writes the node layer;
  a value the project file sets is shown as overriding it.
- Explicitly empty values: an emptied text or number field unsets its key;
  an empty string is set through JSON.
- Renaming a key of a record in place (remove it and add it again).
- Custom field controls contributed by plugins (a color picker, a path
  picker) and fields shown only when another field has a value.

## Landing

One PR. Public API it changes, all additive: `host.config.get` returns
`comments` and, for an invalid section, `issues`; `host.config.patch` and
`mesh.config.patch` take `unset`; `@jhin/kernel` exports `configComments`.
First-party sections (`jhin.example`, `jhin.http`, `jhin.mesh`,
`jhin.threads`, `jhin.storage-sqlite`, `jhin.web-ui`, `jhin.ui`,
`jhin.keybindings`) carry titles and descriptions; `jhin.mesh`'s `history`
is a union of titled literals instead of an enum (same values).

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
