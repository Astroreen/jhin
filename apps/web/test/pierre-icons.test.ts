// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/pierre-icons.test.ts.
import { describe, expect, it } from "vite-plus/test";

import {
  T3_PIERRE_ICONS,
  resolvePierreIconForEntry,
  syntheticFileNameForLanguageId,
} from "../src/lib/pierre-icons.ts";

describe("T3's file icons (D923)", () => {
  it("uses Pierre's file name and complete-set extension icons", () => {
    expect(resolvePierreIconForEntry("Dockerfile", "file")?.token).toBe("docker");
    expect(resolvePierreIconForEntry("src/Button.tsx", "file")?.token).toBe("react");
    expect(resolvePierreIconForEntry("vite.config.ts", "file")?.token).toBe("vite");
    expect(resolvePierreIconForEntry("package.json", "file")?.name).toBe("file-tree-builtin-npm");
    expect(resolvePierreIconForEntry("config/tsconfig.json", "file")?.name).toBe(
      "file-tree-builtin-typescript",
    );
  });

  it("adds T3's own icons", () => {
    expect(resolvePierreIconForEntry("AGENTS.md", "file")?.name).toBe("t3-file-icon-agents");
    expect(resolvePierreIconForEntry("pnpm-lock.yaml", "file")?.name).toBe("t3-file-icon-pnpm");
    expect(resolvePierreIconForEntry("clip.mp4", "file")?.name).toBe("t3-file-icon-video");
    expect(resolvePierreIconForEntry("Main.kt", "file")?.name).toBe("t3-file-icon-kotlin");
  });

  it("ships every icon of its own that it names", () => {
    const own = [
      ...Object.values(T3_PIERRE_ICONS.byFileName),
      ...Object.values(T3_PIERRE_ICONS.byFileExtension),
    ].filter((name) => name.startsWith("t3-"));
    for (const name of new Set(own)) expect(T3_PIERRE_ICONS.spriteSheet).toContain(`id="${name}"`);
  });

  it("falls back to Pierre's default for an unknown type, and to Lucide's for a folder", () => {
    expect(resolvePierreIconForEntry("artifact.unknown-ext", "file")?.token).toBe("default");
    expect(resolvePierreIconForEntry("packages/client", "directory")).toBeNull();
  });
});

describe("a code language's file icon (D1346, T3's syntheticFileNameForLanguageId)", () => {
  it("names a file in that language", () => {
    expect(syntheticFileNameForLanguageId("typescript")).toBe("file.ts");
    expect(syntheticFileNameForLanguageId("TypeScript")).toBe("file.ts");
    expect(syntheticFileNameForLanguageId("python")).toBe("file.py");
    expect(syntheticFileNameForLanguageId("shellscript")).toBe("file.sh");
    expect(syntheticFileNameForLanguageId("dockerfile")).toBe("Dockerfile");
    expect(syntheticFileNameForLanguageId("go")).toBe("file.go");
    expect(resolvePierreIconForEntry(syntheticFileNameForLanguageId("python"), "file")?.name).toBe(
      resolvePierreIconForEntry("main.py", "file")?.name,
    );
  });
});
