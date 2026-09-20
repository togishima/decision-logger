import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { stableId } from "./ids.ts";

/**
 * Workspace identity.
 *
 * The core says "workspace", not "repository". Software development happens to
 * map a workspace onto a git remote or a repo root, but that is one mapping
 * among several — a researcher's workspace might be a project folder, a
 * marketer's might be a campaign. So the git logic lives here, behind a
 * generic result, and everything else in the core only ever sees an opaque id.
 *
 * Git plumbing is read from `.git` directly rather than by shelling out: this
 * runs inside a hook with a 1.5s budget, and a subprocess per session is a
 * cost with no benefit.
 */

export interface WorkspaceIdentity {
  id: string;
  label: string;
  root?: string;
  /** How the identity was derived, shown by `doctor`. */
  basis: "explicit" | "git-remote" | "git-root" | "directory";
}

export function identifyWorkspace(
  cwd: string,
  explicitId?: string,
  explicitLabel?: string,
): WorkspaceIdentity {
  if (explicitId) {
    return {
      id: explicitId,
      label: explicitLabel ?? explicitId,
      root: cwd,
      basis: "explicit",
    };
  }

  const gitDir = findGitDir(cwd);
  if (gitDir) {
    const root = dirname(gitDir);
    const remote = readOriginUrl(gitDir);
    if (remote) {
      const normalized = normalizeRemote(remote);
      return {
        id: stableId("ws", normalized),
        label: explicitLabel ?? normalized,
        root,
        basis: "git-remote",
      };
    }
    return {
      id: stableId("ws", resolve(root)),
      label: explicitLabel ?? basename(root),
      root,
      basis: "git-root",
    };
  }

  const root = resolve(cwd);
  return {
    id: stableId("ws", root),
    label: explicitLabel ?? (basename(root) || root),
    root,
    basis: "directory",
  };
}

export function findWorkspaceRoot(cwd: string): string {
  const gitDir = findGitDir(cwd);
  return gitDir ? dirname(gitDir) : resolve(cwd);
}

function findGitDir(startDir: string): string | undefined {
  let current = resolve(startDir);
  for (;;) {
    const candidate = join(current, ".git");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function readOriginUrl(gitDir: string): string | undefined {
  // A worktree or submodule has a `.git` file pointing at the real directory.
  let realGitDir = gitDir;
  try {
    const stat = readFileSync(gitDir, "utf8");
    const match = stat.match(/^gitdir:\s*(.+)$/m);
    if (match?.[1]) realGitDir = resolve(dirname(gitDir), match[1].trim());
  } catch {
    /* gitDir is a directory, which is the normal case */
  }

  const configPath = join(realGitDir, "config");
  if (!existsSync(configPath)) return undefined;

  try {
    const config = readFileSync(configPath, "utf8");
    const section = config.match(/\[remote "origin"\]([\s\S]*?)(?:\n\[|$)/);
    const url = section?.[1]?.match(/^\s*url\s*=\s*(.+)$/m)?.[1];
    return url?.trim();
  } catch {
    return undefined;
  }
}

/** git@host:owner/repo.git and https://host/owner/repo both become host/owner/repo. */
export function normalizeRemote(url: string): string {
  let out = url.trim().replace(/\.git$/, "");
  out = out.replace(/^[a-z+]+:\/\//i, "");
  out = out.replace(/^[^@/]+@/, "");
  out = out.replace(/:(?!\d)/, "/");
  return out.toLowerCase();
}
