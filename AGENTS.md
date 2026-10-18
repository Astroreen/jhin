# Jhin — AGENTS.md

## What Jhin is

Jhin is a self-hosted AI harness / meta harness. The application is a small
kernel plus a distribution of plugins; UI, protocols, connections, servers and
MCP are all plugins. Users customise it in layers (distribution → user →
workspace) instead of forking.

## Direction

- **Language:** TypeScript on both backend and frontend.
- **Split:** backend and frontend are independent parts talking over a
  schema-defined protocol; the client can connect to many backend servers at
  once.
- **Clients:** one web frontend (DOM-based, so AI can inspect it with
  Playwright / DevTools); desktop via Electron, mobile via Capacitor.
- **Kernel:** loader, registry of extension points, lifecycle, bootstrap
  transport, permissions, and state that survives plugin reload. Nothing
  product-shaped lives in the kernel.
- **Plugins:** hot reloadable; every registration returns a disposable.
  First-party plugins use only the public API. UI is declared as slots and
  contributions with stable IDs, so anything can be hidden, reordered or
  replaced. Behaviour changes go through named hooks.
- **Testability:** unit, e2e and visual checks must all be runnable by an AI
  agent; a fake LLM provider with record/replay keeps tests deterministic.

## Rules

1. Everything in English — code, comments, docs and commit messages.
2. Keep the kernel minimal; derive the plugin API from real first-party
   plugins rather than designing it up front.

## Execution state

The repository was wiped for the restart; the old Java implementation is in
git history. No code exists yet.
