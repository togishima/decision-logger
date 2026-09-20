import type { Db } from "../storage/db.ts";
import type { NotificationConfig } from "../config.ts";
import { getState, setState } from "../storage/db.ts";
import { countUnreviewed } from "../storage/decisions-repo.ts";

/**
 * Review reminders.
 *
 * The one place the tool is allowed to speak up during normal work, so the
 * rules are strict: never block, never repeat within a cooldown, never fire on
 * an empty store, and always be switchable off. A reminder that becomes noise
 * would undo the whole "invisible observer" premise.
 */

const KEY_LAST_NOTIFIED_AT = "reminder.last_notified_at";
const KEY_LAST_NOTIFIED_SESSION = "reminder.last_notified_session";
const KEY_LAST_DISTILLED_AT = "distill.last_run_at";

export interface ReminderState {
  unreviewed: number;
  lastDistilledAt?: string;
  lastNotifiedAt?: string;
  daysSinceDistill?: number;
}

export interface ReminderDecision {
  notify: boolean;
  reason: string;
  message?: string;
  state: ReminderState;
}

export function readState(db: Db, workspaceId?: string): ReminderState {
  const lastDistilledAt = getState(db, KEY_LAST_DISTILLED_AT);
  return {
    unreviewed: countUnreviewed(db, workspaceId),
    lastDistilledAt,
    lastNotifiedAt: getState(db, KEY_LAST_NOTIFIED_AT),
    daysSinceDistill: lastDistilledAt ? daysBetween(lastDistilledAt, nowIso()) : undefined,
  };
}

export interface EvaluateOptions {
  workspaceId?: string;
  /** Reminders fire at most once per agent session. */
  sessionId?: string;
  now?: Date;
}

export function evaluateReminder(
  db: Db,
  config: NotificationConfig,
  options: EvaluateOptions = {},
): ReminderDecision {
  const now = options.now ?? new Date();
  const state = readState(db, options.workspaceId);

  if (!config.enabled) return { notify: false, reason: "notifications are disabled", state };

  // A time-based trigger on an empty store would fire forever, so every
  // trigger requires at least one thing actually waiting to be reviewed.
  if (state.unreviewed === 0) return { notify: false, reason: "nothing unreviewed", state };

  if (options.sessionId && getState(db, KEY_LAST_NOTIFIED_SESSION) === options.sessionId) {
    return { notify: false, reason: "already notified in this session", state };
  }

  if (state.lastNotifiedAt) {
    const hours = (now.getTime() - Date.parse(state.lastNotifiedAt)) / 3_600_000;
    if (hours < config.cooldownHours) {
      return { notify: false, reason: `within the ${config.cooldownHours}h cooldown`, state };
    }
  }

  const countTriggered = state.unreviewed >= config.unreviewedThreshold;
  const ageTriggered =
    state.lastDistilledAt !== undefined &&
    daysBetween(state.lastDistilledAt, now.toISOString()) >= config.reviewAgeDays;

  if (!countTriggered && !ageTriggered) {
    return {
      notify: false,
      reason: `${state.unreviewed} unreviewed, threshold ${config.unreviewedThreshold}`,
      state,
    };
  }

  return {
    notify: true,
    reason: countTriggered ? "unreviewed threshold reached" : "review age threshold reached",
    message: buildMessage(state, ageTriggered && !countTriggered),
    state,
  };
}

function buildMessage(state: ReminderState, byAge: boolean): string {
  const noun = state.unreviewed === 1 ? "decision" : "decisions";
  const lines = [`${state.unreviewed} unreviewed ${noun}.`];
  if (byAge && state.daysSinceDistill !== undefined) {
    lines.push(`Last reviewed ${state.daysSinceDistill} days ago.`);
  }
  lines.push("Recurring work patterns may be ready for review.", "", "Run /distill when convenient.");
  return lines.join("\n");
}

export function recordNotification(db: Db, sessionId?: string, now = new Date()): void {
  setState(db, KEY_LAST_NOTIFIED_AT, now.toISOString());
  if (sessionId) setState(db, KEY_LAST_NOTIFIED_SESSION, sessionId);
}

export function recordDistillation(db: Db, now = new Date()): void {
  setState(db, KEY_LAST_DISTILLED_AT, now.toISOString());
}

export function lastDistilledAt(db: Db): string | undefined {
  return getState(db, KEY_LAST_DISTILLED_AT);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

function nowIso(): string {
  return new Date().toISOString();
}
