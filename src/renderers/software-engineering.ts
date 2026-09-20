import type { Renderer, RenderContext, RenderedArtifact } from "./renderer.ts";
import { provenanceLine, splitSteps, slug } from "./generic.ts";

/**
 * Reference renderer for the software-engineering domain.
 *
 * Every target-specific detail lives here: Markdown headings, SKILL.md
 * frontmatter, shell shebangs. None of it leaks back into the proposal model.
 */
export class SoftwareEngineeringRenderer implements Renderer {
  readonly domain = "software-engineering";

  targets(): string[] {
    return ["claude-md", "agents-md", "skill", "checklist", "script"];
  }

  render(context: RenderContext): RenderedArtifact {
    switch (context.target) {
      case "agents-md":
        return this.instructionsFile(context, "AGENTS.md");
      case "skill":
        return this.skill(context);
      case "checklist":
        return this.checklist(context);
      case "script":
        return this.script(context);
      default:
        return this.instructionsFile(context, "CLAUDE.md");
    }
  }

  private instructionsFile(context: RenderContext, path: string): RenderedArtifact {
    const { proposal } = context;
    const lines = [`### ${proposal.title}`, "", proposal.statement, ""];
    if (proposal.rationale) lines.push(`Rationale: ${proposal.rationale}`, "");
    lines.push(provenanceLine(context));
    return {
      target: context.target,
      mode: "append",
      suggestedPath: path,
      content: lines.join("\n"),
    };
  }

  private skill(context: RenderContext): RenderedArtifact {
    const { proposal } = context;
    const name = slug(proposal.title);
    const steps = splitSteps(proposal.statement);
    const lines = [
      "---",
      `name: ${name}`,
      `description: ${singleLine(proposal.statement)}`,
      "---",
      "",
      `# ${proposal.title}`,
      "",
    ];
    if (proposal.rationale) lines.push(proposal.rationale, "");
    lines.push("## Steps", "");
    steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
    lines.push("", provenanceLine(context));
    return {
      target: "skill",
      mode: "create",
      suggestedPath: `.claude/skills/${name}/SKILL.md`,
      content: lines.join("\n"),
    };
  }

  private checklist(context: RenderContext): RenderedArtifact {
    const { proposal } = context;
    const lines = [`## ${proposal.title}`, ""];
    for (const step of splitSteps(proposal.statement)) lines.push(`- [ ] ${step}`);
    lines.push("", provenanceLine(context));
    return {
      target: "checklist",
      mode: "append",
      suggestedPath: "docs/review-checklist.md",
      content: lines.join("\n"),
    };
  }

  /**
   * A script target produces a documented stub, never executable logic
   * invented by a model. The user writes the body; this captures what it is
   * for and why it exists.
   */
  private script(context: RenderContext): RenderedArtifact {
    const { proposal } = context;
    const name = slug(proposal.title);
    const lines = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "",
      `# ${proposal.title}`,
      "#",
      ...wrap(proposal.statement).map((l) => `# ${l}`),
    ];
    if (proposal.rationale) {
      lines.push("#", ...wrap(`Why: ${proposal.rationale}`).map((l) => `# ${l}`));
    }
    lines.push(
      "#",
      `# ${provenanceLine(context).replace(/^<!--\s*/, "").replace(/\s*-->$/, "")}`,
      "",
      "# TODO: implement. decision-logger describes the operation; it does not",
      "# invent the commands that perform it.",
      "",
    );
    return {
      target: "script",
      mode: "create",
      suggestedPath: `scripts/${name}.sh`,
      content: lines.join("\n"),
    };
  }
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 180);
}

function wrap(text: string, width = 76): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > width) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current += ` ${word}`;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}
