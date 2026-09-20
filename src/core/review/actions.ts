import type { Db } from "../storage/db.ts";
import type { Proposal, RejectionReason } from "../model/proposal.ts";
import { resolveProposal, setStatus } from "../storage/proposals-repo.ts";

/**
 * Accept / reject / defer.
 *
 * Accepting a pattern and applying a generated artifact are separate actions
 * on purpose: agreeing that "I do tend to decide this way" is a much smaller
 * commitment than letting a tool edit the files that steer future work.
 * Nothing here writes outside the database.
 */

export class ReviewError extends Error {}

function require(db: Db, idOrPrefix: string): Proposal {
  const proposal = resolveProposal(db, idOrPrefix);
  if (!proposal) throw new ReviewError(`no proposal matching "${idOrPrefix}"`);
  return proposal;
}

export function acceptProposal(db: Db, idOrPrefix: string): Proposal {
  const proposal = require(db, idOrPrefix);
  if (proposal.status === "accepted") return proposal;
  return setStatus(db, proposal.id, "accepted")!;
}

export function rejectProposal(
  db: Db,
  idOrPrefix: string,
  reason?: RejectionReason,
): Proposal {
  const proposal = require(db, idOrPrefix);
  // The row and its evidence are kept. A rejection is information about the
  // user's judgment, and re-proposing the same idea later depends on it.
  return setStatus(db, proposal.id, "rejected", { rejectionReason: reason })!;
}

export function deferProposal(
  db: Db,
  idOrPrefix: string,
  options: { days?: number; until?: string; defaultDays: number },
): Proposal {
  const proposal = require(db, idOrPrefix);
  const until =
    options.until ??
    new Date(Date.now() + (options.days ?? options.defaultDays) * 86_400_000).toISOString();
  return setStatus(db, proposal.id, "deferred", { deferredUntil: until })!;
}

/** Undo a review decision, putting a proposal back in the queue. */
export function reopenProposal(db: Db, idOrPrefix: string): Proposal {
  const proposal = require(db, idOrPrefix);
  return setStatus(db, proposal.id, "candidate")!;
}
