/**
 * GitWriter — shared helper for all WriteBridges.
 *
 * Writes a file and stages a commit on a `theeights/auto` side-branch in the
 * consumer's git repo. The consumer's main branch is never touched and
 * force-push is never used. If the file is not inside a git repo, falls back
 * to plain in-place write.
 *
 * On any error the bridge falls back gracefully and returns a structured
 * WriteResult — the registry commit is never rolled back (ADR-0007).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { WriteRequest, WriteResult } from "./writeback.js";

const SIDE_BRANCH = "theeights/auto";

function run(cwd: string, args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout?.trim() ?? "", err: r.stderr?.trim() ?? "" };
}

function findRepoRoot(filePath: string): string | null {
  const dir = dirname(resolve(filePath));
  const r = run(dir, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 && r.out ? r.out : null;
}

function currentBranch(repo: string): string | null {
  const r = run(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.code === 0 && r.out !== "HEAD" ? r.out : null;
}

function branchExists(repo: string, branch: string): boolean {
  return run(repo, ["rev-parse", "--verify", branch]).code === 0;
}

function hasChanges(repo: string): boolean {
  return run(repo, ["status", "--porcelain"]).out.length > 0;
}

function pickBaseBranch(repo: string): string {
  for (const b of ["main", "master"]) {
    if (branchExists(repo, b)) return b;
  }
  // Fall back to current HEAD.
  return currentBranch(repo) ?? "main";
}

export async function writeWithGitSideBranch(req: WriteRequest): Promise<WriteResult> {
  const result: WriteResult = {
    ok: false,
    source_path: req.source_path,
    mode_used: "in-place+branch",
  };

  // Ensure parent dir exists.
  try {
    mkdirSync(dirname(req.source_path), { recursive: true });
  } catch (err) {
    result.error = `mkdirSync failed: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }

  const repo = findRepoRoot(req.source_path);
  if (!repo) {
    // Not a git repo — degrade to plain in-place write.
    try {
      writeFileSync(req.source_path, req.content, "utf8");
      return { ...result, ok: true, mode_used: "in-place" };
    } catch (err) {
      result.error = `writeFileSync failed: ${err instanceof Error ? err.message : String(err)}`;
      return result;
    }
  }

  // Save current branch + dirty state.
  const original = currentBranch(repo) ?? pickBaseBranch(repo);
  const dirty = hasChanges(repo);
  let stashed = false;
  if (dirty) {
    const s = run(repo, ["stash", "push", "-u", "-m", `theeights: pre-writeback stash for ${req.rid}`]);
    if (s.code !== 0) {
      result.error = `git stash failed: ${s.err || s.out}`;
      return result;
    }
    stashed = true;
  }

  const restore = (): void => {
    run(repo, ["checkout", original]);
    if (stashed) run(repo, ["stash", "pop"]);
  };

  try {
    // Ensure side branch exists.
    if (!branchExists(repo, SIDE_BRANCH)) {
      const base = pickBaseBranch(repo);
      const create = run(repo, ["checkout", "-b", SIDE_BRANCH, base]);
      if (create.code !== 0) {
        restore();
        result.error = `failed to create ${SIDE_BRANCH}: ${create.err}`;
        return result;
      }
    } else {
      const co = run(repo, ["checkout", SIDE_BRANCH]);
      if (co.code !== 0) {
        restore();
        result.error = `failed to checkout ${SIDE_BRANCH}: ${co.err}`;
        return result;
      }
    }

    // Write the file.
    try {
      writeFileSync(req.source_path, req.content, "utf8");
    } catch (err) {
      restore();
      result.error = `writeFileSync failed: ${err instanceof Error ? err.message : String(err)}`;
      return result;
    }

    // Stage + commit. If nothing changed (idempotent rewrite), skip.
    run(repo, ["add", "--", req.source_path]);
    if (!hasChanges(repo)) {
      restore();
      return { ...result, ok: true, git_branch: SIDE_BRANCH, git_commit: "no-op" };
    }

    const msg = [
      `[eights] evolve ${req.rid} → ${req.version}`,
      "",
      req.justification ?? "(no justification recorded)",
      "",
      req.proposal_id ? `Proposal: ${req.proposal_id}` : "",
      "",
      "Authored by TheEights EvolutionEngine. Reviewable as side-branch diff.",
    ].filter(Boolean).join("\n");

    const commit = run(repo, ["-c", "user.name=eights-daemon", "-c", "user.email=eights@local", "-c", "commit.gpgsign=false", "commit", "-m", msg]);
    if (commit.code !== 0) {
      restore();
      result.error = `git commit failed: ${commit.err || commit.out}`;
      return result;
    }
    const sha = run(repo, ["rev-parse", "HEAD"]).out;

    restore();
    return { ...result, ok: true, git_branch: SIDE_BRANCH, git_commit: sha };
  } catch (err) {
    restore();
    result.error = `git writeback failed: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }
}

export async function writeInPlace(req: WriteRequest): Promise<WriteResult> {
  try {
    mkdirSync(dirname(req.source_path), { recursive: true });
    writeFileSync(req.source_path, req.content, "utf8");
    return {
      ok: true,
      source_path: req.source_path,
      mode_used: "in-place",
    };
  } catch (err) {
    return {
      ok: false,
      source_path: req.source_path,
      mode_used: "in-place",
      error: `writeInPlace failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
