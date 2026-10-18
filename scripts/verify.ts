// Runs every check an agent or CI needs, in order, and prints a summary.
//
//   node scripts/verify.ts              full run
//   node scripts/verify.ts --affected   only what changed since the merge base with origin/main
//   node scripts/verify.ts --json       print the summary as JSON (machine-readable)
//   node scripts/verify.ts --skip e2e   skip a step (repeatable)

import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Path from "node:path";

interface Step {
  readonly name: string;
  readonly command: readonly string[];
}

interface StepResult {
  readonly name: string;
  readonly command: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly durationMs: number;
  readonly reason?: string;
}

const ROOT = Path.resolve(import.meta.dirname, "..");
const WORKSPACE_GLOBS = ["packages", "plugins", "apps"];
const SINGLE_WORKSPACES = ["e2e"];
// A change to any of these can affect every package.
const GLOBAL_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "vite.config.ts",
  "knip.jsonc",
  "tsconfig.build.json",
  "scripts/verify.ts",
]);
// A change to any of these can break the packed CLI (scripts/pack-smoke.ts).
const PACKING = /(^|\/)(package\.json|tsconfig\.build\.json)$|^scripts\/pack-/;

const args = process.argv.slice(2);
const affected = args.includes("--affected");
const json = args.includes("--json");
const skipped = new Set(args.flatMap((arg, index) => (arg === "--skip" ? [args[index + 1]] : [])));

function git(...gitArgs: string[]): string {
  return ChildProcess.execFileSync("git", gitArgs, { cwd: ROOT, encoding: "utf8" }).trim();
}

function mergeBase(): string {
  for (const ref of ["origin/main", "main"]) {
    try {
      return git("merge-base", "HEAD", ref);
    } catch {
      // try the next ref
    }
  }
  throw new Error("verify --affected: no origin/main or main to diff against");
}

function changedFiles(base: string): string[] {
  const lines = [
    git("diff", "--name-only", base),
    git("ls-files", "--others", "--exclude-standard"),
  ].join("\n");
  return [...new Set(lines.split("\n").filter(Boolean))];
}

interface Workspace {
  readonly dir: string;
  readonly name: string;
  readonly dependsOn: readonly string[];
}

function readWorkspace(dir: string): Workspace | undefined {
  const manifestPath = Path.join(ROOT, dir, "package.json");
  if (!Fs.existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(Fs.readFileSync(manifestPath, "utf8"));
  const deps = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
  };
  const dependsOn = Object.entries(deps)
    .filter(([, spec]) => String(spec).startsWith("workspace:"))
    .map(([name]) => name);
  return { dir, name: manifest.name, dependsOn };
}

function workspaces(): Workspace[] {
  const dirs = [
    ...WORKSPACE_GLOBS.flatMap((parent) =>
      Fs.existsSync(Path.join(ROOT, parent))
        ? Fs.readdirSync(Path.join(ROOT, parent)).map((child) => `${parent}/${child}`)
        : [],
    ),
    ...SINGLE_WORKSPACES,
  ];
  return dirs.flatMap((dir) => readWorkspace(dir) ?? []);
}

/** Workspaces containing a changed file, plus everything depending on them. */
function affectedWorkspaces(files: readonly string[], all: readonly Workspace[]): Set<string> {
  const touched = new Set(
    all.filter((ws) => files.some((file) => file.startsWith(`${ws.dir}/`))).map((ws) => ws.name),
  );
  let grew = true;
  while (grew) {
    grew = false;
    for (const ws of all) {
      if (!touched.has(ws.name) && ws.dependsOn.some((dep) => touched.has(dep))) {
        touched.add(ws.name);
        grew = true;
      }
    }
  }
  return touched;
}

