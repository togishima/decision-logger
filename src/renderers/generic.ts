import type { Renderer, RenderContext, RenderedArtifact } from "./renderer.ts";

/**
 * Domain-neutral renderer. Produces plain Markdown that suits any profession:
 * a note, a checklist, or a reusable prompt.
 */
export class GenericRenderer implements Renderer {
  readonly domain = "generic";

  targets(): string[] {
    return ["note", "checklist", "prompt"];
  }

  render(context: RenderContext): RenderedArtifact {
    switch (context.target) {
      case "checklist":
        return this.checklist(context);
      case "prompt":
        return this.prompt(context);
      default:
        return this.note(context);
    }
  }

  private note(context: RenderContext): RenderedArtifact {
    const { proposal } = context;
    const lines = [
      `## ${proposal.title}`,
      "",
      proposal.statement,
      "",
    ];
    if (proposal.rationale) lines.push(`_Why:_ ${proposal.rationale}`, "");
    lines.push(provenanceLine(context));
    return { target: "note", mode: "append", suggestedPath: "NOTES.md", content: lines.join("\n") };
  }

  private checklist(context: RenderContext): RenderedArtifact {
    const { proposal } = context;
    const steps = splitSteps(proposal.statement);
    const lines = [`## ${proposal.title}`, ""];
    for (const step of steps) lines.push(`- [ ] ${step}`);
    lines.push("", provenanceLine(context));
    return {
      target: "checklist",
      mode: "append",
      suggestedPath: "CHECKLIST.md",
      content: lines.join("\n"),
    };
  }

  private prompt(context: RenderContext): RenderedArtifact {
    const { proposal } = context;
    const lines = [
      `# ${proposal.title}`,
      "",
      "Use this when the situation below comes up again.",
      "",
      `**Rule:** ${proposal.statement}`,
      "",
    ];
    if (proposal.rationale) lines.push(`**Background:** ${proposal.rationale}`, "");
    lines.push(provenanceLine(context));
    return {
      target: "prompt",
      mode: "create",
      suggestedPath: `prompts/${slug(proposal.title)}.md`,
      content: lines.join("\n"),
    };
  }
}

export function provenanceLine(context: RenderContext): string {
  const ids = context.evidence.map((d) => d.id);
  if (!ids.length) return "";
  return `<!-- decision-logger: ${context.proposal.id} — from ${ids.length} decision(s): ${ids.join(", ")} -->`;
}

/** Splits a multi-step statement into checklist items. */
export function splitSteps(statement: string): string[] {
  const parts = statement
    .split(/(?:\n\s*[-*\d.]+\s*)|(?:;\s+)|(?:(?<=\.)\s+(?=[A-Z]))/)
    .map((s) => s.trim().replace(/^[-*]\s*/, ""))
    .filter((s) => s.length > 3);
  return parts.length ? parts : [statement];
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}
