import { spawnProcess } from "./spawn.ts";

const ALLOWED_FIRST = new Set([
  "fetch",
  "checkout",
  "switch",
  "rev-parse",
  "branch",
  "status",
  "diff",
  "apply",
  "add",
  "commit",
  "push",
  "remote",
  "config",
]);

export async function runGit(workspace: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  if (args.length < 1 || args[0] === undefined) throw new Error("git: missing arguments");
  if (!ALLOWED_FIRST.has(args[0])) throw new Error(`git: forbidden subcommand ${args[0]}`);
  return spawnProcess("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: workspace });
}

export async function configureGitActor(workspace: string): Promise<void> {
  const name = process.env.SLACK_AUTO_FIX_GIT_NAME ?? "slack-auto-fix[bot]";
  const email =
    process.env.SLACK_AUTO_FIX_GIT_EMAIL ?? "slack-auto-fix@users.noreply.github.com";
  const nm = await runGit(workspace, ["config", "user.name", name]);
  const em = await runGit(workspace, ["config", "user.email", email]);
  if (nm.code !== 0 || em.code !== 0) {
    throw new Error(`Unable to configure git identity: ${nm.stderr}${em.stderr}`);
  }
}

export async function checkoutBaseAndCreate(workspace: string, baseBranch: string, workBranch: string): Promise<void> {
  await runGit(workspace, ["fetch", "origin", "--prune"]);

  let picked = await runGit(workspace, ["rev-parse", "--verify", "--quiet", `origin/${baseBranch}`]);
  if (picked.code !== 0) {
    picked = await runGit(workspace, ["rev-parse", "--verify", "--quiet", baseBranch]);
  }
  if (picked.code !== 0) {
    throw new Error(
      `unable to locate base '${baseBranch}' locally or under origin/*. Ensure branch exists and fetch-depth is adequate.`,
    );
  }

  const co = await runGit(workspace, ["checkout", "-B", `_slack_base_${sanitize(baseBranch)}`, `origin/${baseBranch}`]);
  if (co.code !== 0) {
    const co2 = await runGit(workspace, ["checkout", "-B", `_slack_base_${sanitize(baseBranch)}`, baseBranch]);
    if (co2.code !== 0) {
      throw new Error(`git checkout origin/${baseBranch} failed: ${co.stderr || co.stdout}`);
    }
  }

  const branch = await runGit(workspace, ["checkout", "-B", workBranch]);
  if (branch.code !== 0) {
    throw new Error(`unable to spawn work branch ${workBranch}: ${branch.stderr}`);
  }
}

export async function porcelainStatus(workspace: string): Promise<boolean> {
  const st = await runGit(workspace, ["status", "--porcelain=v1"]);
  if (st.code !== 0) throw new Error(`git status porcelain failed ${st.stderr}`);
  return Boolean(st.stdout.trim());
}

export async function addAll(workspace: string): Promise<void> {
  const res = await runGit(workspace, ["add", "-u"]);
  if (res.code !== 0) throw new Error(`git add failed: ${res.stderr}`);
}

export async function commitWorkspaceChanges(workspace: string, message: string): Promise<boolean> {
  await configureGitActor(workspace);
  await addAll(workspace);
  const dirty = await porcelainStatus(workspace);
  if (!dirty) return false;
  const res = await runGit(workspace, ["commit", "-m", message]);
  if (res.code !== 0) throw new Error(`git commit failed: ${res.stderr}`);
  return true;
}

export async function pushBranch(workspace: string, branchName: string): Promise<void> {
  const upstream = branchName.includes("/") ? branchName.replaceAll("/", "__") : branchName;
  void upstream;

  const res = await runGit(workspace, ["push", "--set-upstream", "origin", branchName]);
  if (res.code !== 0) {
    throw new Error(`git push origin ${branchName} failed: ${res.stderr}`);
  }
}

export async function ghPrCreate(
  workspace: string,
  base: string,
  headBranch: string,
  title: string,
  bodyFile: string,
): Promise<{ url?: string | null }> {
  const res = await spawnProcess(
    "gh",
    ["pr", "create", "--base", base, "--head", headBranch, "--title", title, "--body-file", bodyFile],
    { cwd: workspace },
  );
  const out = `${res.stdout}`.trim();
  if (res.code !== 0) {
    throw new Error(`gh pr create failed: ${res.stderr || out}`);
  }
  /** gh prints PR URL last line typically */
  const urlMatch = out.split("\n").map((ln) => ln.trim()).filter(Boolean).pop();
  return { url: urlMatch ?? null };
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 96);
}

export async function workspaceRoot(): Promise<string> {
  return process.env.GITHUB_WORKSPACE ?? process.cwd();
}
