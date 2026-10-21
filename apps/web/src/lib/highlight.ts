import type { HighlighterCore, LanguageInput } from "shiki/core";

/**
 * Syntax highlighting for code blocks, with Shiki as in T3 Code. Grammars and
 * the highlighter load on first use, each language in its own chunk; the
 * JavaScript regex engine needs no WebAssembly.
 */
const LANGUAGES: Record<string, () => Promise<{ default: LanguageInput }>> = {
  c: () => import("shiki/dist/langs/c.mjs"),
  cpp: () => import("shiki/dist/langs/cpp.mjs"),
  csharp: () => import("shiki/dist/langs/csharp.mjs"),
  css: () => import("shiki/dist/langs/css.mjs"),
  dart: () => import("shiki/dist/langs/dart.mjs"),
  diff: () => import("shiki/dist/langs/diff.mjs"),
  docker: () => import("shiki/dist/langs/docker.mjs"),
  elixir: () => import("shiki/dist/langs/elixir.mjs"),
  go: () => import("shiki/dist/langs/go.mjs"),
  graphql: () => import("shiki/dist/langs/graphql.mjs"),
  haskell: () => import("shiki/dist/langs/haskell.mjs"),
  html: () => import("shiki/dist/langs/html.mjs"),
  ini: () => import("shiki/dist/langs/ini.mjs"),
  java: () => import("shiki/dist/langs/java.mjs"),
  javascript: () => import("shiki/dist/langs/javascript.mjs"),
  json: () => import("shiki/dist/langs/json.mjs"),
  jsonc: () => import("shiki/dist/langs/jsonc.mjs"),
  jsx: () => import("shiki/dist/langs/jsx.mjs"),
  kotlin: () => import("shiki/dist/langs/kotlin.mjs"),
  lua: () => import("shiki/dist/langs/lua.mjs"),
  make: () => import("shiki/dist/langs/make.mjs"),
  markdown: () => import("shiki/dist/langs/markdown.mjs"),
  nix: () => import("shiki/dist/langs/nix.mjs"),
  php: () => import("shiki/dist/langs/php.mjs"),
  powershell: () => import("shiki/dist/langs/powershell.mjs"),
  python: () => import("shiki/dist/langs/python.mjs"),
  ruby: () => import("shiki/dist/langs/ruby.mjs"),
  rust: () => import("shiki/dist/langs/rust.mjs"),
  scss: () => import("shiki/dist/langs/scss.mjs"),
  shellscript: () => import("shiki/dist/langs/shellscript.mjs"),
  sql: () => import("shiki/dist/langs/sql.mjs"),
  svelte: () => import("shiki/dist/langs/svelte.mjs"),
  swift: () => import("shiki/dist/langs/swift.mjs"),
  toml: () => import("shiki/dist/langs/toml.mjs"),
  tsx: () => import("shiki/dist/langs/tsx.mjs"),
  typescript: () => import("shiki/dist/langs/typescript.mjs"),
  vue: () => import("shiki/dist/langs/vue.mjs"),
  xml: () => import("shiki/dist/langs/xml.mjs"),
  yaml: () => import("shiki/dist/langs/yaml.mjs"),
  zig: () => import("shiki/dist/langs/zig.mjs"),
};

const ALIASES: Record<string, string> = {
  "c++": "cpp",
  bash: "shellscript",
  cjs: "javascript",
  console: "shellscript",
  cs: "csharp",
  cts: "typescript",
  dockerfile: "docker",
  ex: "elixir",
  exs: "elixir",
  gql: "graphql",
  golang: "go",
  h: "c",
  hpp: "cpp",
  hs: "haskell",
  htm: "html",
  js: "javascript",
  kt: "kotlin",
  makefile: "make",
  md: "markdown",
  mjs: "javascript",
  mts: "typescript",
  patch: "diff",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "shellscript",
  shell: "shellscript",
  ts: "typescript",
  yml: "yaml",
  zsh: "shellscript",
};

/** The grammar for a fence's info string, or undefined for plain text. */
export function languageOf(fence: string | undefined): string | undefined {
  if (fence === undefined) return undefined;
  const name = fence.trim().toLowerCase();
  // Own keys only: a fence named `constructor` must not find Object's.
  const resolved = Object.hasOwn(ALIASES, name) ? ALIASES[name]! : name;
  return Object.hasOwn(LANGUAGES, resolved) ? resolved : undefined;
}

let core: Promise<HighlighterCore> | undefined;
const loading = new Map<string, Promise<void>>();
const cache = new Map<string, string>();
const CACHE_LIMIT = 300;

function highlighter(): Promise<HighlighterCore> {
  core ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/dist/themes/github-light-default.mjs"),
    import("shiki/dist/themes/github-dark-default.mjs"),
  ]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark]) =>
    createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    }),
  );
  return core;
}

const THEMES = {
  themes: { light: "github-light-default", dark: "github-dark-default" },
  defaultColor: false,
} as const;

async function withGrammar(language: string): Promise<HighlighterCore> {
  const instance = await highlighter();
  let load = loading.get(language);
  if (load === undefined) {
    const loader = LANGUAGES[language];
    if (loader === undefined) throw new Error(`No grammar for ${language}`);
    load = loader().then((module) => instance.loadLanguage(module.default));
    loading.set(language, load);
  }
  await load;
  return instance;
}

/** A coloured run of a code's text: offsets into it, and the CSS variables of both themes. */
export interface HighlightedToken {
  readonly from: number;
  readonly to: number;
  readonly style: string;
}

/**
 * The code's coloured runs in both themes, for editors that colour text in place
 * (the composer's code blocks) rather than render Shiki's HTML.
 */
export async function highlightTokens(
  code: string,
  language: string,
): Promise<readonly HighlightedToken[]> {
  const instance = await withGrammar(language);
  const { tokens } = instance.codeToTokens(code, { lang: language, ...THEMES });
  const runs: HighlightedToken[] = [];
  let offset = 0;
  for (const [index, line] of tokens.entries()) {
    // The separator between lines, which Shiki drops: CRLF is two characters, LF or a lone CR one.
    if (index > 0) offset += code.startsWith("\r\n", offset) ? 2 : 1;
    for (const token of line) {
      const style = Object.entries(token.htmlStyle ?? {})
        .map(([name, value]) => `${name}:${value}`)
        .join(";");
      if (style && token.content.trim()) {
        runs.push({ from: offset, to: offset + token.content.length, style });
      }
      offset += token.content.length;
    }
  }
  return runs;
}

/** HTML of the code highlighted in both themes (CSS variables `--shiki-light` / `--shiki-dark`). */
export async function highlight(code: string, language: string): Promise<string> {
  const key = `${language}\u0000${code}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const instance = await withGrammar(language);
  const html = instance.codeToHtml(code, { lang: language, ...THEMES });
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, html);
  return html;
}
