# Jhin — AGENTS.md

## What Jhin is

Jhin is a self-hosted AI harness / meta harness. The application is a small
isomorphic kernel plus a distribution of plugins; UI, transport, auth, storage,
mesh, agents and MCP are all plugins. Users change or extend anything through
config and their own plugins, without forking. T3 Code is the reference for
behaviour, UI and engineering practice.

## Find your way

This file is the trailhead. It does not hold the answers; it points to them.

1. `docs/map.md` — everything Jhin already has, one line each. Read it
   before building anything, so you extend what exists instead of building
   it twice.
2. `docs/README.md` — the context library: which page knows what, how
   knowledge is addressed, and how much to trust it.
3. `GLOSSARY.md` — the vocabulary. Use exactly these words.
4. The plan that owns your area (`docs/plans/`, listed in `docs/README.md`),
   and `docs/plans/t3-roadmap.md` to check whether a workstream already
   builds it.
5. `docs/lore/` — short stories of how agents go wrong. Read them on arrival
   and again after a compaction. In review a name is enough: "moonbase".

Read only the section you need (`docs/plans/terminal.md#deferred`), not
whole files. If something you need is not reachable from here, add the route
in your PR.

## Architecture rules

1. **Nothing product-shaped in the kernel.** The kernel knows plugins,
   capabilities, services, hooks, commands, config, events, disposables and
   state. Threads, transports, UI slots and the mesh live in plugins.
2. **The kernel is isomorphic.** No Node or DOM imports in `@jhin/kernel`;
   module loading goes through an injected adapter.
3. **First-party plugins use only the public API.** If a first-party plugin
   needs something, it becomes public API for everyone.
4. **Depend on capabilities, not plugins** (`ui.sidebar@^1`, never a plugin
   id).
5. **Every registration returns a disposable**; plugin state that must
   survive a reload lives in kernel-scoped state or storage, not in module
   variables.
6. **Every operation is a command** with Zod input/output schemas, so it is
   reachable from RPC, CLI and MCP. No UI-only capabilities.
7. **UI is slots and contributions with stable ids.** Never render a list of
   actions directly; contribute them.
8. **Ids are public API.** Capability ids, command names, slot ids,
   contribution ids and event types are never renamed without a deprecation
   period.

## Verifying your work

Work is done only when it is proven. Prefer the smallest proof:

- run only the affected tests, files and packages locally:
  `vp test run <files>`, `vp check <files>`,
  `vp run --filter <package> typecheck`;
- when the change spans packages, run `pnpm verify --affected` (diffs
  against the merge base with `origin/main`); add `--json` for a
  machine-readable summary;
- leave the full run (`pnpm verify`) to CI unless you changed shared config;
- after changing a `package.json`, `tsconfig.build.json` or anything a
  packed package ships, run `pnpm pack:smoke`: it packs the CLI with its
  workspace packages, installs the tarballs outside the repo and runs them.
  Pack a single package with `node scripts/pack.ts <package-dir> <out.tgz>`;
  a bare `pnpm pack` or `pnpm publish` of a plugin fails on purpose, because
  its manifest would still name TypeScript;
- use the inspector (`jhin inspect`, or the MCP `inspect` tool) to check the
  live state of a node instead of guessing from logs;
- read structured logs by `traceId` when a request crosses nodes.

The dev shell (`devenv`) provides Node 24, pnpm and Playwright browsers;
without nix, `pnpm exec playwright install chromium` inside `e2e/` is enough.

Tests:

- **No `sleep`, polling or timeouts in tests.** Wait for a concrete event, a
  persisted record or a drain. A test that needs a timeout to pass is wrong.
- Use `@jhin/testing` (test kernel, capability mocks, fake transport,
  in-memory mesh) before reaching for real processes and sockets.
- UI: Playwright with role and accessibility-tree locators; component tests
  in Vitest browser mode.

Pull requests:

- One branch per PR, never push to `main` directly.
- The PR description lists the decisions (D-numbers) it implements and
  concrete evidence: commands run with their output, screenshots for UI.
  "Tests pass" alone is not evidence.

## Rules

1. Everything in English: code, comments, docs, commit messages.
2. Conventional Commits.
3. Code derived from T3 Code keeps a header comment naming its origin and is
   covered by `THIRD_PARTY_NOTICES.md`.
4. Anything deferred goes into the "Deferred" section of the relevant plan,
   never silently dropped.
5. Knowledge has one source of truth: link to it, never copy it. A new
   package, plugin, capability or command gets its line in `docs/map.md`, a
   new word goes in `GLOSSARY.md`, and a decision goes in the plan that owns
   the area (`docs/README.md#adding-knowledge`). Files, headings and decision
   numbers others link to are addresses: do not rename them.
