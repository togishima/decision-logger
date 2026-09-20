import type { NormalizedWorkSession } from "../model/session.ts";
import { countUserTurns, sessionTextLength } from "../model/session.ts";
import type { IngestionConfig } from "../config.ts";

/**
 * Deterministic gate in front of the analyzer.
 *
 * This is what makes the logger invisible and cheap. Most sessions decide
 * nothing worth keeping — a question answered, a file read, a `/clear`. Those
 * must cost zero model calls, so the decision to *not* look is made here, with
 * plain arithmetic, before any prompt is built.
 */

export interface GateDecision {
  proceed: boolean;
  reason: string;
}

export function shouldAnalyze(
  session: NormalizedWorkSession,
  config: IngestionConfig,
  alreadyIngestedCursor = 0,
): GateDecision {
  const userTurns = countUserTurns(session);
  if (userTurns < config.minUserTurns) {
    return { proceed: false, reason: `only ${userTurns} user turn(s), need ${config.minUserTurns}` };
  }

  const chars = sessionTextLength(session);
  if (chars < config.minNewChars) {
    return { proceed: false, reason: `only ${chars} characters of new content, need ${config.minNewChars}` };
  }

  if (session.cursor !== undefined && session.cursor <= alreadyIngestedCursor) {
    return { proceed: false, reason: "no new content since the last ingestion" };
  }

  return { proceed: true, reason: `${userTurns} user turns, ${chars} characters` };
}
