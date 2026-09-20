import { test } from "node:test";
import assert from "node:assert/strict";

import { ingestSession } from "../src/core/ingestion/pipeline.ts";
import { shouldAnalyze } from "../src/core/ingestion/gate.ts";
import { listDecisions, getRelations, getDecision } from "../src/core/storage/decisions-repo.ts";
import { FakeAnalyzer } from "../src/core/analysis/fake.ts";
import { redact } from "../src/core/ingestion/redact.ts";
import {
  testDb,
  testConfig,
  seProfile,
  pmProfile,
  session,
  trivialSession,
  analyzerWith,
} from "./helpers.ts";

const D1_DECISION = {
  category: "dependency",
  subject: "Session store backend",
  decision: "Use D1 instead of PostgreSQL",
  reasoning: "The stack is already on Cloudflare and Postgres adds operational surface for no benefit.",
};

function run(analyzer: FakeAnalyzer, s = session(), config = testConfig(), profile = seProfile()) {
  const db = testDb();
  return {
    db,
    result: ingestSession({ db, config, profile, analyzer, session: s }),
  };
}

test("a meaningful decision is persisted", async () => {
  const db = testDb();
  const outcome = await ingestSession({
    db,
    config: testConfig(),
    profile: seProfile(),
    analyzer: analyzerWith([D1_DECISION]),
    session: session(),
  });

  assert.equal(outcome.inserted.length, 1);
  const stored = listDecisions(db, {});
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.subject, "Session store backend");
  assert.equal(stored[0]!.category, "dependency");
  assert.equal(stored[0]!.status, "active");
});

test("a trivial session produces no decision and costs no analyzer call", async () => {
  const db = testDb();
  const analyzer = new FakeAnalyzer();
  const config = testConfig();
  config.ingestion.minUserTurns = 3;

  const outcome = await ingestSession({
    db,
    config,
    profile: seProfile(),
    analyzer,
    session: trivialSession(),
  });

  assert.equal(outcome.analyzed, false);
  assert.match(outcome.skippedReason ?? "", /user turn/);
  assert.equal(analyzer.callCount("extract-decisions"), 0);
  assert.equal(listDecisions(db, {}).length, 0);
});

test("an analyzer returning nothing records nothing", async () => {
  const db = testDb();
  const outcome = await ingestSession({
    db,
    config: testConfig(),
    profile: seProfile(),
    analyzer: analyzerWith([]),
    session: session(),
  });
  assert.equal(outcome.analyzed, true);
  assert.equal(outcome.inserted.length, 0);
  assert.equal(listDecisions(db, {}).length, 0);
});

