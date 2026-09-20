import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { bundledProfilesDir, userProfilesDir } from "../paths.ts";

/**
 * Domain profiles.
 *
 * Everything profession-specific lives here: the category vocabulary, the
 * examples that steer extraction, the guidance handed to the distiller, and
 * the destinations a renderer may target. The core never hard-codes any of it.
 *
 * Profiles are JSON rather than YAML so that the tool keeps zero runtime
 * dependencies; the trade-off is documented in docs/ARCHITECTURE.md.
 */

export interface DomainProfile {
  domain: string;
  label?: string;
  description?: string;
  /** The category vocabulary for this domain. `category` is validated against this. */
  categories: string[];
  /** Short worked examples shown to the extractor. */
  examples?: { subject: string; decision: string; category: string; reasoning?: string }[];
  /** Domain-specific "what counts as a decision here" guidance. */
  extractionGuidance?: string;
  /** Domain-specific guidance for turning decisions into reusable patterns. */
  distillationGuidance?: string;
  /** Destinations a renderer may produce for this domain. Advisory. */
  outputTargets?: { id: string; label: string; description?: string }[];
}

export class ProfileError extends Error {}

function assertProfile(value: unknown, origin: string): DomainProfile {
  if (typeof value !== "object" || value === null) {
    throw new ProfileError(`${origin}: profile must be a JSON object`);
  }
  const p = value as Record<string, unknown>;
  if (typeof p.domain !== "string" || !p.domain.trim()) {
    throw new ProfileError(`${origin}: "domain" is required`);
  }
  if (!Array.isArray(p.categories) || p.categories.some((c) => typeof c !== "string")) {
    throw new ProfileError(`${origin}: "categories" must be an array of strings`);
  }
  if ((p.categories as string[]).length === 0) {
    throw new ProfileError(`${origin}: "categories" must not be empty`);
  }
  return value as DomainProfile;
}

function loadDir(dir: string, into: Map<string, DomainProfile>, errors: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const path = join(dir, entry);
    try {
      const profile = assertProfile(JSON.parse(readFileSync(path, "utf8")), path);
      into.set(profile.domain, profile);
    } catch (err) {
      errors.push(`${path}: ${(err as Error).message}`);
    }
  }
}

export interface ProfileRegistry {
  profiles: Map<string, DomainProfile>;
  errors: string[];
}

/**
 * Bundled profiles first, then user profiles from the config directory —
 * a user profile with the same `domain` replaces the bundled one, which is how
 * the shipped software-engineering vocabulary can be customised.
 */
export function loadProfiles(extraDirs: string[] = []): ProfileRegistry {
  const profiles = new Map<string, DomainProfile>();
  const errors: string[] = [];
  loadDir(bundledProfilesDir(), profiles, errors);
  loadDir(userProfilesDir(), profiles, errors);
  for (const dir of extraDirs) loadDir(dir, profiles, errors);
  return { profiles, errors };
}

export function getProfile(domain: string, extraDirs: string[] = []): DomainProfile {
  const { profiles } = loadProfiles(extraDirs);
  const profile = profiles.get(domain);
  if (!profile) {
    const known = [...profiles.keys()].sort().join(", ") || "(none)";
    throw new ProfileError(`unknown domain profile "${domain}". Known profiles: ${known}`);
  }
  return profile;
}

export function isKnownCategory(profile: DomainProfile, category: string): boolean {
  return profile.categories.includes(category);
}

/**
 * Maps an unknown category onto the profile vocabulary. Extractors are told to
 * use the listed categories, but LLMs improvise; rather than dropping an
 * otherwise good decision we fall back to "other" when the profile has one.
 */
export function normalizeCategory(profile: DomainProfile, category: string): string | undefined {
  const lowered = category.trim().toLowerCase();
  const hit = profile.categories.find((c) => c.toLowerCase() === lowered);
  if (hit) return hit;
  return profile.categories.includes("other") ? "other" : undefined;
}
