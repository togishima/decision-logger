import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { existsSync, statSync } from "node:fs";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  input?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export function runProcess(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : undefined;

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}

/**
 * Resolves a binary on PATH without spawning a shell.
 *
 * Hooks run in a non-interactive shell whose PATH often omits version-manager
 * directories (nvm, mise, asdf), so `doctor` and `init` use this to report and
 * record absolute paths rather than assuming the name will resolve later.
 */
export function which(name: string): string | undefined {
  const path = process.env.PATH ?? "";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      /* unreadable PATH entry */
    }
  }
  return undefined;
}
