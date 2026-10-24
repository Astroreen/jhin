import { describe, expect, it } from "vite-plus/test";

import {
  PERMISSIONS_DESCRIBE_HOOK,
  describePermissions,
  holdsPermission,
  intersectPermissions,
  isGrant,
  missingPermissions,
  shellAccessText,
  type Hooks,
  type PermissionEntry,
} from "../src/index.ts";

describe("permissions (security.md D410)", () => {
  it("covers a permission by itself, by its namespace pattern and by *", () => {
    expect(holdsPermission(["git.read"], "git.read")).toBe(true);
    expect(holdsPermission(["git.*"], "git.read")).toBe(true);
    expect(holdsPermission(["git.*"], "git")).toBe(true);
    expect(holdsPermission(["git.*"], "git.remote.push")).toBe(true);
    expect(holdsPermission(["*"], "anything.at-all")).toBe(true);
  });

  it("covers nothing else", () => {
    expect(holdsPermission(["git.read"], "git.write")).toBe(false);
    expect(holdsPermission(["git.*"], "github.read")).toBe(false);
    expect(holdsPermission(["git.read"], "git.*")).toBe(false);
    expect(holdsPermission(["git.*"], "*")).toBe(false);
    expect(holdsPermission([], "git.read")).toBe(false);
  });

  it("lists what a caller misses, in order", () => {
    expect(missingPermissions(["threads.read"], ["threads.read", "threads.write", "x"])).toEqual([
      "threads.write",
      "x",
    ]);
    expect(missingPermissions(["*"], ["threads.write"])).toEqual([]);
  });

  it("intersects two lists of grants to what passes both", () => {
    expect(intersectPermissions(["*"], ["git.*", "threads.read"])).toEqual([
      "git.*",
      "threads.read",
    ]);
    expect(intersectPermissions(["git.*"], ["git.read", "threads.read"])).toEqual(["git.read"]);
    expect(intersectPermissions(["git.read"], ["threads.*"])).toEqual([]);
    expect(intersectPermissions(["a.*", "a.b"], ["*"])).toEqual(["a.*"]);
  });

  it("accepts permissions and trailing patterns only", () => {
    for (const grant of ["*", "git", "git.read", "git.*", "mesh.config-fan-out"]) {
      expect(isGrant(grant)).toBe(true);
    }
    for (const grant of ["", "git.*.read", "*.read", "Git.read", "git.", ".*", "git*"]) {
      expect(isGrant(grant)).toBe(false);
    }
  });
});

describe("describePermissions (security.md D961)", () => {
  // The `after` half of the kernel's hooks: enough to run one pipeline.
  function hooks() {
    const after = new Set<(output: PermissionEntry[]) => PermissionEntry[]>();
    return {
      hooks: {
        after: (name: string, hook: (output: PermissionEntry[]) => PermissionEntry[]) => {
          expect(name).toBe(PERMISSIONS_DESCRIBE_HOOK);
          after.add(hook);
          return { dispose: () => after.delete(hook) };
        },
      } as unknown as Hooks,
      run: (entries: PermissionEntry[]) =>
        [...after].reduce((output, hook) => hook(output), entries),
    };
  }
  const entries = (): PermissionEntry[] => [
    { permission: "git.read", commands: ["git.status"] },
    { permission: "other.read", commands: [] },
  ];

  it("titles the permissions it knows and leaves the others alone", () => {
    const { hooks: context, run } = hooks();
    describePermissions(
      { hooks: context },
      { "git.read": { title: "View", description: "Read." } },
    );
    expect(run(entries())).toEqual([
      { permission: "git.read", commands: ["git.status"], title: "View", description: "Read." },
      { permission: "other.read", commands: [] },
    ]);
  });

  it("keeps the first description of a permission", () => {
    const { hooks: context, run } = hooks();
    describePermissions({ hooks: context }, { "git.read": { title: "First" } });
    describePermissions(
      { hooks: context },
      { "git.read": { title: "Second", description: "No." } },
    );
    expect(run(entries())[0]).toEqual({
      permission: "git.read",
      commands: ["git.status"],
      title: "First",
    });
  });

  it("stops describing once disposed", () => {
    const { hooks: context, run } = hooks();
    describePermissions({ hooks: context }, { "git.read": { title: "View" } }).dispose();
    expect(run(entries())).toEqual(entries());
  });
});

describe("the words that name shell access (security.md D1364, D1517)", () => {
  it("says a permission's reason, else D1364's sentence, and nothing without shell access", () => {
    expect(shellAccessText({ shellAccess: true })).toBe(
      "Shell access: runs commands on this machine as the node's user.",
    );
    expect(
      shellAccessText({
        shellAccess: true,
        shellAccessReason: "a repository's hooks run on this machine as the node's user",
      }),
    ).toBe("Shell access: a repository's hooks run on this machine as the node's user.");
    expect(shellAccessText({ shellAccess: true, shellAccessReason: "it starts programs. " })).toBe(
      "Shell access: it starts programs.",
    );
    expect(shellAccessText({ shellAccess: true, shellAccessReason: " " })).toBe(
      "Shell access: runs commands on this machine as the node's user.",
    );
    expect(shellAccessText({ shellAccessReason: "never shown" })).toBeUndefined();
    expect(shellAccessText({})).toBeUndefined();
  });
});
