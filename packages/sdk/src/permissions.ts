/**
 * Permissions and grants (security.md D410).
 *
 * A permission is a lowercase dotted id that a command or a stream needs
 * (`git.read`). A grant is a permission, a namespace pattern (`git.*`:
 * `git` and everything under it, at any depth) or `*` (everything).
 */

const PERMISSION = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;

/** True for a permission (`git.read`), a pattern (`git.*`) or `*`. */
export function isGrant(grant: string): boolean {
  if (grant === "*") return true;
  return PERMISSION.test(grant.endsWith(".*") ? grant.slice(0, -2) : grant);
}

/** True when `grant` covers `permission`; `permission` may itself be a pattern. */
function covers(grant: string, permission: string): boolean {
  if (grant === "*") return true;
  if (!grant.endsWith(".*")) return grant === permission;
  const namespace = grant.slice(0, -2);
  if (permission === "*") return false;
  const wanted = permission.endsWith(".*") ? permission.slice(0, -2) : permission;
  return wanted === namespace || wanted.startsWith(`${namespace}.`);
}

/** True when any of `grants` covers `required` (a permission, a pattern or `*`). */
export function holdsPermission(grants: readonly string[], required: string): boolean {
  return grants.some((grant) => covers(grant, required));
}

/** The permissions of `required` that `grants` do not cover, in order. */
export function missingPermissions(
  grants: readonly string[],
  required: readonly string[],
): string[] {
  return required.filter((permission) => !holdsPermission(grants, permission));
}

/**
 * The grants that both `a` and `b` hold: whatever passes both lists, and
 * nothing else. Patterns nest by prefix, so the narrower of two overlapping
 * grants is exactly their intersection.
 */
export function intersectPermissions(a: readonly string[], b: readonly string[]): string[] {
  const result = new Set<string>();
  for (const left of a) {
    for (const right of b) {
      if (covers(left, right)) result.add(right);
      else if (covers(right, left)) result.add(left);
    }
  }
  // Drop grants another one already covers, so the result stays short.
  return [...result].filter(
    (grant) => ![...result].some((other) => other !== grant && covers(other, grant)),
  );
}
