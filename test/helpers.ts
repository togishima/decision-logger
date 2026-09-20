import { openDatabase } from "../src/core/storage/db.ts";
import type { Db } from "../src/core/storage/db.ts";
import { defaultConfig } from "../src/core/config.ts";
import type { Config } from "../src/core/config.ts";
import { FakeAnalyzer } from "../src/core/analysis/fake.ts";
import type { DomainProfile } from "../src/core/domains/profile.ts";
import { getProfile } from "../src/core/domains/profile.ts";
import type { NormalizedWorkSession, WorkMessage } from "../src/core/model/session.ts";

/**
 * Test helpers.
 *
 * Every test here runs against an in-memory SQLite database and a scripted
 * analyzer, so the whole core is exercised with no model, no network, and no
 * files touched. That is the payoff of keeping the LLM behind one port.
 */

export function testDb(): Db {
  return openDatabase(":memory:");
}

export function testConfig(patch: Partial<Config> = {}): Config {
  const config = defaultConfig();
  config.databasePath = ":memory:";
  // Fixtures are short; the production gate would skip them all.
  config.ingestion.minUserTurns = 1;
  config.ingestion.minNewChars = 1;
  config.distillation.minDecisions = 2;
  return { ...config, ...patch };
}

export function seProfile(): DomainProfile {
  return getProfile("software-engineering");
}

export function pmProfile(): DomainProfile {
  return getProfile("product-management");
}

export interface SessionOptions {
  source?: string;
  sessionId?: string;
  workspaceId?: string;
  messages?: WorkMessage[];
  cursor?: number;
  createdAt?: string;
}

let counter = 0;

export function session(options: SessionOptions = {}): NormalizedWorkSession {
  counter += 1;
  return {
    source: options.source ?? "claude-code",
    sessionId: options.sessionId ?? `session-${counter}`,
    workspaceId: options.workspaceId ?? "ws_test",
    workspaceLabel: "test workspace",
    startedAt: options.createdAt ?? "2026-09-01T10:00:00.000Z",
    endedAt: options.createdAt ?? "2026-09-01T11:00:00.000Z",
    messages:
      options.messages ??
      ([
        { role: "user", text: "We need to pick a database for the session store." },
        { role: "assistant", text: "Options are D1 and Postgres." },
        { role: "user", text: "Use D1 instead of Postgres because the stack is already Cloudflare." },
      ] as WorkMessage[]),
    cursor: options.cursor,
  };
}

/** A session with nothing in it worth recording. */
export function trivialSession(): NormalizedWorkSession {
  return session({
    sessionId: "trivial",
    messages: [
      { role: "user", text: "what files are in src?" },
      { role: "assistant", text: "index.ts, util.ts" },
      { role: "user", text: "thanks" },
    ],
  });
}

export interface FakeDecision {
  category: string;
  subject: string;
  decision: string;
  context?: string;
  reasoning?: string;
  confidence?: number;
  alternatives?: { alternative: string; reason_rejected?: string }[];
}

export function analyzerWith(...decisionSets: FakeDecision[][]): FakeAnalyzer {
  const analyzer = new FakeAnalyzer();
  for (const set of decisionSets) {
    analyzer.enqueue("extract-decisions", {
      decisions: set.map((d) => ({ confidence: 0.85, ...d })),
    });
  }
  return analyzer;
}

export interface FakeProposal {
  kind: "principle" | "procedure" | "operation";
  title: string;
  statement: string;
  rationale?: string;
  proposed_target?: string;
  confidence?: number;
  evidence_decision_ids: string[];
}

export function withProposals(analyzer: FakeAnalyzer, ...sets: FakeProposal[][]): FakeAnalyzer {
  for (const set of sets) analyzer.enqueue("distill-patterns", { proposals: set });
  return analyzer;
}
