---
name: jhin-map
description: Before you add a plugin, capability, command, package or UI piece to Jhin, open this — Jhin probably already has most of it, and this shows where. Also the way in to Jhin's decisions (D-numbers), vocabulary, running workstreams and the lore of how agents go wrong here.
---

# Jhin map

Jhin knows more than you do about Jhin. Use what it knows before you write
code.

1. Read `docs/map.md`: every package, plugin, capability and command, one
   line each, with the plan that owns it. If what you are about to build is
   close to a line there, extend that instead.
2. Not there? Check the workstream table in `docs/plans/t3-roadmap.md`; one
   of W1–W18 may be building it right now.
3. Need the why? Follow the map's route to the owning plan and read only
   that section (`docs/plans/<plan>.md#<heading>`, or search `**D<n>.` for a
   decision).
4. Unsure about a word? `GLOSSARY.md`.
5. About to add one more reasonable thing nobody asked for? Read
   `docs/lore/doghouse-moonbase.md` first.

`docs/README.md` explains how the library is arranged, how far to trust each
kind of page, and where new knowledge goes. When you add something, add its
route: a line in `docs/map.md`, a word in `GLOSSARY.md`, a decision in the
owning plan.