function plan(): { steps: Step[]; skippedSteps: StepResult[] } {
  const full: Step[] = [
    { name: "check", command: ["vp", "check"] },
    { name: "typecheck", command: ["vp", "run", "-r", "typecheck"] },
    { name: "unit", command: ["vp", "test", "run"] },
    { name: "knip", command: ["knip", "--no-config-hints"] },
    { name: "e2e", command: ["pnpm", "e2e"] },
    { name: "pack", command: ["node", "scripts/pack-smoke.ts"] },
  ];
  if (!affected) return { steps: full, skippedSteps: [] };

  const base = mergeBase();
  const files = changedFiles(base);
  const skip = (name: string, reason: string): StepResult => ({
    name,
    command: "",
    status: "skipped",
    durationMs: 0,
    reason,
  });
  if (files.length === 0) {
    return { steps: [], skippedSteps: full.map((step) => skip(step.name, "no changes")) };
  }
  if (files.some((file) => GLOBAL_FILES.has(file))) return { steps: full, skippedSteps: [] };

  const all = workspaces();
  const names = [...affectedWorkspaces(files, all)];
  const existing = files.filter((file) => Fs.existsSync(Path.join(ROOT, file)));
  const codeChanged = files.some((file) => !file.endsWith(".md"));

  const steps: Step[] = [];
  const skippedSteps: StepResult[] = [];
  if (existing.length > 0) {
    steps.push({
      name: "check",
      command: ["vp", "check", "--no-error-on-unmatched-pattern", ...existing],
    });
  } else {
    skippedSteps.push(skip("check", "only deletions"));
  }
  if (names.length > 0) {
    steps.push({
      name: "typecheck",
      command: ["vp", "run", ...names.flatMap((name) => ["--filter", name]), "typecheck"],
    });
  } else {
    skippedSteps.push(skip("typecheck", "no workspace touched"));
  }
  steps.push({
    name: "unit",
    command: ["vp", "test", "run", "--changed", base, "--passWithNoTests"],
  });
  steps.push({ name: "knip", command: ["knip", "--no-config-hints"] });
  if (codeChanged) {
    steps.push({ name: "e2e", command: ["pnpm", "e2e"] });
  } else {
    skippedSteps.push(skip("e2e", "only Markdown changed"));
  }
  if (files.some((file) => PACKING.test(file))) {
    steps.push({ name: "pack", command: ["node", "scripts/pack-smoke.ts"] });
  } else {
    skippedSteps.push(skip("pack", "no manifest or build config changed"));
  }
  return { steps, skippedSteps };
}

function run(step: Step): StepResult {
  const started = performance.now();
  const [bin, ...rest] = step.command;
  const result = ChildProcess.spawnSync(bin!, rest, {
    cwd: ROOT,
    // In --json mode stdout is reserved for the summary.
    stdio: json ? ["ignore", process.stderr, process.stderr] : "inherit",
    env: {
      ...process.env,
      PATH: `${Path.join(ROOT, "node_modules/.bin")}${Path.delimiter}${process.env.PATH}`,
    },
  });
  return {
    name: step.name,
    command: step.command.join(" "),
    status: result.status === 0 ? "passed" : "failed",
    durationMs: Math.round(performance.now() - started),
  };
}

const { steps, skippedSteps } = plan();
const results: StepResult[] = [...skippedSteps];
for (const step of steps) {
  if (skipped.has(step.name)) {
    results.push({
      name: step.name,
      command: step.command.join(" "),
      status: "skipped",
      durationMs: 0,
      reason: "--skip",
    });
    continue;
  }
  if (!json) console.log(`\n▶ ${step.name}: ${step.command.join(" ")}`);
  results.push(run(step));
}

const ok = results.every((result) => result.status !== "failed");
if (json) {
  console.log(
    JSON.stringify({ ok, mode: affected ? "affected" : "full", steps: results }, null, 2),
  );
} else {
  console.log("\nverify summary");
  for (const result of results) {
    const mark = result.status === "passed" ? "✓" : result.status === "failed" ? "✗" : "-";
    const detail = result.reason ? ` (${result.reason})` : ` ${result.durationMs}ms`;
    console.log(`  ${mark} ${result.name}${detail}`);
  }
  console.log(ok ? "\nverify: passed" : "\nverify: FAILED");
}
process.exit(ok ? 0 : 1);
