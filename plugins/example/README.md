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

To try a change without restarting, run `jhin serve --watch` and edit
`src/index.ts`: the plugin reloads and keeps its state. Changing the
`"jhin"` manifest, or adding or removing a plugin directory, re-resolves the
plugin graph without a restart.

User plugins live in `~/.jhin/plugins/<name>/` (or `.jhin/plugins/` in a
project). They import `@jhin/sdk` without installing it: the host provides
it. A user plugin with the same id as a distribution plugin replaces it.
