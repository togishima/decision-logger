import { test } from "node:test";
import assert from "node:assert/strict";

import { distill } from "../src/core/distillation/distill.ts";
import { insertDecision, listDecisions, addRelation } from "../src/core/storage/decisions-repo.ts";
import {
  listProposals,
  getProposal,
  getEvidenceIds,
  setStatus,
} from "../src/core/storage/proposals-repo.ts";
import { acceptProposal, rejectProposal, deferProposal } from "../src/core/review/actions.ts";
import { FakeAnalyzer } from "../src/core/analysis/fake.ts";
import { scoreProposal } from "../src/core/ranking/score.ts";
import type { Db } from "../src/core/storage/db.ts";
import { testDb, testConfig, seProfile } from "./helpers.ts";

const WS = "ws_test";

function seedDecisions(db: Db, count: number, overrides: Partial<Parameters<typeof insertDecision>[1]>[] = []) {
  const subjects = [
    ["Caching layer", "Rejected adding Redis", "The in-process cache already meets the latency target."],
    ["Search backend", "Rejected adding Elasticsearch", "Postgres full-text search covers the current query shapes."],
    ["Queue service", "Rejected adding SQS", "The existing cron job drains the table often enough."],
    ["Metrics store", "Rejected adding Prometheus", "The platform already ships request metrics we can query."],
    ["Feature flags", "Rejected adding LaunchDarkly", "Deploy config is sufficient and adds no runtime dependency."],
    ["Image pipeline", "Rejected adding Cloudinary", "The CDN already resizes on the fly for free."],
  ];
  const out = [];
  for (let i = 0; i < count; i++) {
    const [subject, decision, reasoning] = subjects[i % subjects.length]!;
    out.push(
      insertDecision(db, {
        workspaceId: WS,
        source: "claude-code",
        sourceSessionId: `session-${i}`,
        domain: "software-engineering",
        category: "rejection",
        subject: `${subject} ${i}`,
        decision: decision!,
        reasoning: reasoning!,
        confidence: 0.85,
        createdAt: new Date(Date.now() - i * 86_400_000).toISOString(),
        ...overrides[i],
      }),
    );
  }
  return out;
}

const PRINCIPLE = (ids: string[]) => ({
  kind: "principle" as const,
  title: "Check the existing stack before adding a managed service",
  statement:
    "Before introducing a new managed service, verify that the existing stack cannot adequately satisfy the requirement.",
  rationale: "Every recorded rejection came down to the current stack already being sufficient.",
  proposed_target: "claude-md",
  confidence: 0.85,
  evidence_decision_ids: ids,
});

const PROCEDURE = (ids: string[]) => ({
  kind: "procedure" as const,
  title: "Dependency evaluation",
  statement:
    "State the requirement. Check whether the current stack meets it. Name the operational cost of the new dependency. Only then decide.",
  confidence: 0.8,
  evidence_decision_ids: ids,
});

function run(db: Db, analyzer: FakeAnalyzer, workspaceId: string | undefined = WS, now?: Date) {
  return distill({
    db,
    config: testConfig(),
    profile: seProfile(),
    analyzer,
    workspaceId,
    now,
  });
}

test("distillation identifies a repeated principle", async () => {
  const db = testDb();
  const decisions = seedDecisions(db, 4);
  const analyzer = new FakeAnalyzer();
  analyzer.enqueue("distill-patterns", { proposals: [PRINCIPLE(decisions.map((d) => d.id))] });

  const report = await run(db, analyzer);

  assert.equal(report.outcome, "ok");
  assert.equal(report.created.length, 1);
  assert.equal(report.created[0]!.kind, "principle");
  assert.equal(listProposals(db, { status: "candidate" }).length, 1);
});

test("distillation identifies a repeated procedure", async () => {
  const db = testDb();
  const decisions = seedDecisions(db, 4);
  const analyzer = new FakeAnalyzer();
  analyzer.enqueue("distill-patterns", { proposals: [PROCEDURE(decisions.map((d) => d.id))] });

  const report = await run(db, analyzer);
  assert.equal(report.created.length, 1);
  assert.equal(report.created[0]!.kind, "procedure");
});

test("no-pattern is a valid outcome and still clears the review queue", async () => {
  const db = testDb();
  seedDecisions(db, 4);
  const analyzer = new FakeAnalyzer();
  analyzer.enqueue("distill-patterns", { proposals: [] });

  const report = await run(db, analyzer);

  assert.equal(report.outcome, "no-pattern");
  assert.equal(report.created.length, 0);
  // Without this, the reminder would fire forever over the same decisions.
  assert.equal(report.reviewedCount, 4);
  assert.equal(listDecisions(db, { unreviewedOnly: true }).length, 0);
});

test("distillation refuses to run below the minimum decision count", async () => {
  const db = testDb();
  seedDecisions(db, 1);
  const analyzer = new FakeAnalyzer();

  const report = await run(db, analyzer);

  assert.equal(report.outcome, "not-enough-decisions");
  assert.equal(analyzer.callCount("distill-patterns"), 0);
});

