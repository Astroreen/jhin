# Jhin

A self-hosted AI harness built as a microkernel: the application itself is
almost empty, and everything a user sees and runs — UI, protocols,
connections, servers, MCP — is a plugin. Users change or extend any part
through config and their own plugins, without forking the app.

The project is being restarted as a TypeScript monorepo. The previous Java
implementation lives in git history.

- Design and roadmap: [`docs/plans/foundation.md`](docs/plans/foundation.md)
- Vocabulary: [`GLOSSARY.md`](GLOSSARY.md)

Licensed under Apache-2.0. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)
for derived work.
