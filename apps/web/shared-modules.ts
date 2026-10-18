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

/** Where the dev server serves a virtual module (Vite's URL form of a `\0` id). */
const devUrl = (name: string) => `/@id/__x00__${PREFIX}${name}`;

/**
 * One module per shared package, and an import map in index.html that points
 * the bare names at them. The app imports the same packages, so
 * runtime-loaded plugins and the app share one instance of each.
 *
 * - `vp build`: each shared module is a build entry.
 * - `vp dev`: each is a virtual module the dev server serves; its imports are
 *   rewritten to the very URLs the app's imports get, so the instances are
 *   shared there too.
 */
export function sharedModules(): Plugin {
  return {
    name: "jhin-shared-modules",
    config(_config, { command }) {
      if (command === "serve") {
        // Pre-bundled up front: discovering one when a plugin first imports it
        // would make the dev server reload the page.
        const cjs = Object.keys(SHARED).filter((name) => SHARED[name] === "cjs");
        return { optimizeDeps: { include: cjs } };
      }
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
      if (id.startsWith(PREFIX)) return `\0${id}`;
      // The dev server's `/@id/__x00__…` URLs arrive already resolved.
      return id.startsWith(`\0${PREFIX}`) ? id : undefined;
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
        const imports: Record<string, string> = {};
        const bundle = context.bundle ?? {};
        for (const name of Object.keys(SHARED)) {
          if (context.server !== undefined) {
            imports[name] = devUrl(name);
            continue;
          }
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
