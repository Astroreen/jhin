import * as Module from "node:module";

import type { Plugin } from "vite";

const require = Module.createRequire(import.meta.url);

/**
 * Packages user client plugins import by bare name and share with the app
 * (D16). ESM packages re-export everything; CommonJS ones get their export
 * names listed at build time, since an ES module needs them statically.
 */
const SHARED: Record<string, "esm" | "cjs"> = {
  react: "cjs",
  "react/jsx-runtime": "cjs",
  "react-dom": "cjs",
  "react-dom/client": "cjs",
  "@jhin/sdk": "esm",
  "@jhin/ui": "esm",
  "@jhin/client-api": "esm",
};

const PREFIX = "virtual:jhin-shared:";
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const entryName = (name: string) => `shared/${name.replaceAll("@", "").replaceAll("/", "-")}`;

/**
 * Builds one entry module per shared package and writes an import map into
 * index.html that points the bare names at them. The app imports the same
 * packages, so runtime-loaded plugins and the app share one instance of each.
 * Build only: under `vp dev`, runtime plugins cannot resolve bare names.
 */
export function sharedModules(): Plugin {
  return {
    name: "jhin-shared-modules",
    apply: "build",
    config() {
      return {
        build: {
          rollupOptions: {
            input: {
              index: "index.html",
              ...Object.fromEntries(
                Object.keys(SHARED).map((name) => [entryName(name), `${PREFIX}${name}`]),
              ),
            },
            preserveEntrySignatures: "exports-only",
          },
        },
      };
    },
    resolveId(id) {
      return id.startsWith(PREFIX) ? `\0${id}` : undefined;
    },
    load(id) {
      if (!id.startsWith(`\0${PREFIX}`)) return undefined;
      const name = id.slice(PREFIX.length + 1);
      const quoted = JSON.stringify(name);
      if (SHARED[name] === "esm") return `export * from ${quoted};`;
      const names = Object.keys(require(name) as object).filter(
        (key) => key !== "default" && IDENTIFIER.test(key),
      );
      return `import shared from ${quoted};\nexport default shared;\nexport const { ${names.join(", ")} } = shared;\n`;
    },
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        const bundle = context.bundle ?? {};
        const imports: Record<string, string> = {};
        for (const name of Object.keys(SHARED)) {
          const chunk = Object.values(bundle).find(
            (output) =>
              output.type === "chunk" && output.isEntry && output.name === entryName(name),
          );
          if (chunk === undefined) throw new Error(`No shared entry was built for ${name}`);
          imports[name] = `/${chunk.fileName}`;
        }
        const map = `<script type="importmap">${JSON.stringify({ imports })}</script>`;
        // An import map must come before every module script.
        return html.replace(/<script type="module"/, `${map}\n    <script type="module"`);
      },
    },
  };
}
