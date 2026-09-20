import type { WorkAdapter, CollectInput } from "./adapter.ts";
import { ClaudeCodeAdapter } from "./claude-code.ts";
import { CursorAdapter } from "./cursor.ts";
import { CodexAdapter } from "./codex.ts";
import { GenericAdapter } from "./generic.ts";

const ALL: WorkAdapter[] = [
  new ClaudeCodeAdapter(),
  new CursorAdapter(),
  new CodexAdapter(),
  new GenericAdapter(),
];

export function allAdapters(): WorkAdapter[] {
  return [...ALL];
}

export function adapterByName(name: string): WorkAdapter | undefined {
  return ALL.find((a) => a.getName() === name);
}

export function enabledAdapters(names: string[]): WorkAdapter[] {
  return ALL.filter((a) => names.includes(a.getName()));
}

/**
 * Picks the adapter for an input. Order matters only in that the generic
 * adapter is the last resort — it can read anything, so it must not shadow a
 * specific one.
 */
export function selectAdapter(input: CollectInput, names?: string[]): WorkAdapter | undefined {
  const pool = names ? enabledAdapters(names) : ALL;
  return pool.find((a) => a.getName() !== "generic" && a.canHandle(input))
    ?? pool.find((a) => a.canHandle(input));
}
