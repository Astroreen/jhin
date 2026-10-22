# jhin.example

The template for new plugins. Copy this directory, change the `name` and the
`"jhin"` manifest in `package.json`, and edit `src/index.ts`.

It shows every surface of `PluginContext`:

- `config.define` for a validated config section with defaults;
- `services.provide` for a capability listed in `"provides"`;
- `commands.register`, so the command is reachable from RPC, the CLI and MCP:
  `jhin example.greet --name Ada`;
- `hooks.run` to let other plugins change the behaviour;
- `state` that survives a reload;
- `events.emit` and `log`.

## Config on the settings page

Settings → Node config renders every section as a form generated from its
schema (`docs/plans/config-ui.md`), so write the schema for the page:

- `.meta({ title, description })` on the object passed to `config.define`
  is the section's header; on each field, its title and description
  (`.describe()` sets the description alone). A field without one is
  described by the comment above its key in the user's `config.jsonc`.
- Fields follow the order of the `z.object` keys; a nested `z.object` is a
  group with its own header.
- `z.string()` is a text field, `z.boolean()` a switch, `z.number()` a
  number field, `z.enum()` or a union of titled `z.literal()`s a select,
  an array of those a list, `z.record()` a key/value list. Anything else is
  edited as JSON in place.
- `.default()` shows while a key is unset; `.meta({ advanced: true })` folds
  a rarely needed field, `.meta({ examples: [...] })` gives a placeholder,
  `.meta({ writeOnly: true })` marks a secret.

To try a change without restarting, run `jhin serve --watch` and edit
`src/index.ts`: the plugin reloads and keeps its state. Changing the
`"jhin"` manifest, or adding or removing a plugin directory, re-resolves the
plugin graph without a restart.

User plugins live in `~/.jhin/plugins/<name>/` (or `.jhin/plugins/` in a
project). They import `@jhin/sdk` without installing it: the host provides
it. A user plugin with the same id as a distribution plugin replaces it.
