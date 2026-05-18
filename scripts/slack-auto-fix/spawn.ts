import { spawn } from "node:child_process";

export async function spawnProcess(
  cmd: string,
  argv: readonly string[],
  opts: { cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const child = spawn(cmd, argv, {
      cwd: opts.cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (d) => out.push(Buffer.from(d)));
    child.stderr?.on("data", (d) => err.push(Buffer.from(d)));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        code: code ?? (signal ? 1 : 0),
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}