test("provenance stays intact", async () => {
  const db = testDb();
  const decisions = seedDecisions(db, 4);
  const analyzer = new FakeAnalyzer();
  analyzer.enqueue("distill-patterns", { proposals: [PRINCIPLE(decisions.map((d) => d.id))] });

  const report = await run(db, analyzer);
  const evidence = getEvidenceIds(db, report.created[0]!.id);

  assert.deepEqual([...evidence].sort(), decisions.map((d) => d.id).sort());
});

test("a proposal citing unknown decisions is dropped", async () => {
  const db = testDb();
  seedDecisions(db, 4);
  const analyzer = new FakeAnalyzer();
  analyzer.enqueue("distill-patterns", { proposals: [PRINCIPLE(["d_nonexistent", "d_alsofake"])] });

  const report = await run(db, analyzer);

  assert.equal(report.created.length, 0);
  assert.match(report.dropped.join(" "), /no resolvable supporting decisions/);
});

test("an accepted proposal absorbs new evidence instead of reappearing as new", async () => {
  const db = testDb();
  const first = seedDecisions(db, 4);
  const analyzer = new FakeAnalyzer();
  analyzer.enqueue("distill-patterns", { proposals: [PRINCIPLE(first.map((d) => d.id))] });

  const firstRun = await run(db, analyzer);
  const proposal = firstRun.created[0]!;
  acceptProposal(db, proposal.id);

  // A later run rediscovers the same pattern with additional evidence.
  const more = seedDecisions(db, 6);
  analyzer.enqueue("distill-patterns", { proposals: [PRINCIPLE(more.map((d) => d.id))] });
  const secondRun = await run(db, analyzer);

  assert.equal(secondRun.created.length, 0, "nothing new is proposed");
  assert.equal(secondRun.absorbedByAccepted.length, 1);

  const refreshed = getProposal(db, proposal.id)!;
  assert.equal(refreshed.status, "accepted");
  assert.ok(
    (refreshed.evidenceDecisionIds ?? []).length > first.length,
    "new decisions attach as supporting evidence",
  );
  assert.equal(listProposals(db, { status: "candidate" }).length, 0);
});

test("a rejected proposal is deprioritized and not re-raised on weak evidence", async () => {
  const db = testDb();
  const decisions = seedDecisions(db, 4);
  const analyzer = new FakeAnalyzer();
  analyzer.enqueue("distill-patterns", { proposals: [PRINCIPLE(decisions.map((d) => d.id))] });

  const firstRun = await run(db, analyzer);
  const proposal = firstRun.created[0]!;
  rejectProposal(db, proposal.id, "too_specific");

  // The same theme comes back with only one new decision behind it.
  const weak = seedDecisions(db, 1);
  analyzer.enqueue("distill-patterns", { proposals: [PRINCIPLE([...decisions.map((d) => d.id), weak[0]!.id])] });
  const secondRun = await run(db, analyzer);

  assert.equal(secondRun.created.length, 0);
  assert.equal(secondRun.revived.length, 0);
  assert.match(secondRun.dropped.join(" "), /rejected/);
  assert.equal(getProposal(db, proposal.id)!.status, "rejected");
});

test("strong new evidence revives a rejected theme", async () => {
  const db = testDb();
  const decisions = seedDecisions(db, 4);
  const analyzer = new FakeAnalyzer();
  analyzer.enqueue("distill-patterns", { proposals: [PRINCIPLE(decisions.map((d) => d.id))] });

  const firstRun = await run(db, analyzer);
  const proposal = firstRun.created[0]!;
  rejectProposal(db, proposal.id, "temporary_pattern");

  // Decisions made after the rejection, above the revival threshold (3).
  const fresh = [];
  for (let i = 0; i < 4; i++) {
    fresh.push(
      insertDecision(db, {
        workspaceId: WS,
        source: "cursor",
        sourceSessionId: `later-${i}`,
        domain: "software-engineering",
        category: "rejection",
        subject: `Later rejection ${i}`,
        decision: `Rejected yet another managed service number ${i}`,
        reasoning: "The existing stack covered it once again.",
        confidence: 0.9,
      }),
    );
  }

  analyzer.enqueue("distill-patterns", {
    proposals: [PRINCIPLE([...decisions.map((d) => d.id), ...fresh.map((d) => d.id)])],
  });
  const secondRun = await run(db, analyzer);

  assert.equal(secondRun.revived.length, 1);
  const revived = getProposal(db, proposal.id)!;
  assert.equal(revived.status, "candidate");
  assert.equal(revived.revived, true);
  assert.ok(revived.rejectedAt, "the rejection history is preserved, not erased");
});

test("rejecting keeps the proposal and its evidence", () => {
  const db = testDb();
  const decisions = seedDecisions(db, 3);
  const proposal = listProposals(db, { status: "any" });
  assert.equal(proposal.length, 0);

  // Insert directly to isolate the review action from distillation.
  const inserted = require_insert(db, decisions.map((d) => d.id));
  rejectProposal(db, inserted.id, "not_actionable");

  const after = getProposal(db, inserted.id)!;
  assert.equal(after.status, "rejected");
  assert.equal(after.rejectionReason, "not_actionable");
  assert.equal(getEvidenceIds(db, inserted.id).length, decisions.length);
});