test("a duplicate is not inserted twice", async () => {
  const db = testDb();
  const config = testConfig();
  const profile = seProfile();
  const analyzer = analyzerWith([D1_DECISION], [D1_DECISION]);

  await ingestSession({ db, config, profile, analyzer, session: session({ sessionId: "s1" }) });
  const second = await ingestSession({
    db,
    config,
    profile,
    analyzer,
    session: session({ sessionId: "s2" }),
  });

  assert.equal(second.inserted.length, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(listDecisions(db, {}).length, 1);
});

test("a refinement enriches the existing record rather than duplicating it", async () => {
  const db = testDb();
  const config = testConfig();
  const profile = seProfile();

  const bare = { ...D1_DECISION, reasoning: undefined, alternatives: [{ alternative: "PostgreSQL" }] };
  const analyzer = analyzerWith([bare], [D1_DECISION]);

  await ingestSession({ db, config, profile, analyzer, session: session({ sessionId: "s1" }) });
  const second = await ingestSession({
    db,
    config,
    profile,
    analyzer,
    session: session({ sessionId: "s2" }),
  });

  assert.equal(second.refinements, 1);
  const stored = listDecisions(db, {});
  assert.equal(stored.length, 1);
  assert.ok(getDecision(db, stored[0]!.id)!.reasoning?.includes("Cloudflare"));
});

test("a superseding decision keeps the old one and links it", async () => {
  const db = testDb();
  const config = testConfig();
  const profile = seProfile();

  const later = {
    category: "dependency",
    subject: "Session store backend",
    decision: "Moved away from D1 to PostgreSQL for the session store",
    reasoning: "Row limits started to bite once multi-tenant data landed in the same table.",
  };

  const analyzer = analyzerWith([D1_DECISION], [later]);
  await ingestSession({ db, config, profile, analyzer, session: session({ sessionId: "s1" }) });
  const second = await ingestSession({
    db,
    config,
    profile,
    analyzer,
    session: session({ sessionId: "s2" }),
  });

  assert.equal(second.supersessions, 1);

  const all = listDecisions(db, { status: "any" });
  assert.equal(all.length, 2, "the superseded decision is kept, never deleted");

  const superseded = all.find((d) => d.status === "superseded");
  assert.ok(superseded, "old decision is marked superseded");

  const relations = getRelations(db, second.inserted[0]!.id);
  assert.ok(relations.some((r) => r.relationType === "supersedes" && r.toDecisionId === superseded!.id));
});

test("source environment metadata survives ingestion", async () => {
  const db = testDb();
  await ingestSession({
    db,
    config: testConfig(),
    profile: seProfile(),
    analyzer: analyzerWith([D1_DECISION]),
    session: session({ source: "cursor", sessionId: "conv-42" }),
  });

  const stored = listDecisions(db, {})[0]!;
  assert.equal(stored.source, "cursor");
  assert.equal(stored.sourceSessionId, "conv-42");
});

test("categories come from the active domain profile", async () => {
  const db = testDb();
  const outcome = await ingestSession({
    db,
    config: testConfig(),
    profile: seProfile(),
    analyzer: analyzerWith([
      { ...D1_DECISION, category: "prioritization" }, // a product-management category
    ]),
    session: session(),
  });

  // "prioritization" is not in the software-engineering profile, so it falls
  // back to that profile's "other" rather than being stored verbatim.
  assert.equal(outcome.inserted.length, 1);
  assert.equal(outcome.inserted[0]!.category, "other");
  assert.ok(seProfile().categories.includes(outcome.inserted[0]!.category));
});

test("a non-engineering category is stored with no schema change", async () => {
  const db = testDb();
  const outcome = await ingestSession({
    db,
    config: testConfig(),
    profile: pmProfile(),
    analyzer: analyzerWith([
      {
        category: "prioritization",
        subject: "Q3 roadmap ordering",
        decision: "Rank by retention impact rather than request count",
        reasoning: "Request volume comes from a few loud accounts and has not predicted churn.",
      },
    ]),
    session: session(),
  });

  assert.equal(outcome.inserted.length, 1);
  const stored = listDecisions(db, {})[0]!;
  assert.equal(stored.domain, "product-management");
  assert.equal(stored.category, "prioritization");
});

test("candidates below the confidence threshold are dropped", async () => {
  const db = testDb();
  const config = testConfig();
  config.ingestion.minConfidence = 0.8;

  const outcome = await ingestSession({
    db,
    config,
    profile: seProfile(),
    analyzer: analyzerWith([{ ...D1_DECISION, confidence: 0.5 }]),
    session: session(),
  });

  assert.equal(outcome.inserted.length, 0);
  assert.match(outcome.dropped.join(" "), /confidence/);
});

test("a decision with no reasoning and no alternatives is dropped", async () => {
  const db = testDb();
  const outcome = await ingestSession({
    db,
    config: testConfig(),
    profile: seProfile(),
    analyzer: analyzerWith([
      { category: "implementation", subject: "Naming", decision: "Call it sessionStore" },
    ]),
    session: session(),
  });
  assert.equal(outcome.inserted.length, 0);
  assert.match(outcome.dropped.join(" "), /no reasoning/);
});

test("a malformed analyzer response is dropped, not thrown", async () => {
  const db = testDb();
  const analyzer = new FakeAnalyzer();
  analyzer.enqueue("extract-decisions", { nonsense: true });

  const outcome = await ingestSession({
    db,
    config: testConfig(),
    profile: seProfile(),
    analyzer,
    session: session(),
  });

  assert.equal(outcome.inserted.length, 0);
  assert.equal(outcome.error, undefined);
  assert.match(outcome.dropped.join(" "), /decisions/);
});

test("an analyzer failure surfaces as an error and writes nothing", async () => {
  const db = testDb();
  const analyzer = new FakeAnalyzer();
  analyzer.enqueueFailure("extract-decisions", "model unavailable");

  const outcome = await ingestSession({
    db,
    config: testConfig(),
    profile: seProfile(),
    analyzer,
    session: session(),
  });

  assert.equal(outcome.error, "model unavailable");
  assert.equal(listDecisions(db, {}).length, 0);
});

test("the per-session cap is enforced", async () => {
  const db = testDb();
  const config = testConfig();
  config.ingestion.maxDecisionsPerSession = 2;

  // Deliberately unrelated to one another: the dedupe stage would otherwise
  // collapse them and we would be testing the wrong thing.
  const topics = [
    ["Queue backpressure", "Drop oldest messages when the buffer fills", "Latency matters more here than completeness"],
    ["Image thumbnails", "Generate lazily on first request", "Most uploads are never viewed at all"],
    ["Feature flag storage", "Keep flags in the deploy config", "A runtime service would add a failure mode"],
    ["Retry policy", "Give up after three attempts", "Longer retries hid a genuine upstream outage"],
    ["Log retention", "Keep seven days of debug logs", "Storage cost outweighs the rare old investigation"],
  ];
  const many = topics.map(([subject, decision, reasoning]) => ({
    category: "tradeoff",
    subject: subject!,
    decision: decision!,
    reasoning: reasoning!,
  }));

  const outcome = await ingestSession({
    db,
    config,
    profile: seProfile(),
    analyzer: analyzerWith(many),
    session: session(),
  });

  assert.equal(outcome.inserted.length, 2);
  assert.match(outcome.dropped.join(" "), /cap/);
});

test("the gate declines when there is no new content since the last cursor", () => {
  const config = testConfig();
  const verdict = shouldAnalyze(session({ cursor: 10 }), config.ingestion, 10);
  assert.equal(verdict.proceed, false);
  assert.match(verdict.reason, /no new content/);
});

test("secrets are redacted before text leaves the process", () => {
  const { text, hits } = redact(
    "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 and key sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa",
    testConfig().privacy,
  );
  assert.ok(!text.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.ok(!text.includes("sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa"));
  assert.ok(hits.length >= 1);
});

test("reasoning is never persisted, only forwarded to the analyzer", async () => {
  const db = testDb();
  const analyzer = analyzerWith([D1_DECISION]);
  await ingestSession({
    db,
    config: testConfig(),
    profile: seProfile(),
    analyzer,
    session: session({
      messages: [
        { role: "user", text: "Pick a database for the session store, D1 or Postgres." },
        { role: "assistant", text: "Going with D1.", reasoning: "secret-internal-deliberation" },
      ],
    }),
  });

  assert.match(analyzer.lastPrompt("extract-decisions") ?? "", /secret-internal-deliberation/);

  const dump = JSON.stringify(listDecisions(db, {}));
  assert.ok(!dump.includes("secret-internal-deliberation"));
});

test("the extraction prompt carries the active profile's categories", async () => {
  const db = testDb();
  const analyzer = analyzerWith([]);
  await ingestSession({
    db,
    config: testConfig(),
    profile: pmProfile(),
    analyzer,
    session: session(),
  });

  const prompt = analyzer.lastPrompt("extract-decisions") ?? "";
  assert.match(prompt, /product-management/);
  assert.match(prompt, /- prioritization/);
  assert.ok(!prompt.includes("- architecture"), "engineering categories must not leak in");
});

void run;
