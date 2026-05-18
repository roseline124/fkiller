import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnProcess } from "./spawn.ts";
import { redactPotentialSecrets } from "./generate-patch.ts";

export type PackageManager = "pnpm" | "yarn" | "npm";

export async function resolvePackageManager(cwd: string): Promise<PackageManager> {
  if (await fileExists(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(join(cwd, "yarn.lock"))) return "yarn";
  if (await fileExists(join(cwd, "package-lock.json"))) return "npm";
  return "pnpm";
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function packageJsonScripts(cwd: string): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    return typeof raw.scripts === "object" && raw.scripts ? raw.scripts : {};
  } catch {
    return {};
  }
}

export async function runPackageScriptIfPresent(
  cwd: string,
  manager: PackageManager,
  script: "lint" | "test",
): Promise<{ skipped: boolean; ok: boolean; exit_code: number | null; command: string; excerpt: string }> {
  const scripts = await packageJsonScripts(cwd);
  const entry = scripts[script];
  if (!entry?.trim())
    return { skipped: true, ok: true, exit_code: null, command: "", excerpt: `(no ${script} script in package.json)` };

  let cmd = "";
  const argvTail: string[] = [];
  if (manager === "pnpm") {
    cmd = "pnpm";
    argvTail.push("run", script);
  } else if (manager === "yarn") {
    cmd = "yarn";
    argvTail.push(script);
  } else {
    cmd = "npm";
    argvTail.push("run", script);
  }

  const res = await spawnProcess(cmd, argvTail, { cwd });

  const rawText = `${res.stdout}\n${res.stderr}`;
  const excerpt = redactPotentialSecrets(rawText).trimEnd().slice(0, 12_000);

  return {
    skipped: false,
    ok: res.code === 0,
    exit_code: res.code,
    command: `${cmd} ${argvTail.join(" ")}`.trim(),
    excerpt,
  };
}
