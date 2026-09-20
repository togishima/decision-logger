#!/usr/bin/env node
// Entry point. Prefers the compiled build, falls back to running TypeScript
// sources directly via Node's type stripping, which keeps a git-installed
// plugin working with no build step.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// node:sqlite still emits an ExperimentalWarning. Hooks capture stderr, so a
// warning on every turn would be noise in the user's agent logs. Only that one
// is filtered; every other warning still surfaces.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
  if (type === "ExperimentalWarning" && String(warning).includes("SQLite")) return;
  return emitWarning.call(process, warning, ...rest);
};

const here = dirname(fileURLToPath(import.meta.url));
const compiled = join(here, "..", "dist", "cli", "main.js");
const source = join(here, "..", "src", "cli", "main.ts");

const mod = await import(existsSync(compiled) ? compiled : source);
// Propagate the exit code: hooks and shell scripts branch on it.
process.exitCode = (await mod.main(process.argv.slice(2))) ?? 0;
