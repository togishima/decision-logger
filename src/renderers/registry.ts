import type { Renderer } from "./renderer.ts";
import { GenericRenderer } from "./generic.ts";
import { SoftwareEngineeringRenderer } from "./software-engineering.ts";

const RENDERERS: Renderer[] = [new SoftwareEngineeringRenderer(), new GenericRenderer()];

/**
 * Renderer lookup by domain, falling back to the generic one.
 *
 * A domain with no renderer of its own is not an error: every proposal can
 * still be written out as a note, a checklist, or a reusable prompt. That is
 * what makes adding a profile a one-file change.
 */
export function rendererFor(domain: string): Renderer {
  return RENDERERS.find((r) => r.domain === domain) ?? RENDERERS.at(-1)!;
}

export function listRenderers(): Renderer[] {
  return [...RENDERERS];
}
