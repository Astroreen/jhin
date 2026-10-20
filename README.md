# Jhin

A self-hosted AI harness built as a microkernel: the application itself is
almost empty, and everything a user sees and runs — UI, protocols,
connections, servers, MCP — is a plugin. Users change or extend any part
through config and their own plugins, without forking the app.

The project is being restarted as a TypeScript monorepo. The previous Java
implementation lives in git history.

- Start here: [`docs/README.md`](docs/README.md) — the map of everything
  Jhin knows about itself
- What exists: [`docs/map.md`](docs/map.md)
- Design and roadmap: [`docs/plans/foundation.md`](docs/plans/foundation.md),
  [`docs/plans/t3-roadmap.md`](docs/plans/t3-roadmap.md)
- Vocabulary: [`GLOSSARY.md`](GLOSSARY.md)
- Running from a checkout: [`scripts/t3/README.md`](scripts/t3/README.md)

Licensed under Apache-2.0. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)
for derived work.
