# Jhin — AGENTS.md

## What Jhin is

Jhin is a self-hosted AI harness / meta harness. The application is a small
isomorphic kernel plus a distribution of plugins; UI, transport, auth, storage,
mesh, agents and MCP are all plugins. Users change or extend anything through
config and their own plugins, without forking. T3 Code is the reference for
behaviour, UI and engineering practice.

Read these before working:

- `docs/plans/foundation.md` — every design decision (D1–D52), what is
  deferred, and the PR plan with acceptance criteria.
- `GLOSSARY.md` — the vocabulary. Use exactly these words.

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

- run only the affected tests, files and packages locally;
- leave repo-wide runs to CI, or run `verify --affected` when the change
  spans packages;
- use the inspector (`jhin inspect`, or the MCP `inspect` tool) to check the
  live state of a node instead of guessing from logs;
- read structured logs by `traceId` when a request crosses nodes.

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

The tooling commands (`vp`, `verify`) arrive with the monorepo skeleton
(PR 2 of the foundation plan).

## Rules

1. Everything in English: code, comments, docs, commit messages.
2. Conventional Commits.
3. Code derived from T3 Code keeps a header comment naming its origin and is
   covered by `THIRD_PARTY_NOTICES.md`.
4. Anything deferred goes into the "Deferred" section of the relevant plan,
   never silently dropped.
