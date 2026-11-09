/**
 * What the plugin needs from the host, and how to say whether the host running
 * it is new enough.
 *
 * The ledger reads a seat's structured result, and a seat only has one when
 * the host reads `structured: true` from the agent's frontmatter. That landed
 * in oh-my-pi **18.11.0** (PR #15717): before it, a seat had no `yield` tool
 * on a host with `task.structured` off — the default — so the schema was
 * ignored, the seat answered with a last paragraph, and the plugin had no
 * report to place. Nothing warned about it: the run looked healthy and the
 * reports were simply absent.
 */

/** The first host release that reads `structured` from agent frontmatter. */
export const MIN_HOST_VERSION = "18.11.0";

/**
 * The numeric parts of a version string, or null when there are none.
 *
 * Only the leading dotted number is read: the host reports `18.11.0`, and a
 * build label or a pre-release suffix behind it says nothing about the
 * feature.
 */
export function parseVersion(value: string | undefined): number[] | null {
  if (!value) return null;
  const match = value.trim().replace(/^v/i, "").match(/^(\d+(?:\.\d+)*)/);
  if (!match) return null;
  return match[1]!.split(".").map((part) => Number(part));
}

/** Whether `version` is at least `minimum`. An unparsable version is not. */
export function versionAtLeast(version: string | undefined, minimum: string): boolean {
  const have = parseVersion(version);
  const need = parseVersion(minimum);
  if (!have || !need) return false;
  for (let i = 0; i < Math.max(have.length, need.length); i++) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * The host's line in `/role-fleet doctor`.
 *
 * The version is the host's own — the extension API hands the coding agent's
 * exports to every extension, and the version is one of them — so this asks no
 * question the host cannot answer.
 */
export function describeHost(version: string | undefined): string {
  if (!version) return `host version unknown — structured seat reports need ${MIN_HOST_VERSION}+`;
  if (versionAtLeast(version, MIN_HOST_VERSION)) {
    return `host ${version} — structured seat reports: supported`;
  }
  return `host ${version} — structured seat reports: UNSUPPORTED, needs ${MIN_HOST_VERSION}+ (a seat would have no yield tool)`;
}
