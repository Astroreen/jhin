// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/composerCodeBlockHighlight.ts.
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { languageOfInfoString } from "../../lib/code-languages.ts";
import { type HighlightedToken, highlightTokens, languageOf } from "../../lib/highlight.ts";

const highlightKey = new PluginKey<DecorationSet>("composerCodeBlockHighlight");

/**
 * Any edit changes a block's signature, so each keystroke tokenizes the whole
 * block again on the main thread: fine for a few hundred lines, a stall at
 * thousands (D841).
 */
const MAX_HIGHLIGHTED_CODE_BLOCK_LENGTH = 20_000;

/** The class that picks the active theme's colour from a token's two (`theme.css`). */
const CODE_TOKEN_CLASS_NAME = "composer-code-token";

interface Block {
  readonly node: ProseMirrorNode;
  readonly pos: number;
  /** The grammar, or undefined for plain text. */
  readonly language: string | undefined;
  readonly signature: string;
}

/** The composer's code blocks, which are always top-level: lists and quotes cannot hold one. */
function codeBlocks(state: EditorState): Block[] {
  const blocks: Block[] = [];
  state.doc.forEach((node, pos) => {
    if (node.type.name !== "codeBlock") return;
    if (node.textContent.length > MAX_HIGHLIGHTED_CODE_BLOCK_LENGTH) return;
    const language = languageOf(languageOfInfoString(String(node.attrs["language"] ?? "")));
    if (language === undefined) return;
    blocks.push({ node, pos, language, signature: `${language}\u0000${node.textContent}` });
  });
  return blocks;
}

/**
 * The blocks' decorations from the cache. A block whose new text is still being
 * tokenized keeps its previous colours, mapped through the edit, so typing does
 * not flash it plain.
 */
function decorations(
  state: EditorState,
  cache: Map<string, readonly HighlightedToken[]>,
  previous: DecorationSet = DecorationSet.empty,
) {
  const found: Decoration[] = [];
  for (const { node, pos, signature } of codeBlocks(state)) {
    const tokens = cache.get(signature);
    if (tokens === undefined) {
      found.push(...previous.find(pos + 1, pos + node.nodeSize - 1));
      continue;
    }
    // Token offsets index the block's text, which lines up with positions only
    // while the block is one unmarked text node.
    if (node.content.size !== node.textContent.length) continue;
    for (const token of tokens) {
      found.push(
        Decoration.inline(pos + 1 + token.from, pos + 1 + token.to, {
          class: CODE_TOKEN_CLASS_NAME,
          style: token.style,
        }),
      );
    }
  }
  return DecorationSet.create(state.doc, found);
}

export const ComposerCodeBlockHighlight = Extension.create({
  name: "composerCodeBlockHighlight",

  addProseMirrorPlugins() {
    // Bounded by the document: each scan drops the signatures it no longer holds.
    const cache = new Map<string, readonly HighlightedToken[]>();
    let live = new Set<string>();
    return [
      new Plugin<DecorationSet>({
        key: highlightKey,
        state: {
          init: (_config, state) => decorations(state, cache),
          apply(tr, value, _old, next) {
            const mapped = value.map(tr.mapping, tr.doc);
            if (!tr.docChanged && !tr.getMeta(highlightKey)) return mapped;
            return decorations(next, cache, mapped);
          },
        },
        props: {
          decorations: (state) => highlightKey.getState(state),
        },
        view(view) {
          let disposed = false;
          // Per view: a view the editor replaced must not leave its requests to the new one.
          const inFlight = new Set<string>();
          let scanned: ProseMirrorNode | undefined;
          const refresh = () => {
            // A selection change cannot alter what needs tokenizing.
            if (view.state.doc === scanned) return;
            scanned = view.state.doc;
            const blocks = codeBlocks(view.state);
            live = new Set(blocks.map((block) => block.signature));
            for (const signature of cache.keys()) if (!live.has(signature)) cache.delete(signature);
            const pending = blocks.filter(
              (block) => !cache.has(block.signature) && !inFlight.has(block.signature),
            );
            if (pending.length === 0) return;
            // Each block repaints as soon as its own tokens arrive; a slow grammar holds back no other.
            for (const { node, language, signature } of pending) {
              // Identical blocks share a signature: one tokenize serves them all.
              if (inFlight.has(signature)) continue;
              inFlight.add(signature);
              // A grammar that fails to load leaves the block plain, once, not on every keystroke.
              void highlightTokens(node.textContent, language!)
                .catch(() => [])
                .then((tokens) => {
                  inFlight.delete(signature);
                  // A block edited away meanwhile is not put back.
                  if (disposed || !live.has(signature)) return;
                  cache.set(signature, tokens);
                  view.dispatch(view.state.tr.setMeta(highlightKey, true));
                });
            }
          };
          refresh();
          return {
            update: refresh,
            destroy() {
              disposed = true;
            },
          };
        },
      }),
    ];
  },
});