test("a deferred proposal carries a cooldown date", () => {
  const db = testDb();
  const decisions = seedDecisions(db, 3);
  const inserted = require_insert(db, decisions.map((d) => d.id));

  const deferred = deferProposal(db, inserted.id, { days: 30, defaultDays: 30 });
  assert.equal(deferred.status, "deferred");
  assert.ok(deferred.deferredUntil);
  assert.ok(Date.parse(deferred.deferredUntil!) > Date.now());
});

test("ranking rewards spread and penalises previously rejected themes", () => {
  const db = testDb();
  const decisions = seedDecisions(db, 4);

  const narrow = scoreProposal(
    { title: "T", statement: "S" },
    {
      evidence: [decisions[0]!, { ...decisions[1]!, sourceSessionId: "session-0", source: "claude-code" }],
      confidence: 0.8,
      similarRejections: [],
      similarAccepted: [],
    },
  );

  const broad = scoreProposal(
    { title: "T", statement: "S" },
    {
      evidence: [
        decisions[0]!,
        { ...decisions[1]!, sourceSessionId: "s2", source: "cursor", workspaceId: "ws_other" },
        { ...decisions[2]!, sourceSessionId: "s3", source: "codex", workspaceId: "ws_third" },
      ],
      confidence: 0.8,
      similarRejections: [],
      similarAccepted: [],
    },
  );

  assert.ok(broad.total > narrow.total, "evidence from several sessions and agents ranks higher");
  assert.ok(broad.sessionSpread > 0 && broad.sourceSpread > 0 && broad.workspaceSpread > 0);

  const inserted = require_insert(db, decisions.map((d) => d.id));
  setStatus(db, inserted.id, "rejected");
  const rejected = getProposal(db, inserted.id)!;

  const penalised = scoreProposal(
    { title: rejected.title, statement: rejected.statement },
    {
      evidence: decisions,
      confidence: 0.8,
      similarRejections: [rejected],
      similarAccepted: [],
    },
  );
  const clean = scoreProposal(
    { title: rejected.title, statement: rejected.statement },
    { evidence: decisions, confidence: 0.8, similarRejections: [], similarAccepted: [] },
  );

  assert.ok(penalised.rejectionPenalty > 0);
  assert.ok(penalised.total < clean.total);
});

test("contradicting evidence lowers a proposal's score", async () => {
  const db = testDb();
  const decisions = seedDecisions(db, 4);
  addRelation(db, {
    fromDecisionId: decisions[0]!.id,
    toDecisionId: decisions[1]!.id,
    relationType: "contradicts",
  });

  const analyzer = new FakeAnalyzer();
  analyzer.enqueue("distill-patterns", { proposals: [PRINCIPLE(decisions.map((d) => d.id))] });
  const report = await run(db, analyzer);

  assert.equal(report.created.length, 1);
  assert.ok((report.created[0]!.scoreBreakdown?.contradictionPenalty ?? 0) > 0);
});

test("a dry run writes nothing", async () => {
  const db = testDb();
  const decisions = seedDecisions(db, 4);
  const analyzer = new FakeAnalyzer();
  analyzer.enqueue("distill-patterns", { proposals: [PRINCIPLE(decisions.map((d) => d.id))] });

  const report = await distill({
    db,
    config: testConfig(),
    profile: seProfile(),
    analyzer,
    workspaceId: WS,
    dryRun: true,
  });

  assert.equal(report.created.length, 1);
  assert.equal(report.created[0]!.id, "(dry-run)");
  assert.equal(listProposals(db, { status: "any" }).length, 0);
  assert.equal(listDecisions(db, { unreviewedOnly: true }).length, 4);
});

test("the distillation prompt lists already accepted and rejected themes", async () => {
  const db = testDb();
  const decisions = seedDecisions(db, 4);
  const analyzer = new FakeAnalyzer();
  analyzer.enqueue("distill-patterns", { proposals: [PRINCIPLE(decisions.map((d) => d.id))] });
  const first = await run(db, analyzer);
  acceptProposal(db, first.created[0]!.id);

  analyzer.enqueue("distill-patterns", { proposals: [] });
  await run(db, analyzer);

  const prompt = analyzer.lastPrompt("distill-patterns") ?? "";
  assert.match(prompt, /Already accepted/);
  assert.match(prompt, /Check the existing stack before adding a managed service/);
});

/** Inserts a proposal directly, bypassing the analyzer. */
function require_insert(db: Db, evidenceDecisionIds: string[]) {
  const { insertProposal } = require_proposalsRepo();
  return insertProposal(db, {
    domain: "software-engineering",
    kind: "principle",
    title: "Check the existing stack before adding a managed service",
    statement:
      "Before introducing a new managed service, verify that the existing stack cannot adequately satisfy the requirement.",
    evidenceDecisionIds,
  });
}

function require_proposalsRepo() {
  return repoModule;
}

import * as repoModule from "../src/core/storage/proposals-repo.ts";
