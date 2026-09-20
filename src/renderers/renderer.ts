import type { Proposal } from "../core/model/proposal.ts";
import type { Decision } from "../core/model/decision.ts";

/**
 * Renderers turn an accepted proposal into a concrete work-system artifact.
 *
 * The boundary is one-way: a renderer reads the core proposal and produces
 * text. It never writes back into the proposal, and the core proposal model
 * has no field that exists for a renderer's benefit — no heading level, no
 * file path, no frontmatter. Swapping CLAUDE.md for a design-principles doc
 * must not touch anything in `core/`.
 *
 * Rendering also never writes files. It prints. Deciding that a pattern is
 * real and letting something edit the files that steer future work are
 * separate choices, and the second one stays with the user.
 */

export interface RenderContext {
  proposal: Proposal;
  /** Decisions cited as evidence, for renderers that show provenance. */
  evidence: Decision[];
  /** Target id from the domain profile's `outputTargets`. */
  target: string;
}

export interface RenderedArtifact {
  target: string;
  /** Suggested filename, if the user wants to save the output themselves. */
  suggestedPath?: string;
  /** Whether the content is meant to be appended to an existing file. */
  mode: "append" | "create";
  content: string;
}

export interface Renderer {
  readonly domain: string;
  /** Target ids this renderer can produce. */
  targets(): string[];
  render(context: RenderContext): RenderedArtifact;
}

export class RendererError extends Error {}
