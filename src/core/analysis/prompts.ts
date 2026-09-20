import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { bundledPromptsDir, userPromptsDir } from "../paths.ts";

/**
 * Prompts are plain Markdown files on disk, not string literals buried in code.
 *
 * A user can read exactly what is asked of the model, and can override any
 * prompt by dropping a file of the same name into the config prompts
 * directory. That visibility is a product requirement.
 */

export type PromptName = "extract-decisions" | "distill-patterns";

export function promptPath(name: PromptName): string {
  const override = join(userPromptsDir(), `${name}.md`);
  if (existsSync(override)) return override;
  return join(bundledPromptsDir(), `${name}.md`);
}

export function loadPrompt(name: PromptName): string {
  const path = promptPath(name);
  if (!existsSync(path)) throw new Error(`prompt not found: ${path}`);
  return readFileSync(path, "utf8");
}

/** `{{key}}` substitution. Unknown placeholders are left intact and visible. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.hasOwn(vars, key) ? vars[key]! : match,
  );
}
