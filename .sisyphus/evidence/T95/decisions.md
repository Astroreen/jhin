# T95 — decisions and verification notes

Upstream reference: `/tmp/opencode/t3code`, commit `37de6cb`
(`refactor(server): share one keyed lock that releases idle keys (#15577)`).
Every ported value was re-read from that checkout before coding.

## §15.9 answered — the narrow-layout breakpoint

The exact breakpoint is **768 px** (plan target confirmed): below it the
sidebar overlays as a drawer (`openMobile` state, fading backdrop, tap or
swipe to close), the right panel is hidden, the gutters compress to 0.5rem,
the topbar swaps to `topbarCompact` (breadcrumb condensed to the current
title) and the terminal drawer caps at 40% of the viewport height. The
golden set includes the narrow-viewport case
(`evidence/T95/goldens/shell-chrome-narrow.png`, 700×800). The old shell
default of 900 (docs/sdui.md §2.6, T65) is superseded; the docs table now
says 768. The 208 + 640 = 848 px split minimum (§15.9's concern) never
engages below 768 px because the sidebar is a drawer there — the split
lands in T96 inside the wide layout only.

## Plan-vs-upstream discrepancies (plan wins; recorded)

1. **Wordmark placement.** Upstream keeps the brand mark in the *sidebar*
   header (`SidebarChrome.tsx:125-140`); the plan's topbar carries it
   (plan T95 step 1). Implemented per plan: the topbar row leads with the
   bold `Jhin` wordmark text.
2. **Gutter steps.** Upstream: `--workspace-gutter` 0.75rem base, 1.25rem at
   Tailwind `sm` = 640 px (`index.css:134-139`). The plan's narrow rule
   (0.5rem below 768 px) has no upstream equivalent (upstream phones keep
   0.75rem). Implemented per plan: <768 px → 0.5rem, ≥768 px → the `sm`
   step 1.25rem; the 0.75rem base step stays in the token for other
   consumers.
3. **Stage backdrop art.** Upstream is SVG line art (blueprint/nightly,
   `SidebarStageBackdrop.tsx:100-391`) driven by 11 `--stage-art-*` tokens;
   the plan's port is the 5-token gradient (`top/mid/bottom/highlight/line`)
   under the fade mask. The gradient runs deep-at-top → light-at-bottom
   exactly like the upstream paper gradient (`index.css` DevBlueprintArt
   `linearGradient` stop order: bottom, mid, top); `highlight` paints the
   2 px top band (the ruler highlight), `line` the 1 px bottom rule. The
   grid/annotation detail is not ported (no image primitive; T119 may
   revisit).
4. **`--sidebar-stage-fade` semantics.** Upstream resolves it to a *color*
   the art fades into (`index.css:1124`, `var(--sidebar)`); the Jhin port
   implements the fade as a dstIn alpha mask over the lower half of the
   80 px band — the same visual dissolve without needing the underlying
   surface color.
5. **Topbar scroll fade.** Upstream masks the *scrolling content* under the
   topbar (`topbar-scroll-fade`, `index.css:420-457`, worn by the timeline
   at `MessagesTimeline.tsx:1377`). The shell applies the same seven-stop
   band (T92's `kScrollFadeTopbar*` constants) over the body region
   whenever a topbar slot is present.
6. **Safe-area insets.** Upstream `env(safe-area-inset-*)` inside
   `calc()` (`index.css:122-123`, `pl-safe`/`pr-safe` at
   `index.css:1037-1042`); ported as `MediaQuery.padding` added to the
   gutters (the `jhinSafeAreaPadding` semantics, T87).
7. **Level-1 downgrade.** The shell → container fold now carries the four
   new chrome slots into the children in order (topbar, topbarCompact,
   header, pageHeader, sidebar, body, detail, terminal, rail);
   `stageBackdrop` is a non-universal prop and drops with the rest.

## Delivery shape

- `theme.stageArt` (bootstrap, level 2+): the five `stage-art-*` tokens of
  the selected catalogue theme as `#RRGGBB` hex, converted server-side
  through the pinned `Oklch` engine (`ThemeCatalog.Theme.stageArtHex`).
  The client parses hex only — no OKLCH parser needed client-side.
- Shell slots: `topbar`, `topbarCompact`, `pageHeader`, `terminal` (nodes)
  + `stageBackdrop` (bool). The builder whitelist rejects unknown slot
  names at build time (`ShellBuilder.set`), proven by
  `ShellScreenTest.unknownSlotNameIsRejectedAtBuild` and the `--fail`
  probe.
- `motion.panel` + `easeDrawer` drive the wide sidebar collapse
  (AnimatedContainer) and the narrow drawer slide (AnimatedPositioned);
  reduced motion collapses both to 0 (the JhinDesignScope contract).
  Default `motion.panel` is 0, so the T65 gallery goldens are untouched
  except the intentional narrow-rule change below.
- Intentional golden change: `frontend/test/gallery/goldens/shell-narrow.png`
  regenerated — the right panel is now hidden below the breakpoint (plan
  step 7), which shifts the T65 narrow render. The wide golden and the
  fixture-shell-* gallery goldens are byte-identical.

## Environment note

Tool outputs on this host mangle long decimal literals in *displayed* file
content (a DLP-style filter replaces digit runs with placeholders); the
files on disk are intact (verified with `grep -c` / `git status`). No T95
value was affected — the touched constants are short decimals that survive
the filter.
